import type { ProfileAvatarId } from '../types/iptv';

export interface AvatarPreset {
  id: ProfileAvatarId;
  labelTr: string;
  labelEn: string;
  gradient: string;
  accent: string;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: 'crimson',
    labelTr: 'Kızıl Sinema',
    labelEn: 'Crimson',
    gradient: 'from-[#E50914] via-[#B80710] to-[#6B0409]',
    accent: '#E50914',
  },
  {
    id: 'cobalt',
    labelTr: 'Gece Mavisi',
    labelEn: 'Cobalt',
    gradient: 'from-[#2563EB] via-[#1D4ED8] to-[#1E3A8A]',
    accent: '#3B82F6',
  },
  {
    id: 'emerald',
    labelTr: 'Zümrüt',
    labelEn: 'Emerald',
    gradient: 'from-[#10B981] via-[#059669] to-[#065F46]',
    accent: '#10B981',
  },
  {
    id: 'amber',
    labelTr: 'Altın Kehribar',
    labelEn: 'Amber',
    gradient: 'from-[#F59E0B] via-[#D97706] to-[#92400E]',
    accent: '#F59E0B',
  },
  {
    id: 'violet',
    labelTr: 'Mor Galaksi',
    labelEn: 'Violet',
    gradient: 'from-[#8B5CF6] via-[#7C3AED] to-[#4C1D95]',
    accent: '#8B5CF6',
  },
  {
    id: 'coral',
    labelTr: 'Mercan',
    labelEn: 'Coral',
    gradient: 'from-[#F43F5E] via-[#E11D48] to-[#881337]',
    accent: '#F43F5E',
  },
  {
    id: 'teal',
    labelTr: 'Okyanus',
    labelEn: 'Ocean',
    gradient: 'from-[#06B6D4] via-[#0891B2] to-[#155E75]',
    accent: '#06B6D4',
  },
  {
    id: 'kids',
    labelTr: 'Çocuklar',
    labelEn: 'Kids',
    gradient: 'from-[#FACC15] via-[#F97316] to-[#EC4899]',
    accent: '#F97316',
  },
];

interface ProfileAvatarProps {
  avatarId: ProfileAvatarId;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<ProfileAvatarProps['size']>, string> = {
  xs: 'w-7 h-7 rounded-md',
  sm: 'w-8 h-8 rounded-md',
  md: 'w-11 h-11 rounded-lg',
  lg: 'w-24 h-24 sm:w-28 sm:h-28 rounded-xl',
  xl: 'w-28 h-28 sm:w-36 sm:h-36 rounded-xl',
};

function AvatarFaceSvg({ avatarId }: { avatarId: ProfileAvatarId }) {
  switch (avatarId) {
    case 'crimson':
      // Classic Netflix-inspired confident smile
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <circle cx="32" cy="40" r="6.5" fill="#FFFFFF" />
          <circle cx="68" cy="40" r="6.5" fill="#FFFFFF" />
          <path
            d="M28 60 C38 74, 62 74, 72 60"
            stroke="#FFFFFF"
            strokeWidth="6.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'cobalt':
      // Cool geometric glasses character
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <rect x="18" y="31" width="26" height="18" rx="6" stroke="#FFFFFF" strokeWidth="5" fill="rgba(255,255,255,0.16)" />
          <rect x="56" y="31" width="26" height="18" rx="6" stroke="#FFFFFF" strokeWidth="5" fill="rgba(255,255,255,0.16)" />
          <line x1="44" y1="40" x2="56" y2="40" stroke="#FFFFFF" strokeWidth="5" />
          <path
            d="M34 65 C43 72, 57 72, 66 65"
            stroke="#FFFFFF"
            strokeWidth="5.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'emerald':
      // Friendly wink character
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <circle cx="32" cy="40" r="6.5" fill="#FFFFFF" />
          <path
            d="M60 40 Q68 32 76 40"
            stroke="#FFFFFF"
            strokeWidth="5.5"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M30 61 Q50 76 70 61"
            stroke="#FFFFFF"
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'amber':
      // Cinema crown / VIP character
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <path
            d="M24 34 L34 20 L50 31 L66 20 L76 34 Z"
            fill="rgba(255,255,255,0.9)"
          />
          <circle cx="34" cy="49" r="5.5" fill="#FFFFFF" />
          <circle cx="66" cy="49" r="5.5" fill="#FFFFFF" />
          <path
            d="M35 67 Q50 76 65 67"
            stroke="#FFFFFF"
            strokeWidth="5.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'violet':
      // Cosmic / Astro character
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <rect x="20" y="28" width="60" height="32" rx="16" fill="rgba(10,12,20,0.45)" stroke="#FFFFFF" strokeWidth="4.5" />
          <circle cx="37" cy="44" r="5" fill="#FFFFFF" />
          <circle cx="63" cy="44" r="5" fill="#FFFFFF" />
          <path
            d="M38 71 Q50 77 62 71"
            stroke="#FFFFFF"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'coral':
      // Playful cat-ear silhouette
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <path d="M22 33 L28 16 L40 27 Z" fill="rgba(255,255,255,0.88)" />
          <path d="M78 33 L72 16 L60 27 Z" fill="rgba(255,255,255,0.88)" />
          <circle cx="34" cy="48" r="6" fill="#FFFFFF" />
          <circle cx="66" cy="48" r="6" fill="#FFFFFF" />
          <path
            d="M44 61 Q50 67 56 61"
            stroke="#FFFFFF"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'teal':
      // Minimalist robotic / sci-fi character
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <line x1="50" y1="16" x2="50" y2="27" stroke="#FFFFFF" strokeWidth="4.5" strokeLinecap="round" />
          <circle cx="50" cy="15" r="4.5" fill="#FFFFFF" />
          <rect x="26" y="34" width="16" height="12" rx="4" fill="#FFFFFF" />
          <rect x="58" y="34" width="16" height="12" rx="4" fill="#FFFFFF" />
          <rect x="31" y="61" width="38" height="8" rx="4" fill="rgba(255,255,255,0.9)" />
        </svg>
      );
    case 'kids':
    default:
      // Cheerful Star / Kids badge
      return (
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
          <path
            d="M50 16 L58 36 L80 38 L63 52 L68 74 L50 62 L32 74 L37 52 L20 38 L42 36 Z"
            fill="rgba(255,255,255,0.94)"
          />
          <circle cx="43" cy="45" r="3.4" fill="#EA580C" />
          <circle cx="57" cy="45" r="3.4" fill="#EA580C" />
          <path
            d="M43 54 Q50 60 57 54"
            stroke="#EA580C"
            strokeWidth="3.2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
  }
}

export function ProfileAvatar({
  avatarId,
  name,
  size = 'md',
  className = '',
}: ProfileAvatarProps) {
  const preset = AVATAR_PRESETS.find((p) => p.id === avatarId) || AVATAR_PRESETS[0];

  return (
    <div
      aria-label={name || preset.labelTr}
      className={`relative shrink-0 overflow-hidden bg-gradient-to-br ${preset.gradient} select-none shadow-md shadow-black/40 ${SIZE_CLASSES[size]} ${className}`}
    >
      {/* Subtle top specular sheen */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/25" />
      <AvatarFaceSvg avatarId={preset.id} />
    </div>
  );
}
