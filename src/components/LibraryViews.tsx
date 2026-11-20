import { useEffect, useMemo, useState } from 'react';
import {
  Clapperboard,
  Film,
  FolderKanban,
  Heart,
  Play,
  Search,
  Tv,
  X,
} from 'lucide-react';
import type {
  EpisodeItem,
  LiveChannel,
  MovieItem,
  NavSection,
  PlaylistCatalog,
  SeriesItem,
  WatchProgress,
} from '../types/iptv';
import { MediaCard } from './MediaArtwork';
import { formatShortTime } from '../services/iptvApi';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';
import { normalizeTurkishSearch, searchCatalogSmart } from '../utils/smartSearch';

const GRID_PAGE_SIZE = 48;

interface MoviesViewProps {
  movies: MovieItem[];
  favorites: Set<string>;
  watchProgress: Record<string, WatchProgress>;
  initialCategory?: string;
  onPlayMovie: (movie: MovieItem) => void;
  onOpenMovieDetail: (movie: MovieItem) => void;
  onToggleFavorite: (id: string) => void;
  onOpenAddPlaylist: () => void;
}

export function MoviesView({
  movies,
  favorites,
  watchProgress,
  initialCategory,
  onPlayMovie,
  onOpenMovieDetail,
  onToggleFavorite,
  onOpenAddPlaylist,
}: MoviesViewProps) {
  const { t } = useI18n();
  const [selectedCategory, setSelectedCategory] = useState(initialCategory || 'All');
  const [sortBy, setSortBy] = useState<'recent' | 'rating' | 'title' | 'year'>('recent');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(GRID_PAGE_SIZE);

  useEffect(() => {
    if (initialCategory) setSelectedCategory(initialCategory);
  }, [initialCategory]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of movies) {
      counts.set(m.category, (counts.get(m.category) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [movies]);

  const filtered = useMemo(() => {
    const q = normalizeTurkishSearch(query);
    const list = movies.filter((m) => {
      if (favoritesOnly && !favorites.has(m.id)) return false;
      if (selectedCategory !== 'All' && m.category !== selectedCategory) return false;
      if (q) {
        const hay = normalizeTurkishSearch(`${cleanMediaTitle(m.name)} ${m.genre || ''}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
      if (sortBy === 'title') return cleanMediaTitle(a.name).localeCompare(cleanMediaTitle(b.name));
      if (sortBy === 'year') return Number(b.year || 0) - Number(a.year || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }, [movies, favorites, favoritesOnly, selectedCategory, query, sortBy]);

  useEffect(() => {
    setVisibleCount(GRID_PAGE_SIZE);
  }, [selectedCategory, sortBy, favoritesOnly, query]);

  if (movies.length === 0) {
    return (
      <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-16">
        <div className="max-w-xl mx-auto rounded-2xl bg-[#12141B] border border-white/10 p-10 text-center space-y-4">
          <Film className="w-10 h-10 text-[#666E80] mx-auto" />
          <h2 className="text-xl font-bold text-white">{t('movies.empty')}</h2>
          <p className="text-sm text-[#9CA3B2]">{t('home.emptyDesc')}</p>
          <button
            type="button"
            onClick={onOpenAddPlaylist}
            className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-sm font-semibold transition-colors"
          >
            {t('nav.addSource')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-5 sm:space-y-6 pb-12 sm:pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3.5 sm:gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('movies.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5 tabular-nums">
            {t('movies.count', { count: filtered.length.toLocaleString() })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#666E80] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('movies.searchPlaceholder')}
              className="w-full min-h-[44px] sm:min-h-[38px] pl-9 pr-3 py-2 rounded-lg bg-[#12141B] border border-white/10 focus:border-[#E50914] focus:outline-none text-base sm:text-xs text-white placeholder:text-[#666E80]"
            />
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'recent' | 'rating' | 'title' | 'year')}
            aria-label={t('movies.title')}
            className="flex-1 sm:flex-none min-h-[44px] sm:min-h-[38px] px-3 py-2 rounded-lg bg-[#12141B] border border-white/10 text-sm sm:text-xs text-white"
          >
            <option value="recent">{t('movies.sortNewest')}</option>
            <option value="rating">{t('movies.sortRating')}</option>
            <option value="year">{t('movies.sortYear')}</option>
            <option value="title">{t('movies.sortAZ')}</option>
          </select>

          <button
            type="button"
            onClick={() => setFavoritesOnly((f) => !f)}
            className={`min-h-[44px] sm:min-h-[38px] px-3.5 py-2 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
              favoritesOnly
                ? 'bg-[#E50914]/15 border-[#E50914] text-white'
                : 'bg-[#12141B] border-white/10 text-[#9CA3B2] hover:text-white'
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${favoritesOnly ? 'fill-[#E50914] text-[#E50914]' : ''}`} />
            {t('nav.favorites')}
          </button>
        </div>
      </div>

      {/* Category Filter Strip */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        <button
          type="button"
          onClick={() => setSelectedCategory('All')}
          className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            selectedCategory === 'All'
              ? 'bg-[#E50914] text-white'
              : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
          }`}
        >
          {t('live.allCategories')}
        </button>
        {categories.slice(0, 30).map(([cat, count]) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
              selectedCategory === cat
                ? 'bg-[#E50914] text-white'
                : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
            }`}
          >
            {cat} ({count})
          </button>
        ))}
      </div>

      {/* Poster Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 sm:gap-4 lg:gap-5">
        {filtered.slice(0, visibleCount).map((m) => {
          const p = watchProgress[m.id];
          const pct = p && p.duration > 0 ? (p.position / p.duration) * 100 : undefined;
          return (
            <MediaCard
              key={m.id}
              title={cleanMediaTitle(m.name)}
              year={m.year}
              category={m.category}
              rating={m.rating}
              poster={m.poster}
              progressPct={pct}
              isFavorite={favorites.has(m.id)}
              kind="movie"
              onPlay={() => onPlayMovie(m)}
              onDetails={() => onOpenMovieDetail(m)}
              onToggleFavorite={() => onToggleFavorite(m.id)}
            />
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="py-16 text-center text-sm text-[#9CA3B2]">
          {t('movies.empty')}
        </div>
      )}

      {visibleCount < filtered.length && (
        <div className="pt-4 text-center">
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + GRID_PAGE_SIZE)}
            className="px-6 py-2.5 rounded-lg bg-[#12141B] border border-white/15 hover:border-white/30 text-sm font-semibold text-white transition-colors"
          >
            {t('movies.loadMore', { remaining: (filtered.length - visibleCount).toLocaleString() })}
          </button>
        </div>
      )}
    </div>
  );
}

interface SeriesViewProps {
  series: SeriesItem[];
  favorites: Set<string>;
  initialCategory?: string;
  onPlaySeriesDirect: (series: SeriesItem) => void;
  onOpenSeriesDetail: (series: SeriesItem) => void;
  onToggleFavorite: (id: string) => void;
  onOpenAddPlaylist: () => void;
}

export function SeriesView({
  series,
  favorites,
  initialCategory,
  onPlaySeriesDirect,
  onOpenSeriesDetail,
  onToggleFavorite,
  onOpenAddPlaylist,
}: SeriesViewProps) {
  const { t } = useI18n();
  const [selectedCategory, setSelectedCategory] = useState(initialCategory || 'All');
  const [sortBy, setSortBy] = useState<'recent' | 'rating' | 'title'>('recent');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(GRID_PAGE_SIZE);

  useEffect(() => {
    if (initialCategory) setSelectedCategory(initialCategory);
  }, [initialCategory]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of series) {
      counts.set(s.category, (counts.get(s.category) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [series]);

  const filtered = useMemo(() => {
    const q = normalizeTurkishSearch(query);
    const list = series.filter((s) => {
      if (favoritesOnly && !favorites.has(s.id)) return false;
      if (selectedCategory !== 'All' && s.category !== selectedCategory) return false;
      if (q) {
        const hay = normalizeTurkishSearch(`${cleanMediaTitle(s.name)} ${s.genre || ''}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
      if (sortBy === 'title') return cleanMediaTitle(a.name).localeCompare(cleanMediaTitle(b.name));
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }, [series, favorites, favoritesOnly, selectedCategory, query, sortBy]);

  if (series.length === 0) {
    return (
      <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-16">
        <div className="max-w-xl mx-auto rounded-2xl bg-[#12141B] border border-white/10 p-10 text-center space-y-4">
          <Clapperboard className="w-10 h-10 text-[#666E80] mx-auto" />
          <h2 className="text-xl font-bold text-white">{t('series.empty')}</h2>
          <p className="text-sm text-[#9CA3B2]">{t('home.emptyDesc')}</p>
          <button
            type="button"
            onClick={onOpenAddPlaylist}
            className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-sm font-semibold transition-colors"
          >
            {t('nav.addSource')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-5 sm:space-y-6 pb-12 sm:pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3.5 sm:gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('series.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5 tabular-nums">
            {t('series.count', { count: filtered.length.toLocaleString() })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#666E80] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('series.searchPlaceholder')}
              className="w-full min-h-[44px] sm:min-h-[38px] pl-9 pr-3 py-2 rounded-lg bg-[#12141B] border border-white/10 focus:border-[#E50914] focus:outline-none text-base sm:text-xs text-white placeholder:text-[#666E80]"
            />
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'recent' | 'rating' | 'title')}
            aria-label={t('series.title')}
            className="flex-1 sm:flex-none min-h-[44px] sm:min-h-[38px] px-3 py-2 rounded-lg bg-[#12141B] border border-white/10 text-sm sm:text-xs text-white"
          >
            <option value="recent">{t('movies.sortNewest')}</option>
            <option value="rating">{t('movies.sortRating')}</option>
            <option value="title">{t('movies.sortAZ')}</option>
          </select>

          <button
            type="button"
            onClick={() => setFavoritesOnly((f) => !f)}
            className={`min-h-[44px] sm:min-h-[38px] px-3.5 py-2 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
              favoritesOnly
                ? 'bg-[#E50914]/15 border-[#E50914] text-white'
                : 'bg-[#12141B] border-white/10 text-[#9CA3B2] hover:text-white'
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${favoritesOnly ? 'fill-[#E50914] text-[#E50914]' : ''}`} />
            {t('nav.favorites')}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        <button
          type="button"
          onClick={() => setSelectedCategory('All')}
          className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            selectedCategory === 'All'
              ? 'bg-[#E50914] text-white'
              : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
          }`}
        >
          {t('live.allCategories')}
        </button>
        {categories.slice(0, 30).map(([cat, count]) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
              selectedCategory === cat
                ? 'bg-[#E50914] text-white'
                : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
            }`}
          >
            {cat} ({count})
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 sm:gap-4 lg:gap-5">
        {filtered.slice(0, visibleCount).map((s) => (
          <MediaCard
            key={s.id}
            title={cleanMediaTitle(s.name)}
            year={s.year}
            category={s.seasons.length > 0 ? `${s.seasons.length} ${t('common.seasons')}` : s.category}
            rating={s.rating}
            poster={s.poster}
            isFavorite={favorites.has(s.id)}
            kind="series"
            onPlay={() => onPlaySeriesDirect(s)}
            onDetails={() => onOpenSeriesDetail(s)}
            onToggleFavorite={() => onToggleFavorite(s.id)}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="py-16 text-center text-sm text-[#9CA3B2]">
          {t('series.empty')}
        </div>
      )}

      {visibleCount < filtered.length && (
        <div className="pt-4 text-center">
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + GRID_PAGE_SIZE)}
            className="px-6 py-2.5 rounded-lg bg-[#12141B] border border-white/15 hover:border-white/30 text-sm font-semibold text-white transition-colors"
          >
            {t('movies.loadMore', { remaining: (filtered.length - visibleCount).toLocaleString() })}
          </button>
        </div>
      )}
    </div>
  );
}

interface CategoriesViewProps {
  catalog: PlaylistCatalog | null;
  onSelectCategory: (section: NavSection, category: string) => void;
}

export function CategoriesView({ catalog, onSelectCategory }: CategoriesViewProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<'live' | 'movies' | 'series'>('live');

  const groups = useMemo(() => {
    const map = new Map<string, number>();
    if (scope === 'live') {
      for (const ch of catalog?.channels || []) {
        map.set(ch.category, (map.get(ch.category) || 0) + 1);
      }
    } else if (scope === 'movies') {
      for (const m of catalog?.movies || []) {
        map.set(m.category, (map.get(m.category) || 0) + 1);
      }
    } else {
      for (const s of catalog?.series || []) {
        map.set(s.category, (map.get(s.category) || 0) + 1);
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [catalog, scope]);

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-5 sm:space-y-6 pb-12 sm:pb-20">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('categories.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5">
            {t('categories.subtitle')}
          </p>
        </div>

        <div className="inline-flex p-1 rounded-lg bg-[#12141B] border border-white/[0.08] max-w-full overflow-x-auto no-scrollbar self-start">
          {(
            [
              { id: 'live', label: `${t('categories.liveTab')} (${catalog?.channels.length || 0})` },
              { id: 'movies', label: `${t('categories.moviesTab')} (${catalog?.movies.length || 0})` },
              { id: 'series', label: `${t('categories.seriesTab')} (${catalog?.series.length || 0})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setScope(tab.id)}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-md text-xs font-semibold tabular-nums transition-colors whitespace-nowrap shrink-0 ${
                scope === tab.id ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {groups.map(([name, count]) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelectCategory(scope, name)}
              className="p-5 rounded-xl bg-[#12141B] border border-white/[0.07] hover:border-[#E50914]/60 hover:bg-[#181B24] text-left flex items-center justify-between gap-3 transition-colors group"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white truncate group-hover:text-white">
                  {name}
                </h3>
                <p className="text-xs text-[#9CA3B2] mt-1 tabular-nums">
                  {t('categories.itemsCount', { count: count.toLocaleString() })}
                </p>
              </div>
              <FolderKanban className="w-5 h-5 text-[#666E80] group-hover:text-[#E50914] transition-colors shrink-0" />
            </button>
          ))}
        </div>
      ) : (
        <div className="py-16 text-center text-sm text-[#9CA3B2]">
          {t('categories.empty')}
        </div>
      )}
    </div>
  );
}

interface FavoritesViewProps {
  catalog: PlaylistCatalog | null;
  profileName?: string;
  favorites: Set<string>;
  watchlist?: Set<string>;
  onPlayChannel: (ch: LiveChannel) => void;
  onPlayMovie: (m: MovieItem) => void;
  onOpenMovieDetail: (m: MovieItem) => void;
  onPlaySeriesDirect: (s: SeriesItem) => void;
  onOpenSeriesDetail: (s: SeriesItem) => void;
  onToggleFavorite: (id: string) => void;
}

export function FavoritesView({
  catalog,
  profileName = 'IPFLIX',
  favorites,
  watchlist,
  onPlayChannel,
  onPlayMovie,
  onOpenMovieDetail,
  onPlaySeriesDirect,
  onOpenSeriesDetail,
  onToggleFavorite,
}: FavoritesViewProps) {
  const { t } = useI18n();
  const [listFilter, setListFilter] = useState<'all' | 'watchlist' | 'favorites'>('all');
  const watchlistSet = watchlist || new Set<string>();

  const matchesFilter = (id: string) => {
    if (listFilter === 'watchlist') return watchlistSet.has(id);
    if (listFilter === 'favorites') return favorites.has(id);
    return favorites.has(id) || watchlistSet.has(id);
  };

  const favChannels = useMemo(
    () => (catalog?.channels || []).filter((c) => matchesFilter(c.id)),
    [catalog?.channels, favorites, watchlistSet, listFilter]
  );
  const favMovies = useMemo(
    () => (catalog?.movies || []).filter((m) => matchesFilter(m.id)),
    [catalog?.movies, favorites, watchlistSet, listFilter]
  );
  const favSeries = useMemo(
    () => (catalog?.series || []).filter((s) => matchesFilter(s.id)),
    [catalog?.series, favorites, watchlistSet, listFilter]
  );

  const counts = useMemo(() => {
    const ch = catalog?.channels || [];
    const mv = catalog?.movies || [];
    const sr = catalog?.series || [];
    const allIds = new Set<string>([...favorites, ...watchlistSet]);
    let allCount = 0;
    let watchCount = 0;
    let favCount = 0;
    for (const item of [...ch, ...mv, ...sr]) {
      if (allIds.has(item.id)) allCount++;
      if (watchlistSet.has(item.id)) watchCount++;
      if (favorites.has(item.id)) favCount++;
    }
    return { allCount, watchCount, favCount };
  }, [catalog, favorites, watchlistSet]);

  const total = favChannels.length + favMovies.length + favSeries.length;

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-6 sm:space-y-8 pb-12 sm:pb-20">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('favorites.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5 tabular-nums">
            {t('favorites.subtitle', { profile: profileName })} · {total}
          </p>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
          {(
            [
              { id: 'all', label: `${t('favorites.tabAll')} (${counts.allCount})` },
              { id: 'watchlist', label: `${t('favorites.tabWatchlist')} (${counts.watchCount})` },
              { id: 'favorites', label: `${t('favorites.tabFavorites')} (${counts.favCount})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-focusable="true"
              onClick={() => setListFilter(tab.id)}
              className={`min-h-[42px] px-3.5 rounded-lg text-xs font-semibold tabular-nums transition-colors whitespace-nowrap shrink-0 ${
                listFilter === tab.id
                  ? 'bg-[#E50914] text-white'
                  : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.08]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="max-w-lg mx-auto rounded-2xl bg-[#12141B] border border-white/10 p-8 sm:p-10 text-center space-y-3">
          <Heart className="w-9 h-9 text-[#666E80] mx-auto" />
          <h2 className="text-lg font-bold text-white">{t('favorites.emptyTitle')}</h2>
          <p className="text-sm text-[#9CA3B2]">{t('favorites.emptyDesc')}</p>
        </div>
      ) : (
        <>
          {favChannels.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('favorites.channels')}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-4">
                {favChannels.map((ch) => (
                  <MediaCard
                    key={ch.id}
                    title={cleanMediaTitle(ch.name)}
                    subtitle={`${ch.num} · ${ch.category}`}
                    poster={ch.logo}
                    aspect="landscape"
                    kind="channel"
                    isFavorite={favorites.has(ch.id)}
                    onPlay={() => onPlayChannel(ch)}
                    onToggleFavorite={() => onToggleFavorite(ch.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {favMovies.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('favorites.movies')}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
                {favMovies.map((m) => (
                  <MediaCard
                    key={m.id}
                    title={cleanMediaTitle(m.name)}
                    year={m.year}
                    rating={m.rating}
                    poster={m.poster}
                    kind="movie"
                    isFavorite={favorites.has(m.id)}
                    onPlay={() => onPlayMovie(m)}
                    onDetails={() => onOpenMovieDetail(m)}
                    onToggleFavorite={() => onToggleFavorite(m.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {favSeries.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('favorites.series')}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
                {favSeries.map((s) => (
                  <MediaCard
                    key={s.id}
                    title={cleanMediaTitle(s.name)}
                    year={s.year}
                    rating={s.rating}
                    poster={s.poster}
                    kind="series"
                    isFavorite={favorites.has(s.id)}
                    onPlay={() => onPlaySeriesDirect(s)}
                    onDetails={() => onOpenSeriesDetail(s)}
                    onToggleFavorite={() => onToggleFavorite(s.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface SearchViewProps {
  catalog: PlaylistCatalog | null;
  favorites: Set<string>;
  initialQuery?: string;
  recentSearches?: string[];
  onRecordRecentSearch?: (query: string) => void;
  onPlayChannel: (ch: LiveChannel) => void;
  onPlayMovie: (m: MovieItem) => void;
  onOpenMovieDetail: (m: MovieItem) => void;
  onPlaySeriesDirect: (s: SeriesItem) => void;
  onOpenSeriesDetail: (s: SeriesItem) => void;
  onPlayEpisode?: (s: SeriesItem, ep: EpisodeItem) => void;
  onSelectCategory?: (section: NavSection, category: string) => void;
  onToggleFavorite: (id: string) => void;
}

export function SearchView({
  catalog,
  favorites,
  initialQuery = '',
  recentSearches = [],
  onRecordRecentSearch,
  onPlayChannel,
  onPlayMovie,
  onOpenMovieDetail,
  onPlaySeriesDirect,
  onOpenSeriesDetail,
  onPlayEpisode,
  onSelectCategory,
  onToggleFavorite,
}: SearchViewProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<
    'all' | 'movies' | 'series' | 'episodes' | 'live' | 'categories' | 'epg'
  >('all');

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const results = useMemo(() => {
    const smart = searchCatalogSmart(catalog, query, {
      movies: 36,
      series: 24,
      episodes: 24,
      channels: 24,
      categories: 16,
    });

    const normalizedQuery = normalizeTurkishSearch(query);
    const programs: Array<{
      title: string;
      channelName: string;
      start: number;
      end: number;
      channel?: LiveChannel;
    }> = [];

    if (normalizedQuery && catalog) {
      const byEpgId = new Map<string, LiveChannel>();
      for (const ch of catalog.channels) {
        if (ch.epgId) byEpgId.set(ch.epgId.toLowerCase(), ch);
        byEpgId.set(ch.name.toLowerCase(), ch);
      }

      for (const [key, list] of Object.entries(catalog.epgPrograms || {})) {
        for (const prog of list) {
          const hay = normalizeTurkishSearch(`${prog.title} ${prog.description || ''}`);
          if (hay.includes(normalizedQuery)) {
            const ch = byEpgId.get(key);
            programs.push({
              title: prog.title,
              channelName: ch?.name || key,
              start: prog.start,
              end: prog.end,
              channel: ch,
            });
            if (programs.length >= 20) break;
          }
        }
        if (programs.length >= 20) break;
      }
    }

    return {
      movies: smart.movies,
      series: smart.series,
      episodes: smart.episodes,
      channels: smart.channels,
      categories: smart.categories,
      totals: smart.totals,
      programs,
    };
  }, [catalog, query]);

  const totalMatches =
    results.totals.movies +
    results.totals.series +
    results.totals.episodes +
    results.totals.channels +
    results.totals.categories +
    results.programs.length;

  const sectionLabel = (section: 'live' | 'movies' | 'series') => {
    if (section === 'live') return t('nav.live');
    if (section === 'movies') return t('nav.movies');
    return t('nav.series');
  };

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-5 sm:space-y-6 pb-12 sm:pb-20">
      <div className="max-w-3xl space-y-4">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
          {t('search.title')}
        </h1>
        <div className="relative">
          <Search className="w-5 h-5 text-[#9CA3B2] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim().length >= 2) {
                onRecordRecentSearch?.(query.trim());
              }
            }}
            onBlur={() => {
              if (query.trim().length >= 2 && totalMatches > 0) {
                onRecordRecentSearch?.(query.trim());
              }
            }}
            placeholder={t('search.homePlaceholder')}
            className="w-full min-h-[48px] pl-12 pr-11 py-3 rounded-xl bg-[#12141B] border border-white/15 focus:border-[#E50914] focus:outline-none text-base text-white placeholder:text-[#666E80]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('search.clearSearch')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-[#9CA3B2] hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {!query.trim() && recentSearches.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-[#7F8799] mr-1">
              {t('search.recentSearches')}:
            </span>
            {recentSearches.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => setQuery(term)}
                className="min-h-[34px] px-3 py-1 rounded-lg bg-[#12141B] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-[#D6DCE8] hover:text-white transition-colors"
              >
                {term}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
          {(
            [
              { id: 'all', label: `${t('common.all')} (${totalMatches})` },
              { id: 'movies', label: `${t('nav.movies')} (${results.totals.movies})` },
              { id: 'series', label: `${t('nav.series')} (${results.totals.series})` },
              { id: 'episodes', label: `${t('search.episodeResults')} (${results.totals.episodes})` },
              { id: 'live', label: `${t('nav.live')} (${results.totals.channels})` },
              { id: 'categories', label: `${t('search.categoryResults')} (${results.totals.categories})` },
              { id: 'epg', label: `${t('live.viewGuide')} (${results.programs.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold tabular-nums transition-colors whitespace-nowrap shrink-0 ${
                filter === tab.id
                  ? 'bg-[#E50914] text-white'
                  : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {!query.trim() ? (
        <div className="py-12 text-sm text-[#9CA3B2]">
          {t('search.typePrompt')}
        </div>
      ) : totalMatches === 0 ? (
        <div className="py-12 space-y-1.5">
          <p className="text-sm font-semibold text-white">{t('search.noResults', { query })}</p>
          <p className="text-xs text-[#9CA3B2]">{t('search.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {(filter === 'all' || filter === 'movies') && results.movies.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('search.movieResults')}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 sm:gap-4 lg:gap-5">
                {results.movies.map((m) => (
                  <MediaCard
                    key={m.id}
                    title={cleanMediaTitle(m.name)}
                    year={m.year}
                    rating={m.rating}
                    poster={m.poster}
                    kind="movie"
                    isFavorite={favorites.has(m.id)}
                    onPlay={() => onPlayMovie(m)}
                    onDetails={() => onOpenMovieDetail(m)}
                    onToggleFavorite={() => onToggleFavorite(m.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'series') && results.series.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('search.seriesResults')}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 sm:gap-4 lg:gap-5">
                {results.series.map((s) => (
                  <MediaCard
                    key={s.id}
                    title={cleanMediaTitle(s.name)}
                    year={s.year}
                    rating={s.rating}
                    poster={s.poster}
                    kind="series"
                    isFavorite={favorites.has(s.id)}
                    onPlay={() => onPlaySeriesDirect(s)}
                    onDetails={() => onOpenSeriesDetail(s)}
                    onToggleFavorite={() => onToggleFavorite(s.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'episodes') && results.episodes.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('search.episodeResults')}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {results.episodes.map(({ series: s, episode }) => {
                  const code = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
                    episode.episodeNumber
                  ).padStart(2, '0')}`;
                  return (
                    <button
                      key={`${s.id}_${episode.id}`}
                      type="button"
                      data-focusable="true"
                      onClick={() => {
                        if (onPlayEpisode) onPlayEpisode(s, episode);
                        else onOpenSeriesDetail(s);
                      }}
                      className="p-3.5 rounded-xl bg-[#12141B] border border-white/[0.07] hover:border-[#E50914]/60 hover:bg-[#181B24] text-left flex items-center gap-3.5 transition-colors group"
                    >
                      <div className="w-16 h-11 rounded-lg bg-[#0A0B10] border border-white/[0.08] overflow-hidden shrink-0 flex items-center justify-center relative">
                        {episode.thumbnail || s.poster ? (
                          <img
                            src={episode.thumbnail || s.poster}
                            alt=""
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <Clapperboard className="w-4 h-4 text-[#666E80]" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white truncate">
                          {cleanMediaTitle(episode.title)}
                        </p>
                        <p className="text-xs text-[#9CA3B2] truncate mt-0.5 tabular-nums">
                          {cleanMediaTitle(s.name)} · {code}
                        </p>
                      </div>
                      <Play className="w-4 h-4 text-[#666E80] group-hover:text-[#E50914] fill-current shrink-0 transition-colors" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'live') && results.channels.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('search.liveResults')}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {results.channels.map((ch) => (
                  <MediaCard
                    key={ch.id}
                    title={cleanMediaTitle(ch.name)}
                    subtitle={`${ch.num} · ${ch.category}`}
                    poster={ch.logo}
                    aspect="landscape"
                    kind="channel"
                    isFavorite={favorites.has(ch.id)}
                    onPlay={() => onPlayChannel(ch)}
                    onToggleFavorite={() => onToggleFavorite(ch.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'categories') && results.categories.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('search.categoryResults')}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {results.categories.map((cat) => (
                  <button
                    key={`${cat.section}_${cat.name}`}
                    type="button"
                    data-focusable="true"
                    onClick={() => onSelectCategory?.(cat.section, cat.name)}
                    className="p-4 rounded-xl bg-[#12141B] border border-white/[0.07] hover:border-[#E50914]/60 hover:bg-[#181B24] text-left flex items-center justify-between gap-3 transition-colors group"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white truncate">{cat.name}</p>
                      <p className="text-xs text-[#9CA3B2] mt-0.5 tabular-nums">
                        {sectionLabel(cat.section)} ·{' '}
                        {t('categories.itemsCount', { count: cat.count.toLocaleString() })}
                      </p>
                    </div>
                    <FolderKanban className="w-5 h-5 text-[#666E80] group-hover:text-[#E50914] transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'epg') && results.programs.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold text-white">{t('live.epgTitle')}</h2>
              <div className="divide-y divide-white/[0.06] rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
                {results.programs.map((p, idx) => (
                  <div
                    key={`${p.channelName}_${idx}`}
                    className="p-4 flex items-center justify-between gap-4 hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{p.title}</p>
                      <p className="text-xs text-[#9CA3B2] tabular-nums">
                        {cleanMediaTitle(p.channelName)} · {formatShortTime(p.start)} –{' '}
                        {formatShortTime(p.end)}
                      </p>
                    </div>
                    {p.channel && (
                      <button
                        type="button"
                        onClick={() => onPlayChannel(p.channel!)}
                        className="px-3.5 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold shrink-0 inline-flex items-center gap-1.5"
                      >
                        <Tv className="w-3.5 h-3.5" />
                        {t('common.play')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
