/**
 * IPFLIX Intro Signature Audio Controller
 *
 * Plays the original IPFLIX cinematic launch sound (`/assets/audio/ipflix-intro.mp3`)
 * with complete fault tolerance:
 *  - Fails silently if the audio file cannot be loaded or decoded.
 *  - Respects browser / Android WebView autoplay restrictions without stalling UI.
 *  - Cleans up audio resources cleanly on unmount or stop.
 */

export const INTRO_AUDIO_PATH = '/assets/audio/ipflix-intro.mp3';

export interface IntroAudioHandle {
  stop: () => void;
  unlockAndPlay: () => Promise<boolean>;
  promise: Promise<boolean>;
}

const DEFAULT_INTRO_VOLUME = 0.72;

export function playIntroSound(options?: { volume?: number }): IntroAudioHandle {
  const targetVolume = Math.max(0, Math.min(1, options?.volume ?? DEFAULT_INTRO_VOLUME));

  if (typeof window === 'undefined' || typeof Audio === 'undefined') {
    return {
      stop: () => {},
      unlockAndPlay: async () => false,
      promise: Promise.resolve(false),
    };
  }

  let audio: HTMLAudioElement | null = null;
  let stopped = false;
  let started = false;
  let failed = false;

  try {
    audio = new Audio(INTRO_AUDIO_PATH);
    audio.preload = 'auto';
    audio.volume = targetVolume;
    audio.crossOrigin = 'anonymous';
    audio.onerror = () => {
      failed = true;
    };
  } catch {
    failed = true;
  }

  const attemptPlay = async (): Promise<boolean> => {
    if (stopped || failed || started || !audio) return false;
    try {
      const result = audio.play();
      if (result && typeof result.then === 'function') {
        await result;
      }
      if (stopped) {
        audio.pause();
        return false;
      }
      started = true;
      return true;
    } catch {
      // Blocked by browser/Android autoplay policy or silent environment — remain gracefully silent
      return false;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
    } catch {
      // Ignore cleanup errors
    }
    audio = null;
  };

  const promise = attemptPlay();

  return {
    stop,
    unlockAndPlay: attemptPlay,
    promise,
  };
}
