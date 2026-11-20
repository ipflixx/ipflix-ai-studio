import { memo, useEffect, useState } from 'react';
import { Clapperboard, Film, Heart, Info, Play, Tv } from 'lucide-react';
import { buildProxiedImageUrl } from '../services/iptvApi';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';

// Bounded in-memory image resolution cache to keep scrolling fast and avoid repeat broken fetches
const MAX_IMAGE_CACHE = 2500;
const imageStatusCache = new Map<string, 'ok' | 'err'>();

function setImageStatus(url: string, status: 'ok' | 'err') {
  if (imageStatusCache.size >= MAX_IMAGE_CACHE) {
    const oldestKey = imageStatusCache.keys().next().value;
    if (oldestKey) imageStatusCache.delete(oldestKey);
  }
  imageStatusCache.set(url, status);
}

interface ResilientImageProps {
  src?: string;
  alt: string;
  className?: string;
  fallbackTitle?: string;
  fallbackKind?: 'movie' | 'series' | 'channel';
  priority?: boolean;
}

export const ResilientImage = memo(function ResilientImage({
  src,
  alt,
  className = 'w-full h-full object-cover',
  fallbackTitle,
  fallbackKind = 'movie',
  priority = false,
}: ResilientImageProps) {
  const { t } = useI18n();
  const resolved = buildProxiedImageUrl(src);
  const cached = resolved ? imageStatusCache.get(resolved) : undefined;

  const [failed, setFailed] = useState<boolean>(() => cached === 'err');
  const [loaded, setLoaded] = useState<boolean>(() => cached === 'ok');

  useEffect(() => {
    if (!resolved) {
      setFailed(true);
      setLoaded(false);
      return;
    }
    const nextCached = imageStatusCache.get(resolved);
    setFailed(nextCached === 'err');
    setLoaded(nextCached === 'ok');
  }, [resolved]);

  if (!resolved || failed) {
    const label =
      fallbackKind === 'channel'
        ? t('home.fallbackChannel')
        : fallbackKind === 'series'
        ? t('home.fallbackSeries')
        : t('home.fallbackMovie');

    const initials = (fallbackTitle || alt || 'IP')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');

    return (
      <div
        className={`relative flex flex-col items-center justify-center bg-gradient-to-br from-[#1B202D] via-[#12151E] to-[#0A0B10] text-white/65 select-none p-4 text-center overflow-hidden ${className}`}
        aria-label={alt}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#E50914]/55 to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(229,9,20,0.09),transparent_65%)]"
        />
        <div className="relative z-10 flex flex-col items-center gap-2 max-w-full">
          <span className="w-10 h-10 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-white/55">
            {fallbackKind === 'channel' ? (
              <Tv className="w-5 h-5" />
            ) : fallbackKind === 'series' ? (
              <Clapperboard className="w-5 h-5" />
            ) : (
              <Film className="w-5 h-5" />
            )}
          </span>
          <span className="font-display font-bold text-sm tracking-tight text-white/88 line-clamp-2 leading-snug">
            {fallbackTitle || initials}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
            {label}
          </span>
        </div>
      </div>
    );
  }

  return (
    <img
      src={resolved}
      alt={alt}
      referrerPolicy="no-referrer"
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
      onLoad={() => {
        setImageStatus(resolved, 'ok');
        setLoaded(true);
      }}
      onError={() => {
        setImageStatus(resolved, 'err');
        setFailed(true);
      }}
      className={`${className} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  );
});

interface MediaCardProps {
  title: string;
  subtitle?: string;
  year?: string;
  category?: string;
  rating?: number;
  poster?: string;
  aspect?: 'poster' | 'landscape';
  progressPct?: number;
  isFavorite?: boolean;
  kind?: 'movie' | 'series' | 'channel';
  onPlay: () => void;
  onDetails?: () => void;
  onToggleFavorite?: () => void;
}

export const MediaCard = memo(function MediaCard({
  title,
  subtitle,
  year,
  category,
  rating,
  poster,
  aspect = 'poster',
  progressPct,
  isFavorite,
  kind = 'movie',
  onPlay,
  onDetails,
  onToggleFavorite,
}: MediaCardProps) {
  const { t } = useI18n();
  const displayTitle = cleanMediaTitle(title);
  const metaParts: string[] = [];
  if (year) metaParts.push(year);
  if (rating && rating > 0) metaParts.push(`★ ${rating.toFixed(1)}`);
  if (category) metaParts.push(category);

  const aspectClass = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]';
  const primaryAction = onDetails || onPlay;

  return (
    <article className="ipflix-card-surface group relative flex flex-col rounded-xl bg-[#12141B] border border-white/[0.06] overflow-hidden transition-transform duration-200 ease-out hover:scale-[1.035] hover:z-10 hover:border-white/20 focus-within:scale-[1.035] focus-within:z-20 focus-within:border-[#E50914] focus-within:ring-2 focus-within:ring-[#E50914] focus-within:shadow-[0_14px_34px_-10px_rgba(229,9,20,0.45)] shadow-lg shadow-black/45">
      <div
        role="button"
        tabIndex={0}
        data-focusable="true"
        onClick={primaryAction}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            primaryAction();
          }
        }}
        className={`relative w-full ${aspectClass} overflow-hidden bg-[#181B24] focus:outline-none`}
      >
        <ResilientImage
          src={poster}
          alt={displayTitle}
          fallbackTitle={displayTitle}
          fallbackKind={kind}
          className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
        />

        {/* Subtle bottom scrim on hover/focus with quick action controls */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#08090D]/92 via-[#08090D]/25 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 flex items-end justify-between p-3 gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onPlay();
              }}
              aria-label={`${t('common.play')} ${displayTitle}`}
              className="w-9 h-9 rounded-full bg-[#E50914] hover:bg-[#F6121D] active:scale-95 text-white flex items-center justify-center transition-transform shadow-md"
            >
              <Play className="w-4 h-4 fill-current ml-0.5" />
            </button>
            {onDetails && (
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onDetails();
                }}
                aria-label={`${t('common.details')} ${displayTitle}`}
                className="w-9 h-9 rounded-full bg-black/75 hover:bg-black/95 active:scale-95 border border-white/20 text-white flex items-center justify-center transition-transform"
              >
                <Info className="w-4 h-4" />
              </button>
            )}
          </div>
          {onToggleFavorite && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              aria-label={isFavorite ? t('common.removeFavorite') : t('common.favoriteAdd')}
              className={`w-9 h-9 rounded-full border flex items-center justify-center transition-transform active:scale-95 ${
                isFavorite
                  ? 'bg-[#E50914]/20 border-[#E50914] text-[#E50914]'
                  : 'bg-black/75 border-white/20 text-white/85 hover:text-white'
              }`}
            >
              <Heart className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          )}
        </div>

        {/* Watch progress bar */}
        {typeof progressPct === 'number' && progressPct > 1 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-white/20">
            <div
              className="h-full bg-[#E50914]"
              style={{ width: `${Math.min(100, Math.max(2, progressPct))}%` }}
            />
          </div>
        )}
      </div>

      {/* Clean unboxed title & metadata */}
      <div
        onClick={primaryAction}
        className="p-3 flex flex-col gap-0.5 min-w-0 cursor-pointer"
      >
        <h3 className="text-[13.5px] font-semibold text-white truncate leading-snug">
          {displayTitle}
        </h3>
        {subtitle ? (
          <p className="text-xs text-[#9CA3B2] truncate tabular-nums">{subtitle}</p>
        ) : metaParts.length > 0 ? (
          <p className="text-xs text-[#9CA3B2] truncate tabular-nums">
            {metaParts.join(' · ')}
          </p>
        ) : null}
      </div>
    </article>
  );
});
