import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  Heart,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Star,
} from 'lucide-react';
import type {
  EpisodeItem,
  MovieItem,
  PlaylistSource,
  SeasonGroup,
  SeriesItem,
  WatchProgress,
} from '../types/iptv';
import { fetchXtreamSeriesDetails, formatDuration } from '../services/iptvApi';
import { MediaCard, ResilientImage } from './MediaArtwork';
import { BrandMark } from './BrandMark';
import { DetailRail } from './DetailRail';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';
import { parseCastNames, parseTrailerSource } from '../utils/trailerParser';

const INITIAL_ROW_EPISODES = 24;

// Session cache to prevent repeated Xtream `get_series_info` requests once loaded
const hydratedSeriesIds = new Set<string>();

function getInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatEpisodeDuration(
  duration?: string,
  durationSeconds?: number,
  isTr = true
): string | undefined {
  if (duration && duration.trim()) return duration.trim();
  if (durationSeconds && durationSeconds > 60) {
    const mins = Math.round(durationSeconds / 60);
    return isTr ? `${mins} dk` : `${mins}m`;
  }
  return undefined;
}

interface SeasonEpisodeRowProps {
  season: SeasonGroup;
  seasonTitle: string;
  series: SeriesItem;
  isHighlighted: boolean;
  resumeEpisodeId?: string;
  resumeMode?: 'continue' | 'next' | 'first';
  watchProgress: Record<string, WatchProgress>;
  isTr: boolean;
  onPlayEpisode: (series: SeriesItem, episode: EpisodeItem, resumePosition?: number) => void;
  registerRowRef: (seasonNumber: number, el: HTMLDivElement | null) => void;
}

function SeasonEpisodeRow({
  season,
  seasonTitle,
  series,
  isHighlighted,
  resumeEpisodeId,
  resumeMode,
  watchProgress,
  isTr,
  onPlayEpisode,
  registerRowRef,
}: SeasonEpisodeRowProps) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROW_EPISODES);

  useEffect(() => {
    setVisibleCount(INITIAL_ROW_EPISODES);
  }, [series.id, season.seasonNumber]);

  const watchedCount = useMemo(() => {
    return season.episodes.filter((ep) => {
      const p = watchProgress[ep.id];
      return Boolean(p && (p.completed || (p.duration > 0 && p.position / p.duration >= 0.9)));
    }).length;
  }, [season.episodes, watchProgress]);

  const visibleEpisodes = useMemo(
    () => season.episodes.slice(0, visibleCount),
    [season.episodes, visibleCount]
  );

  const remainingEpisodes = Math.max(0, season.episodes.length - visibleEpisodes.length);

  const scrollTrack = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(el.clientWidth * 0.82, 300),
      behavior: 'smooth',
    });
  };

  return (
    <div
      ref={(el) => registerRowRef(season.seasonNumber, el)}
      data-season-row={season.seasonNumber}
      className="scroll-mt-20 space-y-3 sm:space-y-3.5"
    >
      {/* Season Row Header + Desktop Horizontal Scroll Arrows */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5 flex-wrap min-w-0">
          <h3 className="font-display text-base sm:text-lg lg:text-xl font-bold text-white tracking-tight flex items-center gap-2">
            {isHighlighted && (
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-4 rounded-full bg-[#E50914] shrink-0"
              />
            )}
            <span>{seasonTitle}</span>
          </h3>
          <p className="text-xs sm:text-sm text-[#9CA3B2] tabular-nums">
            {t('detail.episodesCount', { count: season.episodes.length })}
            {watchedCount > 0 && <> · {t('detail.watchedCount', { count: watchedCount })}</>}
          </p>
        </div>

        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => scrollTrack(-1)}
            aria-label={`${seasonTitle} — ${t('home.scrollLeft')}`}
            className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/[0.1] text-white/85 hover:text-white flex items-center justify-center transition-colors active:scale-95"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollTrack(1)}
            aria-label={`${seasonTitle} — ${t('home.scrollRight')}`}
            className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/[0.1] text-white/85 hover:text-white flex items-center justify-center transition-colors active:scale-95"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Single Horizontal Scrollable Episode Rail (1 row per season, side-by-side) */}
      <div
        ref={trackRef}
        className="flex flex-nowrap gap-3.5 sm:gap-4 overflow-x-auto no-scrollbar snap-x snap-mandatory scroll-smooth -mx-4 px-4 sm:mx-0 sm:px-0 py-1.5"
      >
        {visibleEpisodes.map((ep) => {
          const p = watchProgress[ep.id];
          const pct = p && p.duration > 0 ? Math.min(100, (p.position / p.duration) * 100) : 0;
          const watched = Boolean(p && (p.completed || pct >= 90));
          const inProgress = Boolean(p && !watched && (pct > 2 || p.position >= 2));
          const isResumeCard = resumeEpisodeId === ep.id && resumeMode !== 'first';
          const epDisplayTitle = cleanMediaTitle(ep.title);
          const epDuration = formatEpisodeDuration(ep.duration, ep.durationSeconds, isTr);
          const remainingText =
            inProgress && p && p.duration > p.position
              ? t('detail.remaining', { time: formatDuration(p.duration - p.position) })
              : undefined;

          const epMeta = [
            remainingText,
            !remainingText ? epDuration : undefined,
            ep.airDate,
          ].filter(Boolean) as string[];

          return (
            <button
              key={ep.id}
              type="button"
              data-focusable="true"
              onClick={() => onPlayEpisode(series, ep, watched ? 0 : p?.position || 0)}
              className={`group relative flex flex-col w-[236px] sm:w-[272px] lg:w-[296px] shrink-0 snap-start rounded-2xl overflow-hidden text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] focus-visible:border-[#E50914] ${
                isResumeCard
                  ? 'bg-[#151823] border border-[#E50914]/65 shadow-[0_14px_34px_-14px_rgba(229,9,20,0.45)]'
                  : 'bg-[#12141B] border border-white/[0.07] hover:border-white/20 hover:bg-[#161923]'
              }`}
            >
              {/* 16:9 Episode Visual Thumbnail (ratio strictly preserved) */}
              <div className="relative w-full aspect-video bg-[#181B24] overflow-hidden shrink-0">
                <ResilientImage
                  src={ep.thumbnail || series.backdrop || series.poster}
                  alt={epDisplayTitle}
                  fallbackTitle={`${isTr ? 'B' : 'E'}${ep.episodeNumber}`}
                  fallbackKind="series"
                  className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
                />

                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-black/25" />

                {/* Top-left Episode Number */}
                <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-sm font-mono text-[11px] font-bold text-white tabular-nums">
                  {isTr ? `B${ep.episodeNumber}` : `E${ep.episodeNumber}`}
                </span>

                {/* Top-right Watched or Active Resume Status */}
                {watched ? (
                  <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-sm inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                    <Check className="w-3.5 h-3.5" />
                    {t('detail.watched')}
                  </span>
                ) : isResumeCard ? (
                  <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-[#E50914] text-[11px] font-bold text-white shadow">
                    {resumeMode === 'continue'
                      ? t('detail.continueEpisodeBadge')
                      : t('detail.upNextBadge')}
                  </span>
                ) : null}

                {/* Bottom-right Duration (only if real duration exists) */}
                {epDuration && (
                  <span className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-sm font-mono text-[11px] font-medium text-white/90 tabular-nums">
                    {epDuration}
                  </span>
                )}

                {/* Center Play Cue */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-200">
                  <span className="w-11 h-11 rounded-full bg-[#E50914] text-white flex items-center justify-center shadow-[0_10px_28px_rgba(229,9,20,0.65)] transition-transform duration-200 group-hover:scale-105">
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                  </span>
                </div>

                {/* Episode Watch Progress Bar */}
                {(watched || inProgress || pct > 2) && (
                  <div className="absolute bottom-0 inset-x-0 h-1 bg-white/25">
                    <div
                      className="h-full bg-[#E50914]"
                      style={{ width: `${watched ? 100 : Math.min(100, Math.max(4, pct))}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Episode Info */}
              <div className="p-3.5 flex-1 flex flex-col gap-1 min-w-0">
                <h4 className="text-sm sm:text-[15px] font-semibold text-white leading-snug line-clamp-1">
                  {epDisplayTitle}
                </h4>

                {epMeta.length > 0 && (
                  <p className="text-xs text-[#9CA3B2] tabular-nums truncate">
                    {epMeta.join(' · ')}
                  </p>
                )}

                {ep.plot && (
                  <p className="text-xs text-[#A7AEBE] line-clamp-2 leading-relaxed pt-0.5">
                    {ep.plot}
                  </p>
                )}
              </div>
            </button>
          );
        })}

        {/* Inline Load-More Card at the end of very long horizontal season rails */}
        {remainingEpisodes > 0 && (
          <button
            type="button"
            data-focusable="true"
            onClick={() => setVisibleCount((prev) => prev + INITIAL_ROW_EPISODES)}
            className="w-[172px] sm:w-[200px] shrink-0 snap-start rounded-2xl bg-[#12141B] hover:bg-[#191D29] border border-dashed border-white/20 hover:border-[#E50914]/70 p-4 flex flex-col items-center justify-center text-center gap-2.5 transition-colors active:scale-[0.98]"
          >
            <span className="w-10 h-10 rounded-full bg-white/[0.08] flex items-center justify-center text-white">
              <Plus className="w-5 h-5" />
            </span>
            <span className="text-xs sm:text-sm font-semibold text-white leading-snug">
              {t('detail.loadMoreEpisodes', { remaining: remainingEpisodes })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

export interface SeriesDetailPageProps {
  series: SeriesItem;
  source: PlaylistSource | null;
  allSeries: SeriesItem[];
  allMovies: MovieItem[];
  favorites: Set<string>;
  isFavorite: boolean;
  isInWatchlist: boolean;
  watchProgress: Record<string, WatchProgress>;
  tvRemoteMode?: boolean;
  onBack: () => void;
  onPlayEpisode: (series: SeriesItem, episode: EpisodeItem, resumePosition?: number) => void;
  onPlayMovie: (movie: MovieItem, resumePosition?: number) => void;
  onOpenTrailer: (url: string, title: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleWatchlist: (id: string) => void;
  onSelectSeries: (series: SeriesItem) => void;
  onSelectMovie: (movie: MovieItem) => void;
  onSeriesHydrated?: (updated: SeriesItem) => void;
}

export function SeriesDetailPage({
  series,
  source,
  allSeries,
  allMovies,
  favorites,
  isFavorite,
  isInWatchlist,
  watchProgress,
  tvRemoteMode = false,
  onBack,
  onPlayEpisode,
  onPlayMovie,
  onOpenTrailer,
  onToggleFavorite,
  onToggleWatchlist,
  onSelectSeries,
  onSelectMovie,
  onSeriesHydrated,
}: SeriesDetailPageProps) {
  const { lang, t } = useI18n();
  const isTr = lang === 'tr';

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seasonsSectionRef = useRef<HTMLElement | null>(null);
  const seasonRowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const playBtnRef = useRef<HTMLButtonElement | null>(null);
  const userPickedSeasonRef = useRef(false);
  const lastRetryNonceRef = useRef(0);

  const [scrolled, setScrolled] = useState(false);
  const [hydrated, setHydrated] = useState<SeriesItem>(series);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [highlightedSeasonNum, setHighlightedSeasonNum] = useState<number>(
    series.seasons[0]?.seasonNumber ?? 1
  );

  const effectiveSeriesId =
    series.seriesId ||
    (series.id.includes('_ser_') ? series.id.split('_ser_').pop() : undefined);
  const canFetchFromXtream = source?.type === 'xtream' && Boolean(effectiveSeriesId);

  // Keep local state in sync if parent catalog updates this series externally with seasons
  useEffect(() => {
    if (series.id !== hydrated.id) return;
    if (series.seasons.length > hydrated.seasons.length) {
      setHydrated(series);
    }
  }, [series, hydrated.id, hydrated.seasons.length]);

  // Sync on series change and hydrate Xtream seasons/metadata (self-healing if cached seasons were empty)
  useEffect(() => {
    const isManualRetry = retryNonce !== lastRetryNonceRef.current;
    lastRetryNonceRef.current = retryNonce;
    if (!isManualRetry) {
      userPickedSeasonRef.current = false;
      setHydrated(series);
      setScrolled(false);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
      const firstSeason = series.seasons[0]?.seasonNumber ?? 1;
      setHighlightedSeasonNum(firstSeason);
    }

    setLoadError(null);

    const needsHydration =
      canFetchFromXtream &&
      (isManualRetry ||
        series.seasons.length === 0 ||
        (!series.seasonsLoaded && !hydratedSeriesIds.has(series.id)));

    if (!needsHydration || !source) {
      setLoadingSeasons(false);
      return;
    }

    let cancelled = false;
    setLoadingSeasons(true);

    fetchXtreamSeriesDetails(source, { ...series, seriesId: effectiveSeriesId })
      .then((extra) => {
        if (cancelled) return;
        const nextSeasons =
          extra.seasons && extra.seasons.length > 0 ? extra.seasons : series.seasons;
        const merged: SeriesItem = {
          ...series,
          ...extra,
          seasons: nextSeasons,
          seasonsLoaded: nextSeasons.length > 0,
        };
        if (nextSeasons.length > 0) {
          hydratedSeriesIds.add(series.id);
        }
        setHydrated(merged);
        if (nextSeasons.length > 0 || extra.plot || extra.backdrop || extra.cast) {
          onSeriesHydrated?.(merged);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        hydratedSeriesIds.delete(series.id);
        setLoadError(err instanceof Error ? err.message : 'Failed to load seasons');
      })
      .finally(() => {
        if (!cancelled) setLoadingSeasons(false);
      });

    return () => {
      cancelled = true;
    };
  }, [series.id, source?.id, retryNonce]);

  // Compute exact resume / next episode / first episode target preserving watch history
  const resumeTarget = useMemo(() => {
    const allEps = hydrated.seasons.flatMap((s) => s.episodes);
    if (allEps.length === 0) return null;

    let latestEp: EpisodeItem | null = null;
    let latestUpdatedAt = 0;

    for (const ep of allEps) {
      const p = watchProgress[ep.id];
      if (p && p.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = p.updatedAt;
        latestEp = ep;
      }
    }

    if (latestEp) {
      const p = watchProgress[latestEp.id];
      const finished = Boolean(p && (p.completed || (p.duration > 0 && p.position / p.duration >= 0.9)));
      if (finished) {
        const idx = allEps.findIndex((e) => e.id === latestEp!.id);
        if (idx >= 0 && allEps[idx + 1]) {
          const nextEp = allEps[idx + 1];
          return {
            mode: 'next' as const,
            episode: nextEp,
            resumeSec: 0,
            progressPct: 0,
            codeLabel: isTr
              ? `S${nextEp.seasonNumber} B${nextEp.episodeNumber}`
              : `S${nextEp.seasonNumber} E${nextEp.episodeNumber}`,
          };
        }
      }

      const pct =
        p && p.duration > 0 ? Math.min(100, Math.max(0, (p.position / p.duration) * 100)) : 0;
      return {
        mode: 'continue' as const,
        episode: latestEp,
        resumeSec: finished ? 0 : p?.position || 0,
        progressPct: finished ? 0 : pct,
        remainingSec:
          !finished && p && p.duration > p.position ? p.duration - p.position : undefined,
        codeLabel: isTr
          ? `S${latestEp.seasonNumber} B${latestEp.episodeNumber}`
          : `S${latestEp.seasonNumber} E${latestEp.episodeNumber}`,
      };
    }

    const first = allEps[0];
    return {
      mode: 'first' as const,
      episode: first,
      resumeSec: 0,
      progressPct: 0,
      codeLabel: isTr
        ? `S${first.seasonNumber} B${first.episodeNumber}`
        : `S${first.seasonNumber} E${first.episodeNumber}`,
    };
  }, [hydrated.seasons, watchProgress, isTr]);

  // Auto-highlight the season containing the user's resume/next episode unless manually jumped
  useEffect(() => {
    if (userPickedSeasonRef.current) return;
    if (resumeTarget?.episode && resumeTarget.episode.seasonNumber !== undefined) {
      setHighlightedSeasonNum(resumeTarget.episode.seasonNumber);
    } else if (hydrated.seasons[0]) {
      setHighlightedSeasonNum(hydrated.seasons[0].seasonNumber);
    }
  }, [hydrated.id, hydrated.seasons.length, resumeTarget?.episode?.seasonNumber]);

  // Focus primary CTA in Android TV mode
  useEffect(() => {
    if (!tvRemoteMode) return;
    const id = window.requestAnimationFrame(() => {
      playBtnRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [series.id, tvRemoteMode]);

  const totalEpisodesCount = useMemo(
    () => hydrated.seasons.reduce((acc, s) => acc + s.episodes.length, 0),
    [hydrated.seasons]
  );

  const displayTitle = cleanMediaTitle(hydrated.name);
  const parsedTrailer = useMemo(
    () => parseTrailerSource(hydrated.trailerUrl),
    [hydrated.trailerUrl]
  );
  const castNames = useMemo(() => parseCastNames(hydrated.cast, 12), [hydrated.cast]);
  const hasRating = typeof hydrated.rating === 'number' && hydrated.rating > 0;
  const genreLabel = hydrated.genre || hydrated.category;
  const heroArtwork = hydrated.backdrop || hydrated.poster;

  const seasonsLabel =
    hydrated.seasons.length === 1
      ? t('detail.seasonSingle')
      : hydrated.seasons.length > 1
      ? t('detail.seasonsCount', { count: hydrated.seasons.length })
      : undefined;

  const primaryCtaLabel = !resumeTarget
    ? t('detail.watchFirstEpisode')
    : resumeTarget.mode === 'continue'
    ? `${t('detail.continueWatching')} · ${resumeTarget.codeLabel}`
    : resumeTarget.mode === 'next'
    ? `${t('detail.nextEpisodeBtn')} · ${resumeTarget.codeLabel}`
    : t('detail.watchFirstEpisode');

  const similarSeries = useMemo(() => {
    const tokens = (hydrated.genre || hydrated.category || '')
      .toLowerCase()
      .split(/[·,/|&-]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);

    const sameCategory: SeriesItem[] = [];
    const genreMatch: SeriesItem[] = [];

    for (const s of allSeries) {
      if (s.id === hydrated.id) continue;
      if (s.category === hydrated.category) {
        sameCategory.push(s);
      } else if (tokens.length > 0) {
        const hay = `${s.genre || ''} ${s.category || ''}`.toLowerCase();
        if (tokens.some((tok) => hay.includes(tok))) {
          genreMatch.push(s);
        }
      }
      if (sameCategory.length + genreMatch.length >= 24) break;
    }

    return [...sameCategory, ...genreMatch].slice(0, 14);
  }, [allSeries, hydrated.id, hydrated.category, hydrated.genre]);

  const recommendedItems = useMemo(() => {
    const excluded = new Set<string>([hydrated.id, ...similarSeries.map((s) => s.id)]);

    const rankedSeries = allSeries
      .filter((s) => !excluded.has(s.id))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 8)
      .map((item) => ({ kind: 'series' as const, item }));

    const rankedMovies = allMovies
      .filter((m) => !excluded.has(m.id))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 6)
      .map((item) => ({ kind: 'movie' as const, item }));

    const mixed: Array<
      { kind: 'series'; item: SeriesItem } | { kind: 'movie'; item: MovieItem }
    > = [];
    const maxLen = Math.max(rankedSeries.length, rankedMovies.length);
    for (let i = 0; i < maxLen; i++) {
      if (rankedSeries[i]) mixed.push(rankedSeries[i]);
      if (rankedMovies[i]) mixed.push(rankedMovies[i]);
    }
    return mixed.slice(0, 14);
  }, [allSeries, allMovies, hydrated.id, similarSeries]);

  const hasCreditsSection = Boolean(hydrated.director || castNames.length > 0);

  const getSeasonDisplayName = (seasonNum: number, rawName: string) => {
    const trimmed = (rawName || '').trim();
    if (
      seasonNum === 0 &&
      (!trimmed || /^Specials?$/i.test(trimmed) || /^Season\s+0$/i.test(trimmed))
    ) {
      return t('detail.specialsSeason');
    }
    if (isTr && /^Season\s+\d+$/i.test(trimmed)) {
      return t('detail.seasonLabel', { num: seasonNum });
    }
    return trimmed || t('detail.seasonLabel', { num: seasonNum });
  };

  const jumpToSeasonRow = (seasonNum: number) => {
    userPickedSeasonRef.current = true;
    setHighlightedSeasonNum(seasonNum);
    const target = seasonRowRefs.current[seasonNum];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const registerRowRef = (seasonNumber: number, el: HTMLDivElement | null) => {
    seasonRowRefs.current[seasonNumber] = el;
  };

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
      {/* STICKY TRANSLUCENT TOP BAR (Safe-area aware for Android notches) */}
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

      {/* FULL-BLEED SERIES HERO (Balanced height for portrait & landscape phones so seasons appear immediately) */}
      <section className="relative w-full min-h-[38vh] sm:min-h-[46vh] lg:min-h-[50vh] [@media(max-height:500px)]:min-h-[260px] -mt-14 sm:-mt-16 flex items-end overflow-hidden bg-[#08090D]">
        <div className="absolute inset-0">
          {heroArtwork ? (
            <ResilientImage
              src={heroArtwork}
              alt={displayTitle}
              fallbackTitle={displayTitle}
              fallbackKind="series"
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

          {/* Layered Scrims */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#08090D] via-[#08090D]/70 to-[#08090D]/25" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#08090D]/95 via-[#08090D]/60 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#08090D] to-transparent" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: 'easeOut' }}
          className="relative z-10 w-full max-w-[1440px] mx-auto px-4 sm:px-10 lg:px-14 pt-20 sm:pt-24 pb-6 sm:pb-8"
        >
          <div className="max-w-3xl space-y-3 sm:space-y-4">
            {/* Unboxed Series Metadata Row */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm font-medium text-[#D0D5E0] tabular-nums">
              <span className="font-display font-bold tracking-[0.18em] uppercase text-[#E50914]">
                {t('detail.seriesBadge')}
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
              {seasonsLabel && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() =>
                      seasonsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                    className="font-semibold text-white hover:text-[#E50914] transition-colors underline decoration-white/25 underline-offset-4"
                  >
                    {seasonsLabel}
                  </button>
                </>
              )}
              {totalEpisodesCount > 0 && (
                <>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <span>{t('detail.episodesCount', { count: totalEpisodesCount })}</span>
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

            {/* Series Title */}
            <h1 className="font-display text-2xl sm:text-5xl lg:text-[52px] font-extrabold tracking-tight text-white leading-[1.06] drop-shadow-[0_6px_28px_rgba(0,0,0,0.65)]">
              {displayTitle}
            </h1>

            {/* Active Episode Resume Strip (only when viewer is mid-episode) */}
            {resumeTarget && resumeTarget.mode === 'continue' && resumeTarget.progressPct > 2 && (
              <div className="max-w-md space-y-1.5 pt-0.5">
                <div className="flex items-center justify-between gap-3 text-xs text-[#C4C9D6] tabular-nums">
                  <span className="font-semibold text-white truncate">
                    {resumeTarget.codeLabel} · {cleanMediaTitle(resumeTarget.episode.title)}
                  </span>
                  {resumeTarget.remainingSec !== undefined && (
                    <span className="shrink-0">
                      {t('detail.remaining', { time: formatDuration(resumeTarget.remainingSec) })}
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full bg-[#E50914] rounded-full"
                    style={{ width: `${Math.min(100, Math.max(4, resumeTarget.progressPct))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Series Description (only real metadata — subtle shimmer while loading) */}
            {hydrated.plot ? (
              <p className="text-sm sm:text-base text-[#CFD4E0] leading-relaxed max-w-2xl line-clamp-3">
                {hydrated.plot}
              </p>
            ) : loadingSeasons ? (
              <div className="space-y-2 max-w-xl pt-1" aria-label={t('detail.loadingDetails')}>
                <div className="h-3.5 w-full rounded bg-white/[0.08] animate-pulse" />
                <div className="h-3.5 w-4/5 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ) : null}

            {/* Action Buttons (Mobile full-width primary + balanced secondary row) */}
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 pt-1">
              <button
                ref={playBtnRef}
                type="button"
                data-focusable="true"
                disabled={!resumeTarget}
                onClick={() => {
                  if (resumeTarget) {
                    onPlayEpisode(hydrated, resumeTarget.episode, resumeTarget.resumeSec);
                  }
                }}
                className="w-full sm:w-auto min-h-[46px] sm:min-h-[48px] px-6 sm:px-7 rounded-xl bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-55 disabled:cursor-not-allowed active:scale-[0.98] text-white text-sm sm:text-[15px] font-bold inline-flex items-center justify-center gap-2.5 shadow-[0_14px_34px_-10px_rgba(229,9,20,0.75)] transition-all whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {loadingSeasons && !resumeTarget ? (
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                ) : (
                  <Play className="w-4 h-4 fill-current shrink-0" />
                )}
                <span className="truncate">{primaryCtaLabel}</span>
              </button>

              {/* Trailer button ONLY if a real playable trailer exists */}
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

      {/* SERIES BODY: 1 HORIZONTAL SCROLLABLE ROW PER SEASON + CREDITS + SIMILAR + RECOMMENDED */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-10 lg:px-14 pt-2 sm:pt-4 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] space-y-10 sm:space-y-14">
        {/* DEDICATED SEASONS & EPISODES SECTION (Each Season = 1 Single Horizontal Scrollable Row) */}
        <section
          ref={seasonsSectionRef}
          id="series-seasons-section"
          className="border-t border-white/[0.08] pt-5 sm:pt-6 space-y-6 sm:space-y-8"
        >
          {/* Header + Quick Season Jump Bar */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3.5">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                {t('detail.seasonsAndEpisodes')}
              </h2>
              {loadingSeasons ? (
                <span className="inline-flex items-center gap-2 text-xs sm:text-sm text-[#9CA3B2]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#E50914]" />
                  {t('detail.loadingSeasons')}
                </span>
              ) : seasonsLabel ? (
                <p className="text-xs sm:text-sm text-[#9CA3B2] tabular-nums">
                  {seasonsLabel}
                  {totalEpisodesCount > 0 && (
                    <> · {t('detail.episodesCount', { count: totalEpisodesCount })}</>
                  )}
                </p>
              ) : null}
            </div>

            {/* Quick Season Jump Pills + Dropdown for Series With Many Seasons */}
            {loadingSeasons && hydrated.seasons.length === 0 ? (
              <div className="flex items-center gap-2 py-1" aria-hidden="true">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="h-11 w-24 rounded-xl bg-white/[0.07] animate-pulse"
                  />
                ))}
              </div>
            ) : hydrated.seasons.length > 1 ? (
              <div className="flex items-center gap-3 min-w-0">
                <div
                  role="navigation"
                  aria-label={t('detail.selectSeason')}
                  className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1 -mx-4 px-4 sm:mx-0 sm:px-0"
                >
                  {hydrated.seasons.map((s) => {
                    const active = highlightedSeasonNum === s.seasonNumber;
                    return (
                      <button
                        key={s.seasonNumber}
                        type="button"
                        data-focusable="true"
                        onClick={() => jumpToSeasonRow(s.seasonNumber)}
                        className={`min-h-[42px] px-3.5 sm:px-4 rounded-xl text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] ${
                          active
                            ? 'bg-[#E50914] text-white shadow-[0_8px_20px_-6px_rgba(229,9,20,0.65)]'
                            : 'bg-[#161923] text-[#D0D5E0] hover:text-white hover:bg-[#1E2230] border border-white/[0.12]'
                        }`}
                      >
                        <span>{getSeasonDisplayName(s.seasonNumber, s.name)}</span>
                        <span
                          className={`text-[11px] font-medium ${
                            active ? 'text-white/85' : 'text-[#8B93A7]'
                          }`}
                        >
                          ({s.episodes.length})
                        </span>
                      </button>
                    );
                  })}
                </div>

                {hydrated.seasons.length > 5 && (
                  <div className="relative shrink-0 hidden sm:block">
                    <select
                      aria-label={t('detail.selectSeason')}
                      value={highlightedSeasonNum}
                      onChange={(e) => jumpToSeasonRow(Number(e.target.value))}
                      className="min-h-[44px] appearance-none pl-3.5 pr-9 rounded-xl bg-[#161923] border border-white/[0.14] text-xs sm:text-sm font-semibold text-white focus:border-[#E50914] focus:outline-none cursor-pointer"
                    >
                      {hydrated.seasons.map((s) => (
                        <option key={s.seasonNumber} value={s.seasonNumber} className="bg-[#12141B]">
                          {getSeasonDisplayName(s.seasonNumber, s.name)} ({s.episodes.length})
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="w-4 h-4 text-[#9CA3B2] pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* All Seasons Rendered as Stacked Single-Row Horizontal Episode Rails */}
          {loadingSeasons && hydrated.seasons.length === 0 ? (
            <div className="space-y-6">
              {[0, 1].map((rowIdx) => (
                <div key={rowIdx} className="space-y-3">
                  <div className="h-5 w-32 rounded bg-white/[0.08] animate-pulse" />
                  <div className="flex flex-nowrap gap-4 overflow-hidden">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div
                        key={i}
                        className="w-[236px] sm:w-[272px] shrink-0 rounded-2xl bg-[#12141B] border border-white/[0.06] overflow-hidden"
                      >
                        <div className="aspect-video bg-white/[0.06] animate-pulse" />
                        <div className="p-3.5 space-y-2">
                          <div className="h-4 w-3/4 rounded bg-white/[0.08] animate-pulse" />
                          <div className="h-3 w-full rounded bg-white/[0.05] animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : hydrated.seasons.length > 0 ? (
            <div className="space-y-8 sm:space-y-10">
              {hydrated.seasons.map((season) => (
                <SeasonEpisodeRow
                  key={`season_row_${season.seasonNumber}`}
                  season={season}
                  seasonTitle={getSeasonDisplayName(season.seasonNumber, season.name)}
                  series={hydrated}
                  isHighlighted={highlightedSeasonNum === season.seasonNumber}
                  resumeEpisodeId={resumeTarget?.episode.id}
                  resumeMode={resumeTarget?.mode}
                  watchProgress={watchProgress}
                  isTr={isTr}
                  onPlayEpisode={onPlayEpisode}
                  registerRowRef={registerRowRef}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-[#11131B] border border-white/[0.08] px-6 py-10 text-center space-y-4">
              <p className="text-sm text-[#B8C0D0] max-w-md mx-auto">
                {loadError
                  ? t('detail.seasonsLoadError')
                  : canFetchFromXtream
                  ? t('detail.noSeasonsFound')
                  : t('detail.noEpisodes')}
              </p>
              {canFetchFromXtream && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => {
                    hydratedSeriesIds.delete(series.id);
                    setRetryNonce((n) => n + 1);
                  }}
                  className="min-h-[44px] px-5 rounded-xl bg-[#E50914] hover:bg-[#F6121D] active:scale-[0.98] text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <RefreshCw className="w-4 h-4 shrink-0" />
                  <span>{t('detail.retrySeasons')}</span>
                </button>
              )}
            </div>
          )}
        </section>

        {/* CAST & DIRECTOR (Only when real metadata exists) */}
        {hasCreditsSection && (
          <section className="border-t border-white/[0.07] pt-8 sm:pt-10 space-y-5 sm:space-y-6">
            <h2 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight">
              {t('detail.castAndCrew')}
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-10">
              {hydrated.director && (
                <dl className="lg:col-span-4 grid grid-cols-2 lg:grid-cols-1 gap-4">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                      {t('detail.director')}
                    </dt>
                    <dd className="text-sm sm:text-base font-semibold text-white mt-1">
                      {hydrated.director}
                    </dd>
                  </div>
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
                </dl>
              )}

              {castNames.length > 0 && (
                <div className={`${hydrated.director ? 'lg:col-span-8' : 'lg:col-span-12'} space-y-3`}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7D8597]">
                    {t('detail.cast')}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
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

        {/* SIMILAR SERIES */}
        {similarSeries.length > 0 && (
          <div className="border-t border-white/[0.07] pt-8 sm:pt-10">
            <DetailRail title={t('detail.similarSeries')} subtitle={hydrated.category}>
              {similarSeries.map((rel) => (
                <div
                  key={rel.id}
                  className="w-[136px] sm:w-[168px] md:w-[186px] shrink-0 snap-start"
                >
                  <MediaCard
                    title={cleanMediaTitle(rel.name)}
                    year={rel.year}
                    rating={rel.rating}
                    poster={rel.poster}
                    kind="series"
                    isFavorite={favorites.has(rel.id)}
                    onPlay={() => onSelectSeries(rel)}
                    onDetails={() => onSelectSeries(rel)}
                    onToggleFavorite={() => onToggleFavorite(rel.id)}
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
                entry.kind === 'series' ? (
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
                      onPlay={() => onSelectSeries(entry.item)}
                      onDetails={() => onSelectSeries(entry.item)}
                      onToggleFavorite={() => onToggleFavorite(entry.item.id)}
                    />
                  </div>
                ) : (
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
                      onPlay={() => onPlayMovie(entry.item, 0)}
                      onDetails={() => onSelectMovie(entry.item)}
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
