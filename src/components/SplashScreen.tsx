import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { BrandMark } from './BrandMark';
import { useI18n } from '../i18n/I18nContext';
import { playIntroSound, type IntroAudioHandle } from '../utils/introAudio';

interface SplashScreenProps {
  ready: boolean;
  introSoundEnabled?: boolean;
  onComplete: () => void;
}

// Total cinematic launch sequence duration (~3.45s, within 3–4s target)
const CINEMATIC_DURATION_MS = 3350;
const REDUCED_MOTION_DURATION_MS = 650;
const EXIT_FADE_MS = 420;
const AUDIO_CUE_MS = 280;

export function SplashScreen({
  ready,
  introSoundEnabled = true,
  onComplete,
}: SplashScreenProps) {
  const { t } = useI18n();
  const [animationDone, setAnimationDone] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const audioHandleRef = useRef<IntroAudioHandle | null>(null);
  const completedRef = useRef(false);

  // Detect prefers-reduced-motion on client
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Synchronized original IPFLIX intro sound (respects user toggle & autoplay policies)
  useEffect(() => {
    if (!introSoundEnabled) return;
    const cueTimer = window.setTimeout(() => {
      audioHandleRef.current = playIntroSound({ volume: 0.72 });
    }, AUDIO_CUE_MS);

    return () => {
      window.clearTimeout(cueTimer);
      audioHandleRef.current?.stop();
      audioHandleRef.current = null;
    };
  }, [introSoundEnabled]);

  // Ensure the full cinematic sequence completes before allowing transition to Profile Gate
  useEffect(() => {
    const duration = reducedMotion ? REDUCED_MOTION_DURATION_MS : CINEMATIC_DURATION_MS;
    const doneTimer = window.setTimeout(() => {
      setAnimationDone(true);
    }, duration);

    return () => window.clearTimeout(doneTimer);
  }, [reducedMotion]);

  // Smooth fade-out transition only AFTER animation finishes AND app bootstrap is ready
  useEffect(() => {
    if (!ready || !animationDone || completedRef.current) return;
    completedRef.current = true;
    setExiting(true);

    const exitTimer = window.setTimeout(() => {
      onComplete();
    }, reducedMotion ? 120 : EXIT_FADE_MS);

    return () => window.clearTimeout(exitTimer);
  }, [ready, animationDone, reducedMotion, onComplete]);

  // If browser/Android WebView gated autoplay, a tap gently unlocks the intro audio without cutting the animation
  const handleStageTap = () => {
    if (introSoundEnabled && audioHandleRef.current) {
      void audioHandleRef.current.unlockAndPlay();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 1 }}
      animate={exiting ? { opacity: 0, scale: 1.02 } : { opacity: 1, scale: 1 }}
      transition={{ duration: reducedMotion ? 0.12 : 0.42, ease: [0.22, 1, 0.36, 1] }}
      onClick={handleStageTap}
      className="fixed inset-0 z-[100] bg-[#040507] flex flex-col items-center justify-center px-6 safe-area-top safe-area-bottom select-none overflow-hidden"
      role="status"
      aria-live="polite"
      aria-label="IPFLIX"
    >
      {/* Stage 2: Soft crimson studio glow blooming gently from pure black */}
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0, scale: 0.78 }}
        animate={{ opacity: [0, 0.95, 0.65], scale: [0.78, 1.06, 1] }}
        transition={{
          duration: 2.5,
          delay: 0.22,
          times: [0, 0.55, 1],
          ease: [0.22, 1, 0.36, 1],
        }}
        className="pointer-events-none absolute w-[min(92vw,720px)] h-[min(56vh,420px)] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(229,9,20,0.22)_0%,rgba(229,9,20,0.06)_44%,rgba(4,5,7,0)_74%)]"
      />

      {/* Subtle horizontal cinema beam hairline behind logo */}
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0, scaleX: 0 }}
        animate={{ opacity: [0, 0.7, 0.2], scaleX: [0, 1, 1] }}
        transition={{
          duration: 1.5,
          delay: 0.45,
          times: [0, 0.52, 1],
          ease: [0.16, 1, 0.3, 1],
        }}
        className="pointer-events-none absolute w-[min(78vw,460px)] h-px bg-gradient-to-r from-transparent via-[#E50914]/80 to-transparent"
      />

      {/* Stage 3 & 4: IPFLIX Logo reveal + GPU-composited metallic light sheen sweep */}
      <div className="relative z-10 flex flex-col items-center text-center max-w-full">
        <motion.div
          initial={{ opacity: 0, scale: 0.88, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{
            duration: 0.88,
            delay: 0.42,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="px-2 py-1"
        >
          <BrandMark size="xl" showSheen={!reducedMotion} />
        </motion.div>

        {/* Signature crimson accent bar */}
        <motion.div
          aria-hidden="true"
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{
            duration: 0.72,
            delay: 0.92,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="mt-5 w-24 sm:w-32 h-[2px] rounded-full bg-gradient-to-r from-transparent via-[#E50914] to-transparent"
        />

        {/* Slogan reveal */}
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 0.78, y: 0 }}
          transition={{
            duration: 0.65,
            delay: 1.12,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="mt-4 text-[10px] sm:text-xs font-semibold tracking-[0.3em] sm:tracking-[0.36em] text-white/80 uppercase px-2"
        >
          {t('app.slogan')}
        </motion.p>

        {/* Subtle loading note ONLY if catalog initialization takes longer than the intro sequence */}
        {!ready && animationDone && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            transition={{ duration: 0.3 }}
            className="mt-5 text-[11px] text-[#9CA3B2]"
          >
            {t('app.initializing')}
          </motion.p>
        )}
      </div>
    </motion.div>
  );
}
