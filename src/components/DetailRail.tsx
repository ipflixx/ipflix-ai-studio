import { useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

interface DetailRailProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/**
 * Clean, horizontally scrollable cinema content rail for Similar & Recommended
 * titles inside Movie and Series Detail Pages.
 */
export function DetailRail({ title, subtitle, children }: DetailRailProps) {
  const { t } = useI18n();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const scrollByDir = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(300, Math.round(el.clientWidth * 0.78)),
      behavior: 'smooth',
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5 truncate">{subtitle}</p>
          )}
        </div>

        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => scrollByDir(-1)}
            aria-label={t('home.scrollLeft')}
            className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/[0.08] text-white/80 hover:text-white flex items-center justify-center transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollByDir(1)}
            aria-label={t('home.scrollRight')}
            className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/[0.08] text-white/80 hover:text-white flex items-center justify-center transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="flex gap-3.5 sm:gap-4 overflow-x-auto no-scrollbar pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x snap-mandatory scroll-smooth"
      >
        {children}
      </div>
    </section>
  );
}
