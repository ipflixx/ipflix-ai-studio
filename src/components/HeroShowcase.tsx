import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  Info,
  Play,
  Plus,
} from 'lucide-react';
import type { LiveChannel, MovieItem, SeriesItem } from '../types/iptv';
import { ASSETS } from '../data/openSourceCatalog';
import { ResilientImage } from './MediaArtwork';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';

export type HeroCandidate =
  | { kind: 'movie'; item: MovieItem }
  | { kind: 'series'; item: SeriesItem }
  | { kind: 'channel'; item: LiveChannel };

interface HeroShowcaseProps {
  movies: MovieItem[];
  series: SeriesItem[];
  channels: LiveChannel[];
  favorites: Set<string>;
  profileSeed?: string;
  onPlayMovie: (movie: MovieItem) => void;
  onPlaySeriesDirect: (series: SeriesItem) => void;
  onPlayChannel: (channel: LiveChannel) => void;
  onOpenMovieDetail: (movie: MovieItem) => void;
  onOpenSeriesDetail: (series: SeriesItem) => void;
  onToggleFavorite: (id: string) => void;
  onOpenAddPlaylist: () => void;
}

const ROTATION_INTERVAL_MS = 9000;
const HERO_SESSION_KEY = 'ipflix_hero_rotation_counter_v1';

function getNextSessionOffset(): number {
  try {
    const raw = window.sessionStorage.getItem(HERO_SESSION_KEY);
    const prev = raw ? Number(raw) : -1;
    const next = Number.isFinite(prev) ? (prev + 1) % 1000 : 0;
    window.sessionStorage.setItem(HERO_SESSION_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function scoreMediaForHero(item: {
  backdrop?: string;
  poster?: string;
  plot?: string;
  rating?: number;
  year?: string;
}): number {
  let score = 0;
  if (item.backdrop) score += 50;
  if (item.poster) score += 25;
  if (item.plot && item.plot.trim().length > 20) score += 20;
  if (item.rating && item.rating > 0) score += Math.min(item.rating, 10) * 2.5;
  const yr = Number(item.year || 0);
  if (yr >= 2020) score += 8;
  return score;
}

export function HeroShowcase({
  movies,
  series,
  channels,
  favorites,
  profileSeed = '',
  onPlayMovie,
  onPlaySeriesDirect,
  onPlayChannel,
  onOpenMovieDetail,
  onOpenSeriesDetail,
  onToggleFavorite,
  onOpenAddPlaylist,
}: HeroShowcaseProps) {
  const { t } = useI18n();
  const [sessionOffset] = useState<number>(() => getNextSessionOffset());
  const [paused, setPaused] = useState(false);

  // Curate up to 6 diverse real featured items (interleaving top movies & series)
  const heroPool = useMemo<HeroCandidate[]>(() => {
    const rankedMovies = [...movies]
      .sort((a, b) => scoreMediaForHero(b) - scoreMediaForHero(a))
      .slice(0, 12);
    const rankedSeries = [...series]
      .sort((a, b) => scoreMediaForHero(b) - scoreMediaForHero(a))
      .slice(0, 12);

    const combined: HeroCandidate[] = [];
    const maxPairs = Math.max(rankedMovies.length, rankedSeries.length);
    for (let i = 0; i < maxPairs && combined.length < 12; i++) {
      if (rankedMovies[i]) combined.push({ kind: 'movie', item: rankedMovies[i] });
      if (rankedSeries[i]) combined.push({ kind: 'series', item: rankedSeries[i] });
    }

    if (combined.length > 0) {
      // Shift window deterministically per session/profile so the first hero card rotates cleanly
      const startShift = (sessionOffset + hashSeed(profileSeed)) % combined.length;
      const rotated = [...combined.slice(startShift), ...combined.slice(0, startShift)];
      return rotated.slice(0, 6);
    }

    if (channels.length > 0) {
      return channels.slice(0, 4).map((ch) => ({ kind: 'channel', item: ch }));
    }

    return [];
  }, [movies, series, channels, profileSeed, sessionOffset]);

  const [activeIndex, setActiveIndex] = useState(0);

  // Keep index valid when catalog or profile changes
  useEffect(() => {
    setActiveIndex(0);
  }, [heroPool.length, profileSeed]);

  // Controlled gentle rotation that pauses while hovering or focusing controls
  useEffect(() => {
    if (heroPool.length <= 1 || paused) return;
    const id = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % heroPool.length);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [heroPool.length, paused]);

  const activeHero = heroPool[activeIndex] || null;

  const goPrev = () => {
    if (heroPool.length <= 1) return;
    setActiveIndex((prev) => (prev - 1 + heroPool.length) % heroPool.length);
  };

  const goNext = () => {
    if (heroPool.length <= 1) return;
    setActiveIndex((prev) => (prev + 1) % heroPool.length);
  };

  const heroTitle = activeHero ? cleanMediaTitle(activeHero.item.name) : 'IPFLIX';

  const heroBackdrop =
    activeHero?.kind === 'movie'
      ? activeHero.item.backdrop || activeHero.item.poster || ASSETS.heroBackdrop
      : activeHero?.kind === 'series'
      ? activeHero.item.backdrop || activeHero.item.poster || ASSETS.heroBackdrop
      : activeHero?.kind === 'channel'
      ? activeHero.item.logo || ASSETS.heroBackdrop
      : ASSETS.heroBackdrop;

  const heroDescription =
    activeHero?.kind === 'movie'
      ? activeHero.item.plot || t('home.heroMovieFallback', { title: heroTitle })
      : activeHero?.kind === 'series'
      ? activeHero.item.plot || t('home.heroSeriesFallback', { title: heroTitle })
      : t('home.emptyDesc');

  const heroMetaParts: string[] = [];
  if (activeHero?.kind === 'movie') {
    heroMetaParts.push(t('home.heroMovie'));
    if (activeHero.item.genre || activeHero.item.category) {
      heroMetaParts.push(activeHero.item.genre || activeHero.item.category);
    }
    if (activeHero.item.year) heroMetaParts.push(activeHero.item.year);
    if (activeHero.item.rating && activeHero.item.rating > 0) {
      heroMetaParts.push(`★ ${activeHero.item.rating.toFixed(1)}`);
    }
    if (activeHero.item.duration) heroMetaParts.push(activeHero.item.duration);
  } else if (activeHero?.kind === 'series') {
    heroMetaParts.push(t('home.heroSeries'));
    if (activeHero.item.genre || activeHero.item.category) {
      heroMetaParts.push(activeHero.item.genre || activeHero.item.category);
    }
    if (activeHero.item.year) heroMetaParts.push(activeHero.item.year);
    if (activeHero.item.rating && activeHero.item.rating > 0) {
      heroMetaParts.push(`★ ${activeHero.item.rating.toFixed(1)}`);
    }
    if (activeHero.item.seasons.length > 0) {
      heroMetaParts.push(`${activeHero.item.seasons.length} ${t('common.seasons')}`);
    }
  } else if (activeHero?.kind === 'channel') {
    heroMetaParts.push(t('home.heroLiveNow'));
    if (activeHero.item.category) heroMetaParts.push(activeHero.item.category);
  }

  const heroFavId = activeHero ? activeHero.item.id : '';
  const heroIsFav = heroFavId ? favorites.has(heroFavId) : false;
  const heroKey = activeHero ? `${activeHero.kind}_${activeHero.item.id}` : 'empty';

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
      className="relative w-full min-h-[400px] sm:min-h-[520px] lg:min-h-[590px] xl:min-h-[640px] [@media(max-height:500px)]:min-h-[300px] flex items-end overflow-hidden bg-[#08090D]"
    >
      {/* Smooth crossfading cinematic backdrop */}
      <div className="absolute inset-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={heroKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            className="absolute inset-0"
          >
            <ResilientImage
              src={heroBackdrop}
              alt={heroTitle}
              fallbackTitle={heroTitle}
              fallbackKind={activeHero?.kind || 'movie'}
              priority
              className="w-full h-full object-cover object-[50%_24%]"
            />
          </motion.div>
        </AnimatePresence>

        {/* Precision editorial scrims for razor-sharp typography legibility */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#08090D] via-[#08090D]/72 to-transparent" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#08090D] via-[#08090D]/40 to-[#08090D]/25" />
      </div>

      {/* Foreground Content + Rotation Controls */}
      <div className="relative z-10 w-full px-4 sm:px-8 lg:px-12 xl:px-14 pb-8 sm:pb-14 lg:pb-16 pt-16 sm:pt-24 flex flex-col lg:flex-row lg:items-end justify-between gap-6 sm:gap-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={heroKey}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.32, ease: 'easeOut' }}
            className="w-full max-w-2xl xl:max-w-3xl space-y-3 sm:space-y-4"
          >
            {heroMetaParts.length > 0 && (
              <p className="text-xs sm:text-sm font-medium text-white/80 tracking-wide tabular-nums line-clamp-1">
                {heroMetaParts.join(' · ')}
              </p>
            )}

            <h1 className="font-display text-[26px] sm:text-5xl lg:text-[56px] xl:text-[62px] font-extrabold text-white tracking-tight leading-[1.06] [text-wrap:balance] line-clamp-2">
              {heroTitle}
            </h1>

            <p className="text-[13px] sm:text-[15.5px] lg:text-base text-[#D0D5DF] max-w-xl xl:max-w-2xl leading-relaxed line-clamp-2 sm:line-clamp-3">
              {heroDescription}
            </p>

            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 pt-1.5">
              {activeHero ? (
                <>
                  <button
                    type="button"
                    data-focusable="true"
                    onClick={() => {
                      if (activeHero.kind === 'movie') onPlayMovie(activeHero.item);
                      else if (activeHero.kind === 'series') onPlaySeriesDirect(activeHero.item);
                      else onPlayChannel(activeHero.item);
                    }}
                    className="min-h-[44px] px-5 sm:px-6 py-2.5 sm:py-3 rounded-lg bg-[#E50914] hover:bg-[#F6121D] active:scale-[0.98] text-white text-sm font-bold inline-flex items-center justify-center gap-2 transition-all shadow-lg shadow-[#E50914]/25 whitespace-nowrap"
                  >
                    <Play className="w-4 h-4 fill-current shrink-0" />
                    <span>{t('home.watchNow')}</span>
                  </button>

                  {activeHero.kind !== 'channel' && (
                    <button
                      type="button"
                      data-focusable="true"
                      onClick={() => {
                        if (activeHero.kind === 'movie') onOpenMovieDetail(activeHero.item);
                        else onOpenSeriesDetail(activeHero.item);
                      }}
                      className="min-h-[44px] px-4 sm:px-5 py-2.5 sm:py-3 rounded-lg bg-white/[0.12] hover:bg-white/[0.2] active:scale-[0.98] backdrop-blur-md text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-all whitespace-nowrap"
                    >
                      <Info className="w-4 h-4 shrink-0" />
                      <span>{t('common.details')}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-focusable="true"
                    onClick={() => onToggleFavorite(activeHero.item.id)}
                    aria-label={heroIsFav ? t('common.removeFavorite') : t('common.favoriteAdd')}
                    className={`min-h-[44px] min-w-[44px] px-3.5 sm:px-4 py-2.5 sm:py-3 rounded-lg border text-sm font-medium inline-flex items-center justify-center gap-2 transition-all active:scale-[0.98] whitespace-nowrap ${
                      heroIsFav
                        ? 'bg-[#E50914]/15 border-[#E50914] text-white'
                        : 'bg-black/45 border-white/20 text-white/85 hover:bg-white/10'
                    }`}
                  >
                    <Heart
                      className={`w-4 h-4 shrink-0 ${heroIsFav ? 'fill-[#E50914] text-[#E50914]' : ''}`}
                    />
                    <span className="hidden sm:inline">
                      {heroIsFav ? t('common.favoriteAdded') : t('common.favoriteAdd')}
                    </span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={onOpenAddPlaylist}
                  className="min-h-[44px] px-6 py-3 rounded-lg bg-[#E50914] hover:bg-[#F6121D] active:scale-[0.98] text-white text-sm font-bold inline-flex items-center gap-2.5 transition-all"
                >
                  <Plus className="w-4 h-4" />
                  {t('home.connectSource')}
                </button>
              )}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Subtle Hero Rotation Controls */}
        {heroPool.length > 1 && (
          <div className="flex items-center justify-between lg:justify-end gap-3 w-full lg:w-auto shrink-0">
            <div className="flex items-center gap-1.5" role="tablist" aria-label={t('home.heroFeatured')}>
              {heroPool.map((entry, idx) => {
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={`${entry.kind}_${entry.item.id}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={t('home.heroSlide', { num: idx + 1 })}
                    onClick={() => setActiveIndex(idx)}
                    className="py-2 px-0.5 flex items-center"
                  >
                    <span
                      className={`block h-1 rounded-full transition-all duration-300 ${
                        isActive
                          ? 'w-7 bg-[#E50914]'
                          : 'w-2.5 bg-white/30 hover:bg-white/60'
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={goPrev}
                aria-label={t('home.heroPrev')}
                className="w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-black/55 hover:bg-black/80 border border-white/15 hover:border-white/35 text-white/85 hover:text-white flex items-center justify-center transition-colors active:scale-95"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={goNext}
                aria-label={t('home.heroNext')}
                className="w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-black/55 hover:bg-black/80 border border-white/15 hover:border-white/35 text-white/85 hover:text-white flex items-center justify-center transition-colors active:scale-95"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
