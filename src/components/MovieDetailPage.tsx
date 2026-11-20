import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Check,
  Film,
  Heart,
  Play,
  Plus,
  RotateCcw,
  Star,
} from 'lucide-react';
import type {
  MovieItem,
  PlaylistSource,
  SeriesItem,
  WatchProgress,
} from '../types/iptv';
import { fetchXtreamVodDetails, formatDuration } from '../services/iptvApi';
import { MediaCard, ResilientImage } from './MediaArtwork';
import { BrandMark } from './BrandMark';
import { DetailRail } from './DetailRail';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';
import { parseCastNames, parseTrailerSource } from '../utils/trailerParser';

// Session cache to prevent repeated Xtream `get_vod_info` API calls for the same movie
const hydratedVodIds = new Set<string>();

function getInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatMinutesLabel(duration?: string, durationSeconds?: number, isTr = true): string | undefined {
  if (duration && duration.trim()) return duration.trim();
  if (durationSeconds && durationSeconds > 60) {
    const mins = Math.round(durationSeconds / 60);
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return isTr
        ? m > 0 ? `${h} sa ${m} dk` : `${h} sa`
        : m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return isTr ? `${mins} dk` : `${mins}m`;
  }
  return undefined;
}

export interface MovieDetailPageProps {
  movie: MovieItem;
  source: PlaylistSource | null;
  allMovies: MovieItem[];
  allSeries: SeriesItem[];
  favorites: Set<string>;
  isFavorite: boolean;
  isInWatchlist: boolean;
  progress?: WatchProgress;
  tvRemoteMode?: boolean;
  onBack: () => void;
  onPlay: (movie: MovieItem, resumePosition?: number) => void;
  onOpenTrailer: (url: string, title: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleWatchlist: (id: string) => void;
  onSelectMovie: (movie: MovieItem) => void;
  onSelectSeries: (series: SeriesItem) => void;
  onPlaySeriesDirect: (series: SeriesItem) => void;
  onMovieHydrated?: (updated: MovieItem) => void;
}

export function MovieDetailPage({
  movie,
  source,
  allMovies,
  allSeries,
  favorites,
  isFavorite,
  isInWatchlist,
  progress,
  tvRemoteMode = false,
  onBack,
  onPlay,
  onOpenTrailer,
  onToggleFavorite,
  onToggleWatchlist,
  onSelectMovie,
  onSelectSeries,
  onPlaySeriesDirect,
  onMovieHydrated,
}: MovieDetailPageProps) {
  const { lang, t } = useI18n();
  const isTr = lang === 'tr';

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playBtnRef = useRef<HTMLButtonElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [hydrated, setHydrated] = useState<MovieItem>(movie);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Sync latest prop updates and lazily hydrate Xtream VOD metadata once per movie per session
  useEffect(() => {
    setHydrated(movie);
    setScrolled(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }

    const needsHydration =
      source?.type === 'xtream' &&
      Boolean(movie.streamId) &&
      !hydratedVodIds.has(movie.id) &&
      (!movie.plot || !movie.cast || !movie.trailerUrl);

    if (!needsHydration) {
      setLoadingDetails(false);
      return;
    }

    let cancelled = false;
    setLoadingDetails(true);
    hydratedVodIds.add(movie.id);

    fetchXtreamVodDetails(source!, movie)
      .then((extra) => {
        if (cancelled) return;
        const merged: MovieItem = { ...movie, ...extra };
        setHydrated(merged);
        onMovieHydrated?.(merged);
      })
      .catch(() => {
        // Allow retry next time if network failed transiently
        hydratedVodIds.delete(movie.id);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });

    return () => {
      cancelled = true;
    };
  }, [movie.id]);

  // Focus primary play button when navigating via Android TV remote
  useEffect(() => {
    if (!tvRemoteMode) return;
    const id = window.requestAnimationFrame(() => {
      playBtnRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [movie.id, tvRemoteMode]);

  const displayTitle = cleanMediaTitle(hydrated.name);
  const parsedTrailer = useMemo(
    () => parseTrailerSource(hydrated.trailerUrl),
    [hydrated.trailerUrl]
  );

  const castNames = useMemo(() => parseCastNames(hydrated.cast, 12), [hydrated.cast]);

  const isFinished = Boolean(
    progress &&
      (progress.completed ||
        (progress.duration > 0 && progress.position / progress.duration >= 0.92))
  );
  const canResume = Boolean(progress && !isFinished && progress.position >= 2);

  const progressPct =
    progress && progress.duration > 0
      ? Math.min(100, Math.max(0, (progress.position / progress.duration) * 100))
      : 0;

  const remainingLabel =
    canResume && progress && progress.duration > progress.position
      ? t('detail.remaining', { time: formatDuration(progress.duration - progress.position) })
      : undefined;

  const durationLabel = formatMinutesLabel(hydrated.duration, hydrated.durationSeconds, isTr);
  const genreLabel = hydrated.genre || hydrated.category;
  const hasRating = typeof hydrated.rating === 'number' && hydrated.rating > 0;
  const heroArtwork = hydrated.backdrop || hydrated.poster;

  const similarMovies = useMemo(() => {
    const tokens = (hydrated.genre || hydrated.category || '')
      .toLowerCase()
      .split(/[·,/|&-]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);

    const sameCategory: MovieItem[] = [];
    const genreMatch: MovieItem[] = [];

    for (const m of allMovies) {
      if (m.id === hydrated.id) continue;
      if (m.category === hydrated.category) {
        sameCategory.push(m);
      } else if (tokens.length > 0) {
        const hay = `${m.genre || ''} ${m.category || ''}`.toLowerCase();
        if (tokens.some((tok) => hay.includes(tok))) {
          genreMatch.push(m);
        }
      }
      if (sameCategory.length + genreMatch.length >= 24) break;
    }

    return [...sameCategory, ...genreMatch].slice(0, 14);
  }, [allMovies, hydrated.id, hydrated.category, hydrated.genre]);

  const recommendedItems = useMemo(() => {
    const excluded = new Set<string>([hydrated.id, ...similarMovies.map((m) => m.id)]);

    const rankedMovies = allMovies
      .filter((m) => !excluded.has(m.id))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 8)
      .map((item) => ({ kind: 'movie' as const, item }));

    const rankedSeries = allSeries
      .filter((s) => !excluded.has(s.id))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 6)
      .map((item) => ({ kind: 'series' as const, item }));

    // Interleave movies and series naturally
    const mixed: Array<
      { kind: 'movie'; item: MovieItem } | { kind: 'series'; item: SeriesItem }
    > = [];
    const maxLen = Math.max(rankedMovies.length, rankedSeries.length);
    for (let i = 0; i < maxLen; i++) {
      if (rankedMovies[i]) mixed.push(rankedMovies[i]);
      if (rankedSeries[i]) mixed.push(rankedSeries[i]);
    }
    return mixed.slice(0, 14);
  }, [allMovies, allSeries, hydrated.id, similarMovies]);

  const hasCreditsSection = Boolean(
    hydrated.director || castNames.length > 0 || hydrated.country || hydrated.language
  );

  return (
    <motion.div
      ref={scrollRef}
      role="dialog"
      aria-modal="true"
      aria-label={displayTitle}
      data-focus-scope="active"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 72)}
      className="fixed inset-0 z-40 overflow-y-auto overflow-x-clip bg-[#08090D] text-[#F5F7FA] overscroll-contain"
    >
      {/* STICKY TRANSLUCENT TOP BAR */}
      <header
        className={`sticky top-0 z-30 min-h-[56px] sm:min-h-[64px] safe-area-top px-4 sm:px-8 lg:px-12 flex items-center justify-between gap-3 transition-colors duration-200 ${
          scrolled
            ? 'bg-[#08090D]/92 backdrop-blur-xl border-b border-white/[0.07]'
            : 'bg-gradient-to-b from-[#08090D]/85 via-[#08090D]/40 to-transparent'
        }`}
      >
        <button
          type="button"
          data-focusable="true"
          onClick={onBack}
          aria-label={t('detail.backToBrowse')}
          className="min-h-[44px] px-3.5 -ml-1 rounded-xl bg-black/40 hover:bg-white/[0.14] border border-white/[0.1] backdrop-blur-md text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914]"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
          <span>{t('detail.backToBrowse')}</span>
        </button>

        <p
          className={`font-display text-sm sm:text-base font-bold text-white truncate transition-opacity duration-200 ${
            scrolled ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {displayTitle}
        </p>

        <div className="shrink-0 opacity-90">
          <BrandMark size="sm" />
        </div>
      </header>

      {/* FULL-BLEED CINEMATIC HERO */}
      <section className="relative w-full min-h-[56vh] sm:min-h-[70vh] lg:min-h-[78vh] [@media(max-height:500px)]:min-h-[290px] -mt-14 sm:-mt-16 flex items-end overflow-hidden bg-[#08090D]">
        {/* Backdrop Artwork Layer */}
        <div className="absolute inset-0">
          {heroArtwork ? (
            <ResilientImage
              src={heroArtwork}
              alt={displayTitle}
              fallbackTitle={displayTitle}
              fallbackKind="movie"
              priority
              className="w-full h-full object-cover object-[50%_22%]"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-[#171B26] via-[#0E1018] to-[#08090D]">
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-[radial-gradient(ellipse_at_75%_22%,rgba(229,9,20,0.14),transparent_62%)]"
              />
            </div>
          )}

          {/* Multi-layer Cinema Scrims for Crisp Contrast */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#08090D] via-[#08090D]/68 to-[#08090D]/20" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#08090D]/95 via-[#08090D]/55 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#08090D] to-transparent" />
        </div>

        {/* Hero Typography & Actions */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: 'easeOut' }}
          className="relative z-10 w-full max-w-[1440px] mx-auto px-4 sm:px-10 lg:px-14 pt-24 sm:pt-28 pb-8 sm:pb-14"
        >
          <div className="max-w-3xl space-y-3.5 sm:space-y-5">
            {/* Unboxed Editorial Type Eyebrow & Metadata Line */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm font-medium text-[#D0D5E0] tabular-nums">
              <span className="font-display font-bold tracking-[0.18em] uppercase text-[#E50914]">
                {t('detail.movieBadge')}
              </span>
              {hydrated.year && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <span>{hydrated.year}</span>
                </>
              )}
              {genreLabel && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <span className="truncate max-w-[200px] sm:max-w-none">{genreLabel}</span>
                </>
              )}
              {durationLabel && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <span>{durationLabel}</span>
                </>
              )}
              {hasRating && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-white">
                    <Star className="w-3.5 h-3.5 fill-[#F5C518] text-[#F5C518]" />
                    {t('detail.imdbScore', { score: hydrated.rating!.toFixed(1) })}
                  </span>
                </>
              )}
            </div>

            {/* Monumental Movie Title */}
            <h1 className="font-display text-2xl sm:text-5xl lg:text-[58px] font-extrabold tracking-tight text-white leading-[1.06] drop-shadow-[0_6px_28px_rgba(0,0,0,0.65)]">
              {displayTitle}
            </h1>

            {/* Resume Watch Progress Strip (only when partially watched) */}
            {canResume && progress && (
              <div className="max-w-md space-y-1.5 pt-0.5">
                <div className="flex items-center justify-between text-xs text-[#C4C9D6] tabular-nums">
                  <span className="font-semibold text-white">
                    {t('detail.continueWatching')}
                  </span>
                  <span>{remainingLabel || formatDuration(progress.position)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full bg-[#E50914] rounded-full"
                    style={{ width: `${Math.min(100, Math.max(4, progressPct))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Short Synopsis (strictly real provider data — subtle shimmer only while loading) */}
            {hydrated.plot ? (
              <p className="text-sm sm:text-base text-[#CFD4E0] leading-relaxed max-w-2xl line-clamp-4">
                {hydrated.plot}
              </p>
            ) : loadingDetails ? (
              <div className="space-y-2 max-w-xl pt-1" aria-label={t('detail.loadingDetails')}>
                <div className="h-3.5 w-full rounded bg-white/[0.08] animate-pulse" />
                <div className="h-3.5 w-4/5 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ) : null}

            {/* Primary & Secondary Action Buttons (Clean mobile stacking + desktop horizontal) */}
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 pt-1.5">
              <button
                ref={playBtnRef}
                type="button"
                data-focusable="true"
                onClick={() => onPlay(hydrated, canResume ? progress?.position : 0)}
                className="w-full sm:w-auto min-h-[46px] sm:min-h-[48px] px-6 sm:px-7 rounded-xl bg-[#E50914] hover:bg-[#F6121D] active:scale-[0.98] text-white text-sm sm:text-[15px] font-bold inline-flex items-center justify-center gap-2.5 shadow-[0_14px_34px_-10px_rgba(229,9,20,0.75)] transition-all whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Play className="w-4 h-4 fill-current shrink-0" />
                <span>
                  {canResume
                    ? t('detail.resumeAt', { time: formatDuration(progress!.position) })
                    : t('detail.watchNow')}
                </span>
              </button>

              {canResume && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => onPlay(hydrated, 0)}
                  className="flex-1 sm:flex-none min-h-[44px] sm:min-h-[48px] px-4 sm:px-5 rounded-xl bg-white/[0.1] hover:bg-white/[0.18] active:scale-[0.98] border border-white/[0.14] backdrop-blur-md text-white text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914]"
                >
                  <RotateCcw className="w-4 h-4 shrink-0" />
                  <span>{t('detail.startFromBeginning')}</span>
                </button>
              )}

              {/* Trailer button shown ONLY when a real playable trailer exists */}
              {parsedTrailer && hydrated.trailerUrl && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => onOpenTrailer(hydrated.trailerUrl!, hydrated.name)}
                  className="flex-1 sm:flex-none min-h-[44px] sm:min-h-[48px] px-4 sm:px-5 rounded-xl bg-white/[0.1] hover:bg-white/[0.18] active:scale-[0.98] border border-white/[0.14] backdrop-blur-md text-white text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914]"
                >
                  <Film className="w-4 h-4 shrink-0 text-white/90" />
                  <span>{t('detail.watchTrailer')}</span>
                </button>
              )}

              {/* Watchlist ("Listeme Ekle") */}
              <button
                type="button"
                data-focusable="true"
                onClick={() => onToggleWatchlist(hydrated.id)}
                className={`flex-1 sm:flex-none min-h-[44px] sm:min-h-[48px] px-4 sm:px-5 rounded-xl border backdrop-blur-md text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] ${
                  isInWatchlist
                    ? 'bg-white/[0.16] border-white/35 text-white'
                    : 'bg-black/45 border-white/[0.16] text-white/90 hover:bg-white/[0.12]'
                }`}
              >
                {isInWatchlist ? (
                  <Check className="w-4 h-4 shrink-0 text-emerald-400" />
                ) : (
                  <Plus className="w-4 h-4 shrink-0" />
                )}
                <span>{isInWatchlist ? t('detail.inMyList') : t('detail.addToList')}</span>
              </button>

              {/* Favorites ("Favorilere Ekle") */}
              <button
                type="button"
                data-focusable="true"
                onClick={() => onToggleFavorite(hydrated.id)}
                className={`flex-1 sm:flex-none min-h-[44px] sm:min-h-[48px] px-4 sm:px-5 rounded-xl border backdrop-blur-md text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] ${
                  isFavorite
                    ? 'bg-[#E50914]/20 border-[#E50914] text-white'
                    : 'bg-black/45 border-white/[0.16] text-white/90 hover:bg-white/[0.12]'
                }`}
              >
                <Heart
                  className={`w-4 h-4 shrink-0 ${
                    isFavorite ? 'fill-[#E50914] text-[#E50914]' : ''
                  }`}
                />
                <span>{isFavorite ? t('detail.inFavorites') : t('detail.addToFavorites')}</span>
              </button>
            </div>
          </div>
        </motion.div>
      </section>

      {/* LOWER EDITORIAL CONTENT */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-10 lg:px-14 pt-6 sm:pt-10 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] space-y-10 sm:space-y-14">
        {/* CAST & DIRECTOR (Only rendered if real metadata exists) */}
        {hasCreditsSection && (
          <section className="border-t border-white/[0.07] pt-8 sm:pt-10 space-y-6">
            <h2 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight">
              {t('detail.castAndCrew')}
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10">
              {/* Director & Key Production Facts */}
              <dl className="lg:col-span-4 grid grid-cols-2 lg:grid-cols-1 gap-x-6 gap-y-5 content-start">
                {hydrated.director && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                      {t('detail.director')}
                    </dt>
                    <dd className="text-sm sm:text-base font-semibold text-white mt-1">
                      {hydrated.director}
                    </dd>
                  </div>
                )}

                {hydrated.category && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                      {t('detail.category')}
                    </dt>
                    <dd className="text-sm font-medium text-[#D0D5E0] mt-1">
                      {hydrated.category}
                    </dd>
                  </div>
                )}

                {hydrated.country && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                      {t('detail.country')}
                    </dt>
                    <dd className="text-sm font-medium text-[#D0D5E0] mt-1">
                      {hydrated.country}
                    </dd>
                  </div>
                )}

                {hydrated.language && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                      {t('detail.language')}
                    </dt>
                    <dd className="text-sm font-medium text-[#D0D5E0] mt-1">
                      {hydrated.language}
                    </dd>
                  </div>
                )}
              </dl>

              {/* Cast Roster (only when cast array has real names) */}
              {castNames.length > 0 && (
                <div className="lg:col-span-8 space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                    {t('detail.cast')}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {castNames.map((actor) => (
                      <div
                        key={actor}
                        className="flex items-center gap-3 py-2 px-3 rounded-xl bg-[#11131B] border border-white/[0.06]"
                      >
                        <span
                          aria-hidden="true"
                          className="w-9 h-9 rounded-full bg-white/[0.06] border border-white/[0.08] font-display text-xs font-bold text-white/80 flex items-center justify-center shrink-0"
                        >
                          {getInitials(actor)}
                        </span>
                        <span className="text-sm font-medium text-white/92 truncate">
                          {actor}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* SIMILAR MOVIES */}
        {similarMovies.length > 0 && (
          <div className="border-t border-white/[0.07] pt-8 sm:pt-10">
            <DetailRail title={t('detail.similarMovies')} subtitle={hydrated.category}>
              {similarMovies.map((sim) => (
                <div
                  key={sim.id}
                  className="w-[136px] sm:w-[168px] md:w-[186px] shrink-0 snap-start"
                >
                  <MediaCard
                    title={cleanMediaTitle(sim.name)}
                    year={sim.year}
                    rating={sim.rating}
                    poster={sim.poster}
                    kind="movie"
                    isFavorite={favorites.has(sim.id)}
                    onPlay={() => onPlay(sim, 0)}
                    onDetails={() => onSelectMovie(sim)}
                    onToggleFavorite={() => onToggleFavorite(sim.id)}
                  />
                </div>
              ))}
            </DetailRail>
          </div>
        )}

        {/* RECOMMENDED CONTENT */}
        {recommendedItems.length > 0 && (
          <div className="border-t border-white/[0.07] pt-8 sm:pt-10">
            <DetailRail title={t('detail.recommended')}>
              {recommendedItems.map((entry) =>
                entry.kind === 'movie' ? (
                  <div
                    key={`rec_m_${entry.item.id}`}
                    className="w-[136px] sm:w-[168px] md:w-[186px] shrink-0 snap-start"
                  >
                    <MediaCard
                      title={cleanMediaTitle(entry.item.name)}
                      year={entry.item.year}
                      rating={entry.item.rating}
                      poster={entry.item.poster}
                      kind="movie"
                      isFavorite={favorites.has(entry.item.id)}
                      onPlay={() => onPlay(entry.item, 0)}
                      onDetails={() => onSelectMovie(entry.item)}
                      onToggleFavorite={() => onToggleFavorite(entry.item.id)}
                    />
                  </div>
                ) : (
                  <div
                    key={`rec_s_${entry.item.id}`}
                    className="w-[136px] sm:w-[168px] md:w-[186px] shrink-0 snap-start"
                  >
                    <MediaCard
                      title={cleanMediaTitle(entry.item.name)}
                      year={entry.item.year}
                      rating={entry.item.rating}
                      poster={entry.item.poster}
                      kind="series"
                      isFavorite={favorites.has(entry.item.id)}
                      onPlay={() => onPlaySeriesDirect(entry.item)}
                      onDetails={() => onSelectSeries(entry.item)}
                      onToggleFavorite={() => onToggleFavorite(entry.item.id)}
                    />
                  </div>
                )
              )}
            </DetailRail>
          </div>
        )}
      </div>
    </motion.div>
  );
}
