import { useId } from 'react';

interface BrandMarkProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  compact?: boolean;
  showSheen?: boolean;
  className?: string;
}

export function BrandMark({
  size = 'md',
  compact = false,
  showSheen = false,
  className = '',
}: BrandMarkProps) {
  const uid = useId().replace(/:/g, '');

  const iconDims =
    size === 'sm'
      ? 'w-7 h-7'
      : size === 'lg'
      ? 'w-10 h-10 sm:w-11 sm:h-11'
      : size === 'xl'
      ? 'w-14 h-14 sm:w-16 sm:h-16'
      : 'w-8 h-8';

  const textClass =
    size === 'sm'
      ? 'text-[18px] tracking-[0.07em]'
      : size === 'lg'
      ? 'text-[28px] sm:text-[34px] tracking-[0.08em]'
      : size === 'xl'
      ? 'text-[40px] sm:text-[54px] tracking-[0.09em]'
      : 'text-[21px] tracking-[0.07em]';

  const gapClass =
    size === 'xl' ? 'gap-3.5 sm:gap-4' : size === 'lg' ? 'gap-3' : 'gap-2.5';

  return (
    <span
      className={`relative inline-flex items-center ${gapClass} whitespace-nowrap shrink-0 select-none overflow-hidden rounded-xl ${className}`}
    >
      {/* Minimal Cinematic IPFLIX Monolith + Prism App Symbol */}
      <svg
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${iconDims} shrink-0 drop-shadow-[0_4px_14px_rgba(229,9,20,0.22)]`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={`ipf-bg-${uid}`}
            x1="4"
            y1="2"
            x2="36"
            y2="38"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#1A1D28" />
            <stop offset="58%" stopColor="#10121A" />
            <stop offset="100%" stopColor="#08090D" />
          </linearGradient>
          <linearGradient
            id={`ipf-red-${uid}`}
            x1="9"
            y1="8"
            x2="14"
            y2="32"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#FF2A35" />
            <stop offset="52%" stopColor="#E50914" />
            <stop offset="100%" stopColor="#B8060F" />
          </linearGradient>
          <linearGradient
            id={`ipf-prism-${uid}`}
            x1="17"
            y1="9"
            x2="32"
            y2="31"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="76%" stopColor="#F1F4FA" />
            <stop offset="100%" stopColor="#CFD7E6" />
          </linearGradient>
        </defs>

        {/* Obsidian-Charcoal App Tile with Subtle Specular Rim */}
        <rect x="1" y="1" width="38" height="38" rx="9.5" fill={`url(#ipf-bg-${uid})`} />
        <rect
          x="1.5"
          y="1.5"
          width="37"
          height="37"
          rx="9"
          stroke="#FFFFFF"
          strokeOpacity="0.13"
          strokeWidth="1"
        />

        {/* Crimson Signal Pillar ("I") */}
        <rect x="9.5" y="9" width="4.6" height="22" rx="1.6" fill={`url(#ipf-red-${uid})`} />

        {/* Forward Cinema Play Prism */}
        <path
          d="M17 10.6C17 9.35 18.35 8.58 19.42 9.21L30.92 15.96C31.95 16.56 32.58 17.66 32.58 18.85V21.15C32.58 22.34 31.95 23.44 30.92 24.04L19.42 30.79C18.35 31.42 17 30.65 17 29.4V10.6Z"
          fill={`url(#ipf-prism-${uid})`}
        />

        {/* Subtle Crimson Kinetic Bevel Cut */}
        <path d="M17 24.7L27.4 20L17 28.6V24.7Z" fill="#E50914" />
      </svg>

      {!compact && (
        <span
          className={`font-display font-extrabold leading-none text-[#F5F7FA] ${textClass}`}
        >
          IP<span className="text-[#E50914]">FLIX</span>
        </span>
      )}

      {/* Optional GPU-composited metallic light sheen sweep for Splash Screen */}
      {showSheen && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-[-25%] left-0 w-1/2 ipflix-sheen-sweep bg-gradient-to-r from-transparent via-white/45 to-transparent"
        />
      )}
    </span>
  );
}
