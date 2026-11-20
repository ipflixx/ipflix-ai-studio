import { useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, Shield, Tv } from 'lucide-react';
import type {
  EpisodeItem,
  LiveChannel,
  MovieItem,
  NavSection,
  PlaylistCatalog,
  PlaylistSource,
  SeriesItem,
  WatchProgress,
} from '../types/iptv';
import { HeroShowcase } from './HeroShowcase';
import { HomeSmartSearch } from './HomeSmartSearch';
import { MediaCard } from './MediaArtwork';
import { formatDuration } from '../services/iptvApi';
import { useI18n } from '../i18n/I18nContext';
import { cleanDisplaySubtitle, cleanMediaTitle } from '../utils/titleCleaner';

interface HomeViewProps {
  activePlaylist: PlaylistSource | null;
  catalog: PlaylistCatalog | null;
  profileId?: string;
  isKidsProfile?: boolean;
  favorites: Set<string>;
  watchProgress: Record<string, WatchProgress>;
  recentChannelIds: string[];
  recentSearches: string[];
  onUpdateRecentSearches: (next: string[]) => void;
  onPlayChannel: (channel: LiveChannel) => void;
  onPlayMovie: (movie: MovieItem) => void;
  onOpenMovieDetail: (movie: MovieItem) => void;
  onOpenSeriesDetail: (series: SeriesItem) => void;
  onPlaySeriesDirect: (series: SeriesItem) => void;
  onPlayEpisode?: (series: SeriesItem, episode: EpisodeItem) => void;
  onSelectCategory?: (section: 'live' | 'movies' | 'series', category: string) => void;
  onOpenFullSearch?: (query: string) => void;
  onResumeProgress: (entry: WatchProgress) => void;
  onToggleFavorite: (id: string) => void;
  onOpenAddPlaylist: () => void;
  onNavigate: (section: NavSection) => void;
}

interface ContentRailProps {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  scrollLeftLabel: string;
  scrollRightLabel: string;
  children: React.ReactNode;
}

function ContentRail({
  title,
  actionLabel,
  onAction,
  scrollLeftLabel,
  scrollRightLabel,
  children,
}: ContentRailProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const scrollByAmount = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(el.clientWidth * 0.78, 320),
      behavior: 'smooth',
    });
  };

  return (
    <section className="space-y-3 sm:space-y-3.5">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-8 lg:px-12 xl:px-14">
        <h2 className="font-display text-[17px] sm:text-[21px] lg:text-[22px] font-bold text-white tracking-tight truncate">
          {title}
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className="min-h-[36px] px-1 text-xs font-semibold text-[#9CA3B2] hover:text-white transition-colors mr-0.5 whitespace-nowrap"
            >
              {actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            aria-label={scrollLeftLabel}
            className="hidden sm:flex w-8 h-8 rounded-full bg-[#12141B] border border-white/10 hover:border-white/25 text-white/80 hover:text-white items-center justify-center transition-colors active:scale-95"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            aria-label={scrollRightLabel}
            className="hidden sm:flex w-8 h-8 rounded-full bg-[#12141B] border border-white/10 hover:border-white/25 text-white/80 hover:text-white items-center justify-center transition-colors active:scale-95"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="flex flex-nowrap gap-3 sm:gap-4 lg:gap-5 overflow-x-auto no-scrollbar snap-x snap-mandatory px-4 sm:px-8 lg:px-12 xl:px-14 py-1.5 sm:py-2 scroll-smooth"
      >
        {children}
      </div>
    </section>
  );
}

function profileHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function HomeView({
  activePlaylist,
  catalog,
  profileId = 'default',
  isKidsProfile = false,
  favorites,
  watchProgress,
  recentChannelIds,
  recentSearches,
  onUpdateRecentSearches,
  onPlayChannel,
  onPlayMovie,
  onOpenMovieDetail,
  onOpenSeriesDetail,
  onPlaySeriesDirect,
  onPlayEpisode,
  onSelectCategory,
  onOpenFullSearch,
  onResumeProgress,
  onToggleFavorite,
  onOpenAddPlaylist,
  onNavigate,
}: HomeViewProps) {
  const { t } = useI18n();
  const channels = catalog?.channels || [];
  const movies = catalog?.movies || [];
  const series = catalog?.series || [];

  const moviesById = useMemo(() => new Map(movies.map((m) => [m.id, m])), [movies]);
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);

  // 1. Kaldığın Yerden Devam Et — deduplicate episodes per series so individual episodes never clutter Home
  const continueWatching = useMemo(() => {
    const sorted = Object.values(watchProgress)
      .filter(
        (p) =>
          p.type !== 'live' &&
          !p.completed &&
          p.position >= 2 &&
          (!p.duration || p.position / p.duration < 0.92)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const deduped: WatchProgress[] = [];
    const seenSeries = new Set<string>();
    const seenMovies = new Set<string>();

    for (const entry of sorted) {
      if (entry.type === 'episode') {
        const key = entry.seriesId || entry.title;
        if (seenSeries.has(key)) continue;
        // Only show if series still exists in active catalog
        if (entry.seriesId && !seriesById.has(entry.seriesId)) continue;
        seenSeries.add(key);
        deduped.push(entry);
      } else {
        if (seenMovies.has(entry.itemId)) continue;
        if (!moviesById.has(entry.itemId)) continue;
        seenMovies.add(entry.itemId);
        deduped.push(entry);
      }
      if (deduped.length >= 14) break;
    }

    return deduped;
  }, [watchProgress, moviesById, seriesById]);

  // 1b. Son İzlenenler (All recently watched movies & series — includes completed titles)
  const recentlyWatched = useMemo(() => {
    const sorted = Object.values(watchProgress)
      .filter((p) => p.type !== 'live' && (p.position >= 1.5 || p.completed === true))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const items: Array<
      | { kind: 'movie'; item: MovieItem; entry: WatchProgress }
      | { kind: 'series'; item: SeriesItem; entry: WatchProgress }
    > = [];
    const seenSeries = new Set<string>();
    const seenMovies = new Set<string>();

    for (const entry of sorted) {
      if (entry.type === 'episode' && entry.seriesId) {
        if (seenSeries.has(entry.seriesId)) continue;
        const matchedSeries = seriesById.get(entry.seriesId);
        if (!matchedSeries) continue;
        seenSeries.add(entry.seriesId);
        items.push({ kind: 'series', item: matchedSeries, entry });
      } else if (entry.type === 'movie') {
        if (seenMovies.has(entry.itemId)) continue;
        const matchedMovie = moviesById.get(entry.itemId);
        if (!matchedMovie) continue;
        seenMovies.add(entry.itemId);
        items.push({ kind: 'movie', item: matchedMovie, entry });
      }
      if (items.length >= 18) break;
    }

    return items;
  }, [watchProgress, moviesById, seriesById]);

  // 2. Popüler Filmler (strictly movies)
  const popularMovies = useMemo(() => {
    return [...movies]
      .sort((a, b) => {
        const scoreA = (a.rating || 0) * 10 + (a.poster ? 5 : 0);
        const scoreB = (b.rating || 0) * 10 + (b.poster ? 5 : 0);
        return scoreB - scoreA;
      })
      .slice(0, 20);
  }, [movies]);

  // 3. Popüler Diziler (strictly series — clicking opens Series Detail modal)
  const popularSeries = useMemo(() => {
    return [...series]
      .sort((a, b) => {
        const scoreA = (a.rating || 0) * 10 + (a.poster ? 5 : 0);
        const scoreB = (b.rating || 0) * 10 + (b.poster ? 5 : 0);
        return scoreB - scoreA;
      })
      .slice(0, 20);
  }, [series]);

  // 4. Son Eklenen Filmler (strictly movies, ordered newest first)
  const recentMovies = useMemo(() => {
    const withIndex = movies.map((item, idx) => ({ item, idx }));
    withIndex.sort((a, b) => {
      const diff = (b.item.addedAt || 0) - (a.item.addedAt || 0);
      if (diff !== 0) return diff;
      const yearDiff = Number(b.item.year || 0) - Number(a.item.year || 0);
      if (yearDiff !== 0) return yearDiff;
      return b.idx - a.idx;
    });
    return withIndex.map((x) => x.item).slice(0, 20);
  }, [movies]);

  // 5. Son Eklenen Diziler (strictly series, ordered newest first)
  const recentSeries = useMemo(() => {
    const withIndex = series.map((item, idx) => ({ item, idx }));
    withIndex.sort((a, b) => {
      const diff = (b.item.addedAt || 0) - (a.item.addedAt || 0);
      if (diff !== 0) return diff;
      const yearDiff = Number(b.item.year || 0) - Number(a.item.year || 0);
      if (yearDiff !== 0) return yearDiff;
      return b.idx - a.idx;
    });
    return withIndex.map((x) => x.item).slice(0, 20);
  }, [series]);

  // 6. Favorilerim (active profile's favorited movies, series & channels)
  const myFavorites = useMemo(() => {
    const items: Array<
      | { kind: 'movie'; item: MovieItem }
      | { kind: 'series'; item: SeriesItem }
      | { kind: 'channel'; item: LiveChannel }
    > = [];

    for (const m of movies) {
      if (favorites.has(m.id)) items.push({ kind: 'movie', item: m });
    }
    for (const s of series) {
      if (favorites.has(s.id)) items.push({ kind: 'series', item: s });
    }
    for (const ch of channels) {
      if (favorites.has(ch.id)) items.push({ kind: 'channel', item: ch });
    }
    return items.slice(0, 20);
  }, [movies, series, channels, favorites]);

  // 7. Sana Özel — real profile-personalized recommendations from provider catalog
  const forYouItems = useMemo(() => {
    const categoryWeights = new Map<string, number>();
    const watchedIds = new Set<string>();

    // Learn taste profile from this profile's favorites & watch history
    for (const favId of favorites) {
      const m = moviesById.get(favId);
      if (m) {
        categoryWeights.set(m.category.toLowerCase(), (categoryWeights.get(m.category.toLowerCase()) || 0) + 4);
      }
      const s = seriesById.get(favId);
      if (s) {
        categoryWeights.set(s.category.toLowerCase(), (categoryWeights.get(s.category.toLowerCase()) || 0) + 4);
      }
    }

    for (const prog of Object.values(watchProgress)) {
      watchedIds.add(prog.itemId);
      if (prog.seriesId) watchedIds.add(prog.seriesId);
      const m = moviesById.get(prog.itemId);
      if (m) {
        categoryWeights.set(m.category.toLowerCase(), (categoryWeights.get(m.category.toLowerCase()) || 0) + 3);
      }
      const s = prog.seriesId ? seriesById.get(prog.seriesId) : undefined;
      if (s) {
        categoryWeights.set(s.category.toLowerCase(), (categoryWeights.get(s.category.toLowerCase()) || 0) + 3);
      }
    }

    const seed = profileHash(profileId);
    const scoreItem = (id: string, category: string, rating?: number, poster?: string) => {
      let score = categoryWeights.get(category.toLowerCase()) || 0;
      if (rating && rating > 0) score += rating * 0.9;
      if (poster) score += 2.5;
      if (watchedIds.has(id)) score -= 6;
      // Gentle deterministic tie-breaker unique to each profile
      score += ((profileHash(id) ^ seed) % 100) / 100;
      return score;
    };

    const rankedM = [...movies]
      .filter((m) => !favorites.has(m.id))
      .sort((a, b) => scoreItem(b.id, b.category, b.rating, b.poster) - scoreItem(a.id, a.category, a.rating, a.poster))
      .slice(0, 14);

    const rankedS = [...series]
      .filter((s) => !favorites.has(s.id))
      .sort((a, b) => scoreItem(b.id, b.category, b.rating, b.poster) - scoreItem(a.id, a.category, a.rating, a.poster))
      .slice(0, 10);

    const interleaved: Array<{ kind: 'movie'; item: MovieItem } | { kind: 'series'; item: SeriesItem }> = [];
    const maxLen = Math.max(rankedM.length, rankedS.length);
    for (let i = 0; i < maxLen && interleaved.length < 18; i++) {
      if (rankedM[i]) interleaved.push({ kind: 'movie', item: rankedM[i] });
      if (rankedS[i]) interleaved.push({ kind: 'series', item: rankedS[i] });
    }

    return interleaved;
  }, [movies, series, favorites, watchProgress, moviesById, seriesById, profileId]);

  const recentChannels = useMemo(() => {
    const byId = new Map(channels.map((c) => [c.id, c]));
    return recentChannelIds
      .map((id) => byId.get(id))
      .filter((c): c is LiveChannel => Boolean(c))
      .slice(0, 14);
  }, [channels, recentChannelIds]);

  return (
    <div className="pb-12 sm:pb-16 lg:pb-20 space-y-8 sm:space-y-10 lg:space-y-12">
      {/* ALWAYS-VISIBLE SMART SEARCH BAR + FULL-BLEED CINEMATIC HERO */}
      <div>
        <HomeSmartSearch
          catalog={catalog}
          profileId={profileId}
          recentSearches={recentSearches}
          onUpdateRecentSearches={onUpdateRecentSearches}
          onOpenMovieDetail={onOpenMovieDetail}
          onOpenSeriesDetail={onOpenSeriesDetail}
          onPlayEpisode={(s, ep) => {
            if (onPlayEpisode) onPlayEpisode(s, ep);
            else onOpenSeriesDetail(s);
          }}
          onPlayChannel={onPlayChannel}
          onSelectCategory={(sec, cat) => {
            if (onSelectCategory) onSelectCategory(sec, cat);
            else onNavigate(sec);
          }}
          onOpenFullSearch={(q) => {
            if (onOpenFullSearch) onOpenFullSearch(q);
            else onNavigate('search');
          }}
          onNavigate={onNavigate}
        />

        <HeroShowcase
          movies={movies}
          series={series}
          channels={channels}
          favorites={favorites}
          profileSeed={profileId}
          onPlayMovie={onPlayMovie}
          onPlaySeriesDirect={onPlaySeriesDirect}
          onPlayChannel={onPlayChannel}
          onOpenMovieDetail={onOpenMovieDetail}
          onOpenSeriesDetail={onOpenSeriesDetail}
          onToggleFavorite={onToggleFavorite}
          onOpenAddPlaylist={onOpenAddPlaylist}
        />
      </div>

      {/* KIDS PROFILE NOTICE STRIP */}
      {isKidsProfile && (
        <div className="px-4 sm:px-8 lg:px-12 xl:px-14">
          <div className="rounded-xl bg-[#12141B] border border-amber-500/25 px-4 sm:px-5 py-3.5 flex items-center gap-3 text-xs text-amber-200">
            <Shield className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{t('home.kidsBanner')}</span>
          </div>
        </div>
      )}

      {/* SUBTLE SOURCE STRIP WHEN ON DEMO */}
      {activePlaylist?.type === 'demo' && (
        <div className="px-4 sm:px-8 lg:px-12 xl:px-14">
          <div className="rounded-xl bg-[#12141B] border border-white/[0.08] px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
            <div className="space-y-0.5">
              <h2 className="text-sm font-bold text-white">{t('home.demoTitle')}</h2>
              <p className="text-xs text-[#9CA3B2] leading-relaxed">{t('home.demoDesc')}</p>
            </div>
            <button
              type="button"
              data-focusable="true"
              onClick={onOpenAddPlaylist}
              className="min-h-[44px] sm:min-h-[40px] px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] active:scale-[0.98] text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-all whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              {t('nav.connectIptv')}
            </button>
          </div>
        </div>
      )}

      {/* 1. KALDIĞIN YERDEN DEVAM ET */}
      {continueWatching.length > 0 && (
        <ContentRail
          title={t('home.continueWatching')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {continueWatching.map((entry) => {
            const pct = entry.duration > 0 ? (entry.position / entry.duration) * 100 : 25;
            const remaining =
              entry.duration > entry.position ? formatDuration(entry.duration - entry.position) : '';
            const matchedMovie = entry.type === 'movie' ? moviesById.get(entry.itemId) : undefined;
            const matchedSeries =
              entry.type === 'episode' && entry.seriesId ? seriesById.get(entry.seriesId) : undefined;

            const displaySubtitle = entry.subtitle
              ? entry.type === 'episode'
                ? cleanDisplaySubtitle(entry.subtitle)
                : entry.subtitle
              : '';

            return (
              <div key={entry.itemId} className="w-[248px] sm:w-[288px] lg:w-[316px] shrink-0 snap-start">
                <MediaCard
                  title={cleanMediaTitle(entry.title)}
                  subtitle={
                    remaining
                      ? `${displaySubtitle ? `${displaySubtitle} · ` : ''}${remaining}`
                      : formatDuration(entry.position)
                  }
                  poster={entry.backdrop || entry.poster}
                  aspect="landscape"
                  kind={entry.type === 'episode' ? 'series' : 'movie'}
                  progressPct={pct}
                  onPlay={() => onResumeProgress(entry)}
                  onDetails={
                    matchedMovie
                      ? () => onOpenMovieDetail(matchedMovie)
                      : matchedSeries
                      ? () => onOpenSeriesDetail(matchedSeries)
                      : undefined
                  }
                />
              </div>
            );
          })}
        </ContentRail>
      )}

      {/* 1b. SON İZLENENLER */}
      {recentlyWatched.length > 0 && (
        <ContentRail
          title={t('home.recentlyWatched')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {recentlyWatched.map((rec) => {
            if (rec.kind === 'movie') {
              const m = rec.item;
              return (
                <div
                  key={`recent_watched_m_${m.id}`}
                  className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start"
                >
                  <MediaCard
                    title={cleanMediaTitle(m.name)}
                    year={m.year}
                    category={m.genre || m.category}
                    rating={m.rating}
                    poster={m.poster}
                    kind="movie"
                    isFavorite={favorites.has(m.id)}
                    onPlay={() => onResumeProgress(rec.entry)}
                    onDetails={() => onOpenMovieDetail(m)}
                    onToggleFavorite={() => onToggleFavorite(m.id)}
                  />
                </div>
              );
            }
            const s = rec.item;
            return (
              <div
                key={`recent_watched_s_${s.id}`}
                className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start"
              >
                <MediaCard
                  title={cleanMediaTitle(s.name)}
                  year={s.year}
                  category={s.genre || s.category}
                  rating={s.rating}
                  poster={s.poster}
                  kind="series"
                  isFavorite={favorites.has(s.id)}
                  onPlay={() => onResumeProgress(rec.entry)}
                  onDetails={() => onOpenSeriesDetail(s)}
                  onToggleFavorite={() => onToggleFavorite(s.id)}
                />
              </div>
            );
          })}
        </ContentRail>
      )}

      {/* 2. POPÜLER FİLMLER */}
      {popularMovies.length > 0 && (
        <ContentRail
          title={t('home.popularMovies')}
          actionLabel={`${t('common.all')} (${movies.length.toLocaleString()})`}
          onAction={() => onNavigate('movies')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {popularMovies.map((m) => (
            <div key={m.id} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(m.name)}
                year={m.year}
                category={m.genre || m.category}
                rating={m.rating}
                poster={m.poster}
                kind="movie"
                isFavorite={favorites.has(m.id)}
                onPlay={() => onPlayMovie(m)}
                onDetails={() => onOpenMovieDetail(m)}
                onToggleFavorite={() => onToggleFavorite(m.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* 3. POPÜLER DİZİLER */}
      {popularSeries.length > 0 && (
        <ContentRail
          title={t('home.popularSeries')}
          actionLabel={`${t('common.all')} (${series.length.toLocaleString()})`}
          onAction={() => onNavigate('series')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {popularSeries.map((s) => (
            <div key={s.id} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(s.name)}
                year={s.year}
                category={s.genre || s.category}
                rating={s.rating}
                poster={s.poster}
                kind="series"
                isFavorite={favorites.has(s.id)}
                onPlay={() => onPlaySeriesDirect(s)}
                onDetails={() => onOpenSeriesDetail(s)}
                onToggleFavorite={() => onToggleFavorite(s.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* 4. SON EKLENEN FİLMLER */}
      {recentMovies.length > 0 && (
        <ContentRail
          title={t('home.recentMovies')}
          actionLabel={t('common.all')}
          onAction={() => onNavigate('movies')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {recentMovies.map((m) => (
            <div key={`recent_movie_${m.id}`} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(m.name)}
                year={m.year}
                category={m.genre || m.category}
                rating={m.rating}
                poster={m.poster}
                kind="movie"
                isFavorite={favorites.has(m.id)}
                onPlay={() => onPlayMovie(m)}
                onDetails={() => onOpenMovieDetail(m)}
                onToggleFavorite={() => onToggleFavorite(m.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* 5. SON EKLENEN DİZİLER */}
      {recentSeries.length > 0 && (
        <ContentRail
          title={t('home.recentSeries')}
          actionLabel={t('common.all')}
          onAction={() => onNavigate('series')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {recentSeries.map((s) => (
            <div key={`recent_series_${s.id}`} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(s.name)}
                year={s.year}
                category={s.genre || s.category}
                rating={s.rating}
                poster={s.poster}
                kind="series"
                isFavorite={favorites.has(s.id)}
                onPlay={() => onPlaySeriesDirect(s)}
                onDetails={() => onOpenSeriesDetail(s)}
                onToggleFavorite={() => onToggleFavorite(s.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* 6. FAVORİLERİM */}
      {myFavorites.length > 0 && (
        <ContentRail
          title={t('home.myFavorites')}
          actionLabel={t('common.all')}
          onAction={() => onNavigate('favorites')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {myFavorites.map((entry) => {
            if (entry.kind === 'channel') {
              return (
                <div key={`fav_ch_${entry.item.id}`} className="w-[220px] sm:w-[256px] lg:w-[276px] shrink-0 snap-start">
                  <MediaCard
                    title={cleanMediaTitle(entry.item.name)}
                    subtitle={`${entry.item.num} · ${entry.item.category}`}
                    poster={entry.item.logo}
                    aspect="landscape"
                    kind="channel"
                    isFavorite
                    onPlay={() => onPlayChannel(entry.item)}
                    onToggleFavorite={() => onToggleFavorite(entry.item.id)}
                  />
                </div>
              );
            }
            return (
              <div key={`fav_${entry.kind}_${entry.item.id}`} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
                <MediaCard
                  title={cleanMediaTitle(entry.item.name)}
                  year={entry.item.year}
                  category={entry.item.genre || entry.item.category}
                  rating={entry.item.rating}
                  poster={entry.item.poster}
                  kind={entry.kind}
                  isFavorite
                  onPlay={() =>
                    entry.kind === 'movie'
                      ? onPlayMovie(entry.item)
                      : onPlaySeriesDirect(entry.item)
                  }
                  onDetails={() =>
                    entry.kind === 'movie'
                      ? onOpenMovieDetail(entry.item)
                      : onOpenSeriesDetail(entry.item)
                  }
                  onToggleFavorite={() => onToggleFavorite(entry.item.id)}
                />
              </div>
            );
          })}
        </ContentRail>
      )}

      {/* 7. SANA ÖZEL */}
      {forYouItems.length > 0 && (
        <ContentRail
          title={t('home.forYou')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {forYouItems.map((entry) => (
            <div key={`foryou_${entry.kind}_${entry.item.id}`} className="w-[138px] sm:w-[168px] lg:w-[186px] xl:w-[196px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(entry.item.name)}
                year={entry.item.year}
                category={entry.item.genre || entry.item.category}
                rating={entry.item.rating}
                poster={entry.item.poster}
                kind={entry.kind}
                isFavorite={favorites.has(entry.item.id)}
                onPlay={() =>
                  entry.kind === 'movie'
                    ? onPlayMovie(entry.item)
                    : onPlaySeriesDirect(entry.item)
                }
                onDetails={() =>
                  entry.kind === 'movie'
                    ? onOpenMovieDetail(entry.item)
                    : onOpenSeriesDetail(entry.item)
                }
                onToggleFavorite={() => onToggleFavorite(entry.item.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* RECENTLY WATCHED LIVE CHANNELS (only shown when profile has live history) */}
      {recentChannels.length > 0 && (
        <ContentRail
          title={t('home.recentChannels')}
          actionLabel={t('nav.live')}
          onAction={() => onNavigate('live')}
          scrollLeftLabel={t('home.scrollLeft')}
          scrollRightLabel={t('home.scrollRight')}
        >
          {recentChannels.map((ch) => (
            <div key={`recent_ch_${ch.id}`} className="w-[220px] sm:w-[256px] lg:w-[276px] shrink-0 snap-start">
              <MediaCard
                title={cleanMediaTitle(ch.name)}
                subtitle={`${ch.num} · ${ch.category}`}
                poster={ch.logo}
                aspect="landscape"
                kind="channel"
                isFavorite={favorites.has(ch.id)}
                onPlay={() => onPlayChannel(ch)}
                onToggleFavorite={() => onToggleFavorite(ch.id)}
              />
            </div>
          ))}
        </ContentRail>
      )}

      {/* EMPTY FALLBACK */}
      {channels.length === 0 && movies.length === 0 && series.length === 0 && (
        <div className="px-4 sm:px-8 lg:px-12 xl:px-14">
          <div className="rounded-2xl bg-[#12141B] border border-white/10 p-12 text-center flex flex-col items-center gap-4">
            <Tv className="w-10 h-10 text-[#666E80]" />
            <h2 className="text-xl font-bold text-white">{t('home.emptyTitle')}</h2>
            <p className="text-sm text-[#9CA3B2] max-w-md">{t('home.emptyDesc')}</p>
            <button
              type="button"
              data-focusable="true"
              onClick={onOpenAddPlaylist}
              className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-sm font-semibold transition-colors"
            >
              {t('home.connectSource')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
