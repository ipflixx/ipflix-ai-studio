import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Film, Loader2, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';
import { parseTrailerSource } from '../utils/trailerParser';

interface TrailerModalProps {
  trailerUrl: string;
  title: string;
  onClose: () => void;
}

/**
 * Isolated full-screen cinematic trailer overlay.
 * Completely independent from the main IPTV VideoPlayer engine.
 * Closing returns the user directly to the underlying Detail Page.
 */
export function TrailerModal({ trailerUrl, title, onClose }: TrailerModalProps) {
  const { t } = useI18n();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const parsed = parseTrailerSource(trailerUrl);
  const displayTitle = cleanMediaTitle(title);

  const [iframeReady, setIframeReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setIframeReady(false);
    setVideoFailed(false);
  }, [trailerUrl]);

  // Move focus inside trailer overlay so Android TV remote & keyboard interact cleanly
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  if (!parsed) return null;

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`${displayTitle} — ${t('detail.trailerTitle')}`}
      data-focus-scope="active"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onClick={onClose}
      className="fixed inset-0 z-[60] bg-[#040508]/94 backdrop-blur-xl flex flex-col justify-between p-4 sm:p-8"
    >
      {/* Top Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl mx-auto flex items-center justify-between gap-4 pb-3"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.1] text-[#E50914] flex items-center justify-center shrink-0">
            <Film className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9CA3B2]">
              {t('detail.trailerTitle')}
            </p>
            <h2 className="font-display text-base sm:text-xl font-bold text-white truncate">
              {displayTitle}
            </h2>
          </div>
        </div>

        <button
          ref={closeBtnRef}
          type="button"
          data-focusable="true"
          onClick={onClose}
          aria-label={t('common.close')}
          className="min-h-[44px] px-4 rounded-xl bg-white/[0.09] hover:bg-white/[0.18] border border-white/[0.14] text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914]"
        >
          <X className="w-4 h-4" />
          <span className="hidden sm:inline">{t('common.close')}</span>
        </button>
      </div>

      {/* Centered 16:9 Cinema Frame */}
      <div className="flex-1 flex items-center justify-center py-2">
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-5xl aspect-video rounded-2xl overflow-hidden bg-black border border-white/[0.12] shadow-[0_32px_90px_rgba(0,0,0,0.85)]"
        >
          {parsed.kind === 'video' ? (
            videoFailed ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-[#0D0F16]">
                <AlertCircle className="w-9 h-9 text-[#E50914]" />
                <p className="text-sm sm:text-base font-medium text-white">
                  {t('detail.trailerLoadError')}
                </p>
                <button
                  type="button"
                  data-focusable="true"
                  onClick={onClose}
                  className="min-h-[44px] px-5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-semibold transition-colors"
                >
                  {t('common.back')}
                </button>
              </div>
            ) : (
              <video
                src={parsed.src}
                controls
                autoPlay
                playsInline
                onError={() => setVideoFailed(true)}
                className="w-full h-full object-contain bg-black"
              />
            )
          ) : (
            <>
              {!iframeReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#08090D] pointer-events-none">
                  <Loader2 className="w-8 h-8 text-[#E50914] animate-spin" />
                </div>
              )}
              <iframe
                src={parsed.embedUrl}
                title={`${displayTitle} ${t('detail.trailerTitle')}`}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => setIframeReady(true)}
                className="w-full h-full border-0"
              />
            </>
          )}
        </motion.div>
      </div>

      {/* Bottom Balance Spacer */}
      <div className="h-2 sm:h-4" aria-hidden="true" />
    </motion.div>
  );
}
