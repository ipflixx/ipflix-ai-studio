import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import * as dashjs from 'dashjs';
import {
  AlertTriangle,
  ArrowLeft,
  Captions,
  ChevronLeft,
  ChevronRight,
  FastForward,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Rewind,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  AppSettings,
  AspectRatioMode,
  PlayerMediaItem,
  StreamEnginePreference,
} from '../types/iptv';
import {
  buildProxiedStreamUrl,
  buildRemuxUrl,
  convertSrtToVtt,
  formatDuration,
} from '../services/iptvApi';
import { useI18n } from '../i18n/I18nContext';
import { flushPendingSavesSync } from '../services/storage';
import { cleanDisplaySubtitle, cleanMediaTitle } from '../utils/titleCleaner';

// Silence internal mpegts.js debug/error console noise during automatic stream probing & fallbacks
if (mpegts.LoggingControl) {
  mpegts.LoggingControl.enableAll = false;
  mpegts.LoggingControl.enableError = false;
  mpegts.LoggingControl.enableWarn = false;
  mpegts.LoggingControl.enableInfo = false;
  mpegts.LoggingControl.enableDebug = false;
  mpegts.LoggingControl.enableVerbose = false;
}

interface VideoPlayerProps {
  media: PlayerMediaItem;
  settings: AppSettings;
  ffmpegAvailable: boolean;
  embedded?: boolean;
  onClose?: () => void;
  onProgressUpdate?: (position: number, duration: number, completed?: boolean) => void;
  onUpdatePlayerPrefs?: (prefs: {
    playerVolume?: number;
    playerMuted?: boolean;
    playerPlaybackRate?: number;
  }) => void;
  onNextItem?: () => void;
  onPrevItem?: () => void;
  nextLabel?: string;
  prevLabel?: string;
  onExpandFullscreenView?: () => void;
  onMarkUnavailable?: () => void;
}

type ActiveEngine =
  | 'hls'
  | 'mpegts'
  | 'dash'
  | 'direct'
  | 'audiofix'
  | 'transcode'
  | 'transcode_ts';

interface QualityOption {
  id: number;
  label: string;
}

interface TrackOption {
  id: number;
  label: string;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECT_OPTIONS: Array<{ value: AspectRatioMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: 'fit', label: 'Fit' },
  { value: 'fill', label: 'Fill' },
];

interface PlaybackStep {
  engine: ActiveEngine;
  url: string;
  useProxy: boolean;
  stageMessage: string;
}

function isPublicOpenSourceDemoUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)(commondatastorage\.googleapis\.com|storage\.googleapis\.com|test-streams\.mux\.dev|devstreaming-cdn\.apple\.com|download\.blender\.org)$/i.test(
      u.hostname
    );
  } catch {
    return false;
  }
}

function deriveXtreamBareLiveUrl(urlStr?: string): string | undefined {
  if (!urlStr) return undefined;
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/(\d+)\.(m3u8|ts)$/i);
    if (m) {
      return `${u.origin}/${m[1]}/${m[2]}/${m[3]}`;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function formatQualityBadge(height: number): string | null {
  if (height >= 2000) return '4K UHD';
  if (height >= 1000) return 'Full HD';
  if (height >= 700) return 'HD';
  if (height > 0) return 'SD';
  return null;
}

const STAGE_MESSAGE_TR: Record<string, string> = {
  'Connecting...': 'Yayına bağlanılıyor...',
  'Loading video...': 'Video yükleniyor...',
  'Optimizing playback...': 'Oynatma optimize ediliyor...',
  'Optimizing live stream...': 'Canlı yayın optimize ediliyor...',
  'Optimizing live feed...': 'Canlı yayın kaynağı optimize ediliyor...',
  'Optimizing stream format...': 'Yayın formatı uyarlanıyor...',
  'Optimizing audio and video...': 'Ses ve görüntü uyumluluğu hazırlanıyor...',
  'Preparing high-compatibility stream...': 'Yüksek uyumluluk yayını hazırlanıyor...',
  'Preparing high-compatibility playback...': 'Yüksek uyumluluk modu hazırlanıyor...',
};

function buildFallbackPlan(
  media: PlayerMediaItem,
  preference: StreamEnginePreference,
  ffmpegAvailable: boolean
): PlaybackStep[] {
  if (media.isLocalBlob || media.streamUrl.startsWith('blob:')) {
    return [
      {
        engine: 'direct',
        url: media.streamUrl,
        useProxy: false,
        stageMessage: 'Loading video...',
      },
    ];
  }

  const isLive = media.type === 'live';
  const lower = media.streamUrl.toLowerCase().split('?')[0];
  const ext = (media.containerExtension || '').toLowerCase();
  const bareLiveUrl = isLive ? deriveXtreamBareLiveUrl(media.streamUrl) : undefined;
  const steps: PlaybackStep[] = [];

  const pushUnique = (
    engine: ActiveEngine,
    url: string,
    useProxy: boolean,
    stageMessage: string
  ) => {
    if (!url) return;
    if (
      (engine === 'audiofix' || engine === 'transcode' || engine === 'transcode_ts') &&
      !ffmpegAvailable
    ) {
      return;
    }
    if ((engine === 'mpegts' || engine === 'transcode_ts') && !mpegts.isSupported()) {
      return;
    }
    if (!steps.some((s) => s.engine === engine && s.url === url && s.useProxy === useProxy)) {
      steps.push({ engine, url, useProxy, stageMessage });
    }
  };

  // Built-in public open-source HTTPS demo streams (direct first, proxy safety net)
  if (isPublicOpenSourceDemoUrl(media.streamUrl)) {
    if (lower.endsWith('.m3u8')) {
      pushUnique('hls', media.streamUrl, false, 'Connecting...');
      pushUnique('hls', media.streamUrl, true, 'Optimizing playback...');
    } else if (lower.endsWith('.mpd')) {
      pushUnique('dash', media.streamUrl, false, 'Connecting...');
      pushUnique('dash', media.streamUrl, true, 'Optimizing playback...');
    } else {
      pushUnique('direct', media.streamUrl, false, 'Loading video...');
      pushUnique('direct', media.streamUrl, true, 'Optimizing playback...');
    }
    return steps;
  }

  // Manual preference override (e.g. High Compatibility Mode or HLS/MPEG-TS preference)
  if (preference === 'transcode') {
    if (isLive) {
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
      pushUnique('transcode', media.streamUrl, true, 'Optimizing stream format...');
      if (media.altStreamUrl) {
        pushUnique('transcode_ts', media.altStreamUrl, true, 'Optimizing live feed...');
      }
      if (bareLiveUrl) {
        pushUnique('transcode_ts', bareLiveUrl, true, 'Optimizing live feed...');
      }
      if (media.directSourceUrl) {
        pushUnique('transcode_ts', media.directSourceUrl, true, 'Optimizing live feed...');
      }
    } else {
      pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
      pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
      pushUnique('direct', media.streamUrl, true, 'Loading video...');
    }
    if (steps.length > 0) return steps;
  } else if (preference === 'audiofix') {
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing audio and video...');
    if (isLive) {
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
    }
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
    if (steps.length > 0) return steps;
  } else if (preference === 'hls') {
    const hlsUrl =
      lower.endsWith('.m3u8')
        ? media.streamUrl
        : media.altStreamUrl && media.altStreamUrl.toLowerCase().includes('.m3u8')
        ? media.altStreamUrl
        : media.streamUrl;
    pushUnique('hls', hlsUrl, true, 'Connecting...');
    if (isLive) {
      pushUnique('mpegts', media.streamUrl, true, 'Optimizing playback...');
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
    }
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
    return steps;
  } else if (preference === 'mpegts') {
    const tsUrl =
      lower.endsWith('.ts')
        ? media.streamUrl
        : media.altStreamUrl && media.altStreamUrl.toLowerCase().includes('.ts')
        ? media.altStreamUrl
        : media.streamUrl;
    pushUnique('mpegts', tsUrl, true, 'Connecting...');
    if (media.altStreamUrl) {
      pushUnique('hls', media.altStreamUrl, true, 'Optimizing playback...');
    }
    pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
    return steps;
  }

  // AUTO SMART CASCADE — Always same-origin proxied so CORS, Mixed Content, UA rotation,
  // 188-byte MPEG-TS alignment, M2TS conversion, HTML-block retries, and codec repair work seamlessly.
  const isRemuxFirstVodContainer =
    !isLive &&
    (['mkv', 'avi', 'wmv', 'flv', 'divx', 'mpg', 'mpeg', 'vob', 'ts', 'm2ts'].includes(ext) ||
      /\.(mkv|avi|wmv|flv|divx|mpg|mpeg|vob|ts|m2ts)$/.test(lower));

  if (lower.endsWith('.mpd')) {
    pushUnique('dash', media.streamUrl, true, 'Connecting...');
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
    if (isLive) {
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
    }
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
  } else if (isLive) {
    if (lower.endsWith('.m3u8')) {
      pushUnique('hls', media.streamUrl, true, 'Connecting...');
      if (media.altStreamUrl) {
        pushUnique('mpegts', media.altStreamUrl, true, 'Optimizing live stream...');
      }
      pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
      if (media.altStreamUrl) {
        pushUnique('transcode_ts', media.altStreamUrl, true, 'Preparing high-compatibility stream...');
      }
      if (bareLiveUrl) {
        pushUnique('transcode_ts', bareLiveUrl, true, 'Preparing high-compatibility stream...');
      }
      if (media.directSourceUrl) {
        pushUnique('transcode_ts', media.directSourceUrl, true, 'Preparing high-compatibility stream...');
      }
      pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility stream...');
    } else if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) {
      pushUnique('mpegts', media.streamUrl, true, 'Connecting...');
      if (media.altStreamUrl) {
        pushUnique('hls', media.altStreamUrl, true, 'Optimizing live stream...');
      }
      pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
      if (media.altStreamUrl) {
        pushUnique('transcode_ts', media.altStreamUrl, true, 'Preparing high-compatibility stream...');
      }
      if (bareLiveUrl) {
        pushUnique('transcode_ts', bareLiveUrl, true, 'Preparing high-compatibility stream...');
      }
      if (media.directSourceUrl) {
        pushUnique('transcode_ts', media.directSourceUrl, true, 'Preparing high-compatibility stream...');
      }
      pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility stream...');
    } else {
      // Extensionless live URL (e.g. Xtream /user/pass/12345 or tokenized redirect)
      pushUnique('mpegts', media.streamUrl, true, 'Connecting...');
      pushUnique('hls', media.streamUrl, true, 'Optimizing live stream...');
      if (media.altStreamUrl) {
        const altLower = media.altStreamUrl.toLowerCase().split('?')[0];
        pushUnique(
          altLower.endsWith('.m3u8') ? 'hls' : 'mpegts',
          media.altStreamUrl,
          true,
          'Optimizing live stream...'
        );
      }
      pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
      pushUnique('transcode_ts', media.streamUrl, true, 'Preparing high-compatibility stream...');
      if (media.altStreamUrl) {
        pushUnique('transcode_ts', media.altStreamUrl, true, 'Preparing high-compatibility stream...');
      }
      if (media.directSourceUrl) {
        pushUnique('transcode_ts', media.directSourceUrl, true, 'Preparing high-compatibility stream...');
      }
      pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility stream...');
    }
  } else if (lower.endsWith('.m3u8')) {
    pushUnique('hls', media.streamUrl, true, 'Loading video...');
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
  } else if (isRemuxFirstVodContainer) {
    // IPTV MKV/AVI/TS movies frequently contain AC-3/DTS/HEVC/10-bit tracks that stall or play silent in Chrome.
    // audiofix copies 8-bit H.264 at 0% CPU + encodes stereo AAC, and auto-upgrades HEVC/10-bit/MPEG-2 to H.264 before flushing!
    pushUnique('audiofix', media.streamUrl, true, 'Loading video...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
    pushUnique('direct', media.streamUrl, true, 'Loading video...');
  } else if (ext === 'mp4' || ext === 'webm' || ext === 'm4v' || /\.(mp4|webm|m4v)$/.test(lower)) {
    pushUnique('direct', media.streamUrl, true, 'Loading video...');
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
  } else {
    pushUnique('direct', media.streamUrl, true, 'Loading video...');
    pushUnique('hls', media.streamUrl, true, 'Optimizing playback...');
    pushUnique('audiofix', media.streamUrl, true, 'Optimizing playback...');
    pushUnique('transcode', media.streamUrl, true, 'Preparing high-compatibility playback...');
  }

  return steps;
}

export function VideoPlayer({
  media,
  settings,
  ffmpegAvailable,
  embedded = false,
  onClose,
  onProgressUpdate,
  onUpdatePlayerPrefs,
  onNextItem,
  onPrevItem,
  nextLabel,
  prevLabel,
  onExpandFullscreenView,
  onMarkUnavailable,
}: VideoPlayerProps) {
  const { lang, t } = useI18n();
  const isTr = lang === 'tr';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);
  const dashRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);

  // Monotonic mount generation counter: prevents stale async DOM video.onerror or MSE error events
  // from tearing down or skipping the next working fallback engine!
  const mountIdRef = useRef(0);
  const escalatedMountIdRef = useRef(0);
  const hasPlayedCurrentAttemptRef = useRef(false);

  const initialPlan = buildFallbackPlan(media, settings.defaultEngine, ffmpegAvailable);
  const planRef = useRef<PlaybackStep[]>(initialPlan);
  const stepIndexRef = useRef(0);
  const activeMediaIdRef = useRef(media.id);
  activeMediaIdRef.current = media.id;
  const lastSavedTimeRef = useRef(0);
  const latestPosRef = useRef(
    media.type !== 'live' && media.resumePosition && media.resumePosition >= 2
      ? media.resumePosition
      : 0
  );
  const latestDurRef = useRef(
    media.movie?.durationSeconds || media.episode?.durationSeconds || 0
  );
  const flushMediaProgressRef = useRef<(() => void) | null>(null);
  const onProgressUpdateRef = useRef(onProgressUpdate);
  onProgressUpdateRef.current = onProgressUpdate;
  const onUpdatePlayerPrefsRef = useRef(onUpdatePlayerPrefs);
  onUpdatePlayerPrefsRef.current = onUpdatePlayerPrefs;
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' } | null>(null);

  const [engineOverride, setEngineOverride] = useState<StreamEnginePreference>(settings.defaultEngine);
  const [activeEngine, setActiveEngine] = useState<ActiveEngine>(initialPlan[0]?.engine || 'direct');
  const [activeUrl, setActiveUrl] = useState<string>(initialPlan[0]?.url || media.streamUrl);
  const [activeStepUseProxy, setActiveStepUseProxy] = useState<boolean>(
    initialPlan[0]?.useProxy ?? true
  );
  const [geoBlockedDetected, setGeoBlockedDetected] = useState(false);
  const [streamStartOffset, setStreamStartOffset] = useState(0);
  const [knownDuration, setKnownDuration] = useState<number>(
    media.movie?.durationSeconds || media.episode?.durationSeconds || 0
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [autoMutedNotice, setAutoMutedNotice] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState(initialPlan[0]?.stageMessage || 'Connecting...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(() =>
    typeof settings.playerVolume === 'number' && Number.isFinite(settings.playerVolume)
      ? Math.max(0, Math.min(1, settings.playerVolume))
      : 1
  );
  const [isMuted, setIsMuted] = useState(() => Boolean(settings.playerMuted));
  const [playbackRate, setPlaybackRate] = useState(() =>
    typeof settings.playerPlaybackRate === 'number' &&
    SPEED_OPTIONS.includes(settings.playerPlaybackRate)
      ? settings.playerPlaybackRate
      : 1
  );
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const autoMutedNoticeRef = useRef(autoMutedNotice);
  autoMutedNoticeRef.current = autoMutedNotice;

  // Keep embedded/fullscreen players synchronized with persisted player settings
  useEffect(() => {
    const nextVol =
      typeof settings.playerVolume === 'number' && Number.isFinite(settings.playerVolume)
        ? Math.max(0, Math.min(1, settings.playerVolume))
        : 1;
    const nextMuted = Boolean(settings.playerMuted);
    const nextRate =
      typeof settings.playerPlaybackRate === 'number' &&
      SPEED_OPTIONS.includes(settings.playerPlaybackRate)
        ? settings.playerPlaybackRate
        : 1;

    setVolume(nextVol);
    if (!autoMutedNoticeRef.current) {
      setIsMuted(nextMuted);
    }
    setPlaybackRate(nextRate);

    const v = videoRef.current;
    if (v) {
      v.volume = nextVol;
      if (!autoMutedNoticeRef.current) {
        v.muted = nextMuted;
      }
      if (media.type !== 'live') {
        v.playbackRate = nextRate;
      }
    }
  }, [settings.playerVolume, settings.playerMuted, settings.playerPlaybackRate, media.type]);

  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>(settings.defaultAspectRatio);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // Track controls
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number>(-1);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState<number>(0);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [currentSubtitleTrack, setCurrentSubtitleTrack] = useState<number>(-1);
  const [localSubUrl, setLocalSubUrl] = useState<string | null>(null);
  const [localSubLabel, setLocalSubLabel] = useState<string>('');

  // Menus & Overlays
  const [openMenu, setOpenMenu] = useState<'none' | 'settings' | 'subtitles'>('none');
  const [videoDims, setVideoDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [seekFeedback, setSeekFeedback] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const isLive = media.type === 'live';
  const isAudioOnlyRadio =
    isLive &&
    (media.channel?.normalizedCategory === 'Music' ||
      /\b(radio|radyo|fm)\b/i.test(media.title));
  const isRemuxSeekingEngine = activeEngine === 'audiofix' || activeEngine === 'transcode';
  const isCompatibilityModeActive =
    activeEngine === 'transcode' || activeEngine === 'transcode_ts';
  const effectiveDuration = duration > 0 && Number.isFinite(duration) ? duration : knownDuration;
  const displayTime = isRemuxSeekingEngine ? streamStartOffset + currentTime : currentTime;

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current !== null) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const destroyEngines = useCallback(() => {
    // Bump mount ID BEFORE tearing down media engines so any async error callback from teardown is ignored
    mountIdRef.current += 1;
    clearWatchdog();

    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        // ignore
      }
      hlsRef.current = null;
    }
    if (mpegtsRef.current) {
      try {
        mpegtsRef.current.pause();
        mpegtsRef.current.unload();
        mpegtsRef.current.detachMediaElement();
        mpegtsRef.current.destroy();
      } catch {
        // ignore
      }
      mpegtsRef.current = null;
    }
    if (dashRef.current) {
      try {
        dashRef.current.reset();
      } catch {
        // ignore
      }
      dashRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      try {
        video.srcObject = null;
      } catch {
        // ignore
      }
    }
  }, [clearWatchdog]);

  // Reset playback plan whenever selected media or default settings change
  useEffect(() => {
    const plan = buildFallbackPlan(media, settings.defaultEngine, ffmpegAvailable);
    planRef.current = plan;
    stepIndexRef.current = 0;
    lastSavedTimeRef.current = 0;
    latestPosRef.current =
      !isLive && media.resumePosition && media.resumePosition >= 2 ? media.resumePosition : 0;
    latestDurRef.current = media.movie?.durationSeconds || media.episode?.durationSeconds || 0;
    hasPlayedCurrentAttemptRef.current = false;

    setErrorMessage(null);
    setGeoBlockedDetected(false);
    setNextCountdown(null);
    setAutoMutedNotice(false);
    setAutoplayBlocked(false);
    setQualities([]);
    setAudioTracks([]);
    setSubtitleTracks([]);
    setCurrentQuality(-1);
    setCurrentSubtitleTrack(-1);
    setVideoDims({ w: 0, h: 0 });
    setEngineOverride(settings.defaultEngine);
    setStreamStartOffset(
      !isLive && media.resumePosition && media.resumePosition >= 2 ? media.resumePosition : 0
    );
    setKnownDuration(media.movie?.durationSeconds || media.episode?.durationSeconds || 0);
    setActiveEngine(plan[0]?.engine || 'direct');
    setActiveUrl(plan[0]?.url || media.streamUrl);
    setActiveStepUseProxy(plan[0]?.useProxy ?? true);
    setStatusMessage(plan[0]?.stageMessage || 'Connecting...');
    setReloadNonce((n) => n + 1);
  }, [media.id, media.streamUrl, settings.defaultEngine, ffmpegAvailable, isLive]);

  // Self-healing fallback cascade (advances silently through every compatible stream path before showing an error)
  const escalateFallback = useCallback(
    (reason: string, isGeoError = false) => {
      clearWatchdog();
      if (isGeoError || /451|403|456|geo|region|bölge|country/i.test(reason)) {
        setGeoBlockedDetected(true);
      }

      const plan = planRef.current;
      const nextIdx = stepIndexRef.current + 1;

      if (nextIdx < plan.length) {
        const nextStep = plan[nextIdx];
        stepIndexRef.current = nextIdx;
        setStatusMessage(nextStep.stageMessage || 'Optimizing playback...');
        setActiveUrl(nextStep.url);
        setActiveEngine(nextStep.engine);
        setActiveStepUseProxy(nextStep.useProxy);
        setReloadNonce((n) => n + 1);
        return;
      }

      setIsBuffering(false);
      setErrorMessage(reason);
    },
    [clearWatchdog]
  );

  const escalateFallbackRef = useRef(escalateFallback);
  useEffect(() => {
    escalateFallbackRef.current = escalateFallback;
  }, [escalateFallback]);

  const triggerEscalationForMount = useCallback(
    (mountId: number, reason: string, isGeoError = false) => {
      if (mountId !== mountIdRef.current || escalatedMountIdRef.current === mountId) {
        return;
      }
      escalatedMountIdRef.current = mountId;
      escalateFallbackRef.current(reason, isGeoError);
    },
    []
  );

  // Main Playback Engine Mount Effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    destroyEngines();
    const myMountId = mountIdRef.current;
    hasPlayedCurrentAttemptRef.current = false;

    setErrorMessage(null);
    setAutoplayBlocked(false);
    setIsBuffering(true);

    const ua = media.userAgent || settings.defaultUserAgent;
    const ref = media.referer;
    const proxiedUrl = buildProxiedStreamUrl(activeUrl, {
      useProxy: activeStepUseProxy,
      userAgent: ua,
      referer: ref,
      isLocalBlob: media.isLocalBlob,
    });

    const isStale = () => myMountId !== mountIdRef.current;

    const tryAutoPlay = () => {
      if (isStale()) return;
      // Apply persisted volume, mute state, and playback rate before starting playback
      video.volume = Math.max(0, Math.min(1, volumeRef.current));
      video.muted = isMutedRef.current;
      video.playbackRate = isLive ? 1 : playbackRateRef.current;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err: unknown) => {
          if (isStale()) return;
          const errName = err instanceof Error ? err.name : '';
          if (errName === 'NotAllowedError') {
            // Browser autoplay policy temporarily muted this attempt — do NOT overwrite saved preference
            video.muted = true;
            setIsMuted(true);
            setAutoMutedNotice(true);
            video.play().catch(() => {
              if (isStale()) return;
              setIsPlaying(false);
              setIsBuffering(false);
              setAutoplayBlocked(true);
            });
          } else if (errName !== 'AbortError') {
            setIsPlaying(false);
          }
        });
      }
    };

    const watchdogMs =
      activeEngine === 'transcode' || activeEngine === 'transcode_ts'
        ? 22000
        : activeEngine === 'audiofix'
        ? 16000
        : 9500;

    watchdogTimerRef.current = window.setTimeout(() => {
      if (isStale() || hasPlayedCurrentAttemptRef.current) return;
      if (video.readyState < 2) {
        triggerEscalationForMount(myMountId, 'Stream timed out while connecting.');
      }
    }, watchdogMs);

    // 1. Live MPEG-TS H.264/AAC MSE Transcode Mode (continuous auto-cleaning Live TV buffer!)
    if (activeEngine === 'transcode_ts') {
      const remuxTsUrl = buildRemuxUrl(activeUrl, {
        mode: 'transcode',
        format: 'ts',
        userAgent: ua,
        referer: ref,
        isLive: true,
      });
      if (mpegts.isSupported()) {
        try {
          const player = mpegts.createPlayer(
            {
              type: 'mpegts',
              isLive: true,
              url: remuxTsUrl,
              cors: true,
            },
            {
              enableWorker: false,
              lazyLoad: false,
              enableStashBuffer: true,
              stashInitialSize: settings.lowBandwidthMode ? 128 : 256,
              liveBufferLatencyChasing: false,
              autoCleanupSourceBuffer: true,
            }
          );
          mpegtsRef.current = player;
          player.attachMediaElement(video);
          player.load();

          player.on(mpegts.Events.ERROR, (_type, _detail, info) => {
            if (isStale()) return;
            const code =
              info && typeof info === 'object' && 'code' in info && info.code
                ? Number(info.code)
                : 0;
            const isGeo = code === 451 || code === 403 || code === 456 || code === 401;
            triggerEscalationForMount(myMountId, 'Live compatibility stream interrupted.', isGeo);
          });

          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            if (isStale() || hasPlayedCurrentAttemptRef.current) return;
            triggerEscalationForMount(myMountId, 'Live stream ended before playback started.');
          });

          tryAutoPlay();
        } catch {
          triggerEscalationForMount(myMountId, 'Could not start live compatibility stream.');
        }
      } else {
        triggerEscalationForMount(myMountId, 'Live MSE stream not supported.');
      }

      return () => {
        destroyEngines();
      };
    }

    // 2. Server-Side FFmpeg Fragmented MP4 Remux / Universal Transcode (VOD & Live fallback)
    if (activeEngine === 'audiofix' || activeEngine === 'transcode') {
      const remuxUrl = buildRemuxUrl(activeUrl, {
        mode: activeEngine,
        format: 'mp4',
        userAgent: ua,
        referer: ref,
        startSeconds: isLive ? 0 : streamStartOffset,
        isLive,
      });
      video.src = remuxUrl;
      video.load();
      tryAutoPlay();
      return () => {
        destroyEngines();
      };
    }

    // 3. Adaptive HLS (.m3u8)
    if (activeEngine === 'hls') {
      if (Hls.isSupported()) {
        let mediaRecoveryCount = 0;
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: false,
          backBufferLength: isLive ? 30 : 90,
          maxBufferLength: settings.lowBandwidthMode ? 15 : 35,
          maxMaxBufferLength: settings.lowBandwidthMode ? 30 : 60,
          startLevel: settings.lowBandwidthMode ? 0 : -1,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 2,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          if (isStale()) return;
          const lvlOpts: QualityOption[] = [
            { id: -1, label: 'Auto' },
            ...data.levels.map((l, idx) => ({
              id: idx,
              label: l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)} kbps`,
            })),
          ];
          setQualities(data.levels.length > 1 ? lvlOpts : []);

          if (!isLive && media.resumePosition && media.resumePosition >= 2) {
            video.currentTime = media.resumePosition;
          }
          tryAutoPlay();
        });

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
          if (isStale()) return;
          setAudioTracks(
            data.audioTracks.map((t, idx) => ({
              id: idx,
              label: t.name || t.lang || `Audio ${idx + 1}`,
            }))
          );
          setCurrentAudioTrack(hls.audioTrack);
        });

        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
          if (isStale()) return;
          const subs = data.subtitleTracks.map((t, idx) => ({
            id: idx,
            label: t.name || t.lang || `Subtitle ${idx + 1}`,
          }));
          setSubtitleTracks(subs);
          if (settings.preferredSubtitleLang && settings.preferredSubtitleLang !== 'off') {
            const matchIdx = data.subtitleTracks.findIndex(
              (t) =>
                (t.lang || '').toLowerCase().startsWith(settings.preferredSubtitleLang.toLowerCase()) ||
                (t.name || '').toLowerCase().includes(settings.preferredSubtitleLang.toLowerCase())
            );
            if (matchIdx >= 0) {
              hls.subtitleTrack = matchIdx;
              setCurrentSubtitleTrack(matchIdx);
            }
          }
        });

        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (isStale()) return;
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryCount < 1) {
              mediaRecoveryCount += 1;
              hls.recoverMediaError();
              return;
            }
            const statusCode = data.response?.code || 0;
            const respText = typeof data.response?.text === 'string' ? data.response.text : '';
            const isGeo =
              statusCode === 451 ||
              statusCode === 403 ||
              statusCode === 456 ||
              respText.includes('GEO_BLOCKED') ||
              /bölge|region|geo/i.test(respText);
            triggerEscalationForMount(
              myMountId,
              isGeo ? 'Broadcast restricted in current region.' : 'Live stream interrupted.',
              isGeo
            );
          }
        });

        hls.loadSource(proxiedUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxiedUrl;
        video.load();
        tryAutoPlay();
      } else {
        triggerEscalationForMount(myMountId, 'HLS playback unavailable.');
      }

      return () => {
        destroyEngines();
      };
    }

    // 4. Sync-Aligned Raw MPEG-TS (.ts) MSE
    if (activeEngine === 'mpegts') {
      if (mpegts.isSupported()) {
        try {
          const player = mpegts.createPlayer(
            {
              type: 'mpegts',
              isLive,
              url: proxiedUrl,
              cors: true,
            },
            {
              enableWorker: false,
              lazyLoad: false,
              enableStashBuffer: true,
              stashInitialSize: settings.lowBandwidthMode ? 128 : 256,
              liveBufferLatencyChasing: false,
              autoCleanupSourceBuffer: true,
            }
          );
          mpegtsRef.current = player;
          player.attachMediaElement(video);
          player.load();

          player.on(mpegts.Events.ERROR, (_type, _detail, info) => {
            if (isStale()) return;
            const code =
              info && typeof info === 'object' && 'code' in info && info.code
                ? Number(info.code)
                : 0;
            const isGeo = code === 451 || code === 403 || code === 456 || code === 401;
            triggerEscalationForMount(
              myMountId,
              isGeo ? 'Broadcast restricted in current region.' : 'Stream format requires optimization.',
              isGeo
            );
          });

          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            if (isStale() || hasPlayedCurrentAttemptRef.current) return;
            if (isLive) {
              triggerEscalationForMount(myMountId, 'Live stream ended before playback started.');
            }
          });

          tryAutoPlay();
        } catch {
          triggerEscalationForMount(myMountId, 'Could not initialize stream player.');
        }
      } else {
        triggerEscalationForMount(myMountId, 'MSE streaming not supported.');
      }

      return () => {
        destroyEngines();
      };
    }

    // 5. MPEG-DASH (.mpd)
    if (activeEngine === 'dash') {
      try {
        const dashPlayer = dashjs.MediaPlayer().create();
        dashPlayer.updateSettings({ debug: { logLevel: 0 } });
        dashRef.current = dashPlayer;
        dashPlayer.initialize(video, proxiedUrl, true);
        dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          if (isStale()) return;
          try {
            const reps = dashPlayer.getRepresentationsByType('video');
            if (reps && reps.length > 1) {
              setQualities([
                { id: -1, label: 'Auto' },
                ...reps.map((rep, idx) => ({
                  id: idx,
                  label: rep.height ? `${rep.height}p` : `${Math.round(rep.bitrateInKbit)} kbps`,
                })),
              ]);
            }
          } catch {
            // ignore
          }
        });
        dashPlayer.on(dashjs.MediaPlayer.events.ERROR, () => {
          if (isStale()) return;
          triggerEscalationForMount(myMountId, 'Adaptive stream interrupted.');
        });
      } catch {
        triggerEscalationForMount(myMountId, 'Could not initialize adaptive player.');
      }

      return () => {
        destroyEngines();
      };
    }

    // 6. Native HTML5 Video (MP4 / WebM / Local Blob)
    video.src = proxiedUrl;
    video.load();
    if (!isLive && media.resumePosition && media.resumePosition >= 2) {
      const onLoaded = () => {
        if (!video.duration || media.resumePosition! < video.duration - 5) {
          video.currentTime = media.resumePosition!;
        }
        video.removeEventListener('loadedmetadata', onLoaded);
      };
      video.addEventListener('loadedmetadata', onLoaded);
    }
    tryAutoPlay();

    return () => {
      destroyEngines();
    };
  }, [
    activeEngine,
    activeUrl,
    activeStepUseProxy,
    reloadNonce,
    settings.lowBandwidthMode,
    destroyEngines,
    triggerEscalationForMount,
    isLive,
    media.isLocalBlob,
    media.referer,
    media.resumePosition,
    media.userAgent,
    settings.defaultUserAgent,
    streamStartOffset,
  ]);

  // Video DOM event bindings
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const capturedMediaId = media.id;
    const capturedOnProgress = onProgressUpdateRef.current;

    const computeCompleted = (pos: number, dur: number, explicit?: boolean): boolean => {
      if (explicit !== undefined) return explicit;
      return dur > 0 && pos / dur >= 0.92;
    };

    const markPlaybackReady = () => {
      hasPlayedCurrentAttemptRef.current = true;
      clearWatchdog();
      setIsBuffering(false);
      setErrorMessage(null);
      if (video.videoWidth > 0) {
        setVideoDims({ w: video.videoWidth, h: video.videoHeight });
      }
    };

    const flushProgressNow = (
      forcePosition?: number,
      forceDuration?: number,
      explicitCompleted?: boolean
    ) => {
      if (isLive || !capturedOnProgress || activeMediaIdRef.current !== capturedMediaId) {
        return;
      }
      const rawTime = video.currentTime || 0;
      const rawDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const pos =
        forcePosition !== undefined
          ? forcePosition
          : rawTime > 0
          ? isRemuxSeekingEngine
            ? streamStartOffset + rawTime
            : rawTime
          : latestPosRef.current;
      const dur =
        forceDuration !== undefined
          ? forceDuration
          : rawDur > 0
          ? rawDur
          : knownDuration || latestDurRef.current;

      if (pos >= 1.5 || explicitCompleted) {
        latestPosRef.current = pos;
        if (dur > 0) latestDurRef.current = dur;
        lastSavedTimeRef.current = pos;
        capturedOnProgress(pos, dur, computeCompleted(pos, dur, explicitCompleted));
      }
    };
    flushMediaProgressRef.current = () => flushProgressNow();

    const onPlay = () => {
      setIsPlaying(true);
      setAutoplayBlocked(false);
      if (video.readyState >= 2) markPlaybackReady();
    };
    const onPause = () => {
      setIsPlaying(false);
      flushProgressNow();
    };
    const onSeeked = () => {
      flushProgressNow();
    };
    const onWaiting = () => setIsBuffering(true);
    const onLoadedData = () => {
      if (video.readyState >= 2) markPlaybackReady();
    };
    const onCanPlay = () => {
      markPlaybackReady();
    };

    const onLoadedMetadata = () => {
      video.volume = Math.max(0, Math.min(1, volumeRef.current));
      if (!autoMutedNoticeRef.current) {
        video.muted = isMutedRef.current;
      }
      if (!isLive) {
        video.playbackRate = playbackRateRef.current;
      }
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (d > 0) {
        setDuration(d);
        latestDurRef.current = d;
      }
      if (video.videoWidth > 0) {
        setVideoDims({ w: video.videoWidth, h: video.videoHeight });
      }
    };

    const onTimeUpdate = () => {
      const t = video.currentTime || 0;
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (t > 0.1 && !hasPlayedCurrentAttemptRef.current) {
        markPlaybackReady();
      }
      setCurrentTime(t);
      if (d > 0) {
        setDuration(d);
        latestDurRef.current = d;
      }
      if (video.videoWidth > 0) {
        setVideoDims((prev) =>
          prev.w === video.videoWidth && prev.h === video.videoHeight
            ? prev
            : { w: video.videoWidth, h: video.videoHeight }
        );
      }

      // Automatic black-screen HEVC/unsupported-video rescue:
      // If audio plays for > 1.5s with 0x0 video dimensions (non-radio), automatically switch to H.264 compatibility!
      if (
        !isAudioOnlyRadio &&
        ffmpegAvailable &&
        t > 1.5 &&
        video.videoWidth === 0 &&
        activeEngine !== 'transcode' &&
        activeEngine !== 'transcode_ts'
      ) {
        triggerEscalationForMount(mountIdRef.current, 'Unsupported video codec detected.');
        return;
      }

      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }

      // Persist watch progress after initial 2s playback and every 5 seconds thereafter
      const totalPos = isRemuxSeekingEngine ? streamStartOffset + t : t;
      const totalDur = d > 0 ? d : knownDuration;
      if (totalPos > 0) latestPosRef.current = totalPos;
      if (totalDur > 0) latestDurRef.current = totalDur;

      const shouldInitialSave = lastSavedTimeRef.current === 0 && totalPos >= 2;
      if (
        !isLive &&
        capturedOnProgress &&
        activeMediaIdRef.current === capturedMediaId &&
        (shouldInitialSave || Math.abs(totalPos - lastSavedTimeRef.current) >= 5)
      ) {
        lastSavedTimeRef.current = totalPos;
        capturedOnProgress(totalPos, totalDur, computeCompleted(totalPos, totalDur));
      }
    };

    const onEnded = () => {
      setIsPlaying(false);
      const finalDur =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0) ||
        knownDuration ||
        latestDurRef.current ||
        latestPosRef.current ||
        1;
      flushProgressNow(finalDur, finalDur, true);
      if (settings.autoPlayNextEpisode && onNextItem && !isLive) {
        setNextCountdown(10);
      }
    };

    const onVisibilityOrUnload = () => {
      if (document.visibilityState === 'hidden') {
        flushProgressNow();
        flushPendingSavesSync();
      }
    };
    const onPageHide = () => {
      flushProgressNow();
      flushPendingSavesSync();
    };

    const onError = () => {
      const currentMount = mountIdRef.current;
      // Ignore phantom empty-src error events during teardown
      if (
        !video.getAttribute('src') &&
        !video.srcObject &&
        !hlsRef.current &&
        !mpegtsRef.current &&
        !dashRef.current
      ) {
        return;
      }
      const err = video.error;
      const codeMap: Record<number, string> = {
        1: 'Playback interrupted.',
        2: 'Connection interrupted while loading stream.',
        3: 'Video format requires compatibility playback.',
        4: 'Video format requires compatibility playback.',
      };
      const detail = err ? codeMap[err.code] || 'Stream playback failed.' : 'Stream playback failed.';
      triggerEscalationForMount(currentMount, detail, false);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('playing', onCanPlay);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibilityOrUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      flushProgressNow();
      if (flushMediaProgressRef.current) {
        flushMediaProgressRef.current = null;
      }
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onCanPlay);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibilityOrUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
    };
  }, [
    media.id,
    activeEngine,
    clearWatchdog,
    ffmpegAvailable,
    isAudioOnlyRadio,
    isLive,
    isRemuxSeekingEngine,
    knownDuration,
    onNextItem,
    settings.autoPlayNextEpisode,
    streamStartOffset,
    triggerEscalationForMount,
  ]);

  // Next Episode Auto-Play Countdown
  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0) {
      setNextCountdown(null);
      onNextItem?.();
      return;
    }
    const id = window.setTimeout(
      () => setNextCountdown((c) => (c !== null ? c - 1 : null)),
      1000
    );
    return () => window.clearTimeout(id);
  }, [nextCountdown, onNextItem]);

  // Fullscreen listener
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Auto-hide controls
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (openMenu === 'none' && isPlaying) {
        setControlsVisible(false);
      }
    }, 3400);
  }, [isPlaying, openMenu]);

  useEffect(() => {
    pokeControls();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [isPlaying, openMenu, pokeControls]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekTo = useCallback(
    (targetSeconds: number) => {
      const v = videoRef.current;
      if (!v || isLive) return;
      const clamped = Math.max(
        0,
        effectiveDuration > 0 ? Math.min(effectiveDuration, targetSeconds) : targetSeconds
      );
      if (isRemuxSeekingEngine) {
        setStreamStartOffset(clamped);
        setReloadNonce((n) => n + 1);
      } else {
        v.currentTime = clamped;
      }
    },
    [effectiveDuration, isLive, isRemuxSeekingEngine]
  );

  const seekBy = useCallback(
    (delta: number) => {
      if (isLive) return;
      seekTo(displayTime + delta);
      setSeekFeedback(delta > 0 ? `+${delta}s` : `${delta}s`);
      window.setTimeout(() => setSeekFeedback(null), 700);
    },
    [displayTime, isLive, seekTo]
  );

  const handleVolumeChange = (val: number) => {
    const clamped = Math.max(0, Math.min(1, Math.round(val * 100) / 100));
    const nextMuted = clamped === 0;
    const v = videoRef.current;
    setVolume(clamped);
    setIsMuted(nextMuted);
    if (!nextMuted) setAutoMutedNotice(false);
    if (v) {
      v.volume = clamped;
      v.muted = nextMuted;
    }
    onUpdatePlayerPrefsRef.current?.({
      playerVolume: clamped,
      playerMuted: nextMuted,
    });
  };

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nextMuted = !isMuted;
    let nextVolume = volume;
    v.muted = nextMuted;
    setIsMuted(nextMuted);
    if (!nextMuted) {
      setAutoMutedNotice(false);
      if (volume === 0) {
        nextVolume = 0.7;
        v.volume = nextVolume;
        setVolume(nextVolume);
      }
    }
    onUpdatePlayerPrefsRef.current?.({
      playerVolume: nextVolume,
      playerMuted: nextMuted,
    });
  }, [isMuted, volume]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // ignore if browser blocks
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      // ignore
    }
  }, []);

  const changeSpeed = (rate: number) => {
    const v = videoRef.current;
    setPlaybackRate(rate);
    if (v) v.playbackRate = rate;
    onUpdatePlayerPrefsRef.current?.({ playerPlaybackRate: rate });
  };

  const selectQuality = (id: number) => {
    setCurrentQuality(id);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = id;
    } else if (dashRef.current) {
      if (id === -1) {
        dashRef.current.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: true } } },
        });
      } else {
        dashRef.current.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: false } } },
        });
        dashRef.current.setRepresentationForTypeByIndex('video', id, true);
      }
    }
  };

  const selectAudioTrack = (id: number) => {
    setCurrentAudioTrack(id);
    if (hlsRef.current) hlsRef.current.audioTrack = id;
  };

  const selectSubtitleTrack = (id: number) => {
    setCurrentSubtitleTrack(id);
    if (hlsRef.current) {
      hlsRef.current.subtitleTrack = id;
    }
    const v = videoRef.current;
    if (v && v.textTracks.length > 0) {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = id === 999 ? 'showing' : 'hidden';
      }
    }
  };

  const handleSubtitleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const vttText = file.name.toLowerCase().endsWith('.srt') ? convertSrtToVtt(text) : text;
    if (localSubUrl) URL.revokeObjectURL(localSubUrl);
    const blobUrl = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    setLocalSubUrl(blobUrl);
    setLocalSubLabel(file.name);
    setCurrentSubtitleTrack(999);
    e.target.value = '';
  };

  const switchCompatibilityMode = (pref: 'auto' | 'transcode') => {
    const plan = buildFallbackPlan(media, pref, ffmpegAvailable);
    planRef.current = plan;
    stepIndexRef.current = 0;
    setEngineOverride(pref);
    if (!isLive && displayTime > 2) {
      setStreamStartOffset(Math.floor(displayTime));
    }
    setActiveEngine(plan[0]?.engine || 'direct');
    setActiveUrl(plan[0]?.url || media.streamUrl);
    setActiveStepUseProxy(plan[0]?.useProxy ?? true);
    setStatusMessage(plan[0]?.stageMessage || 'Connecting...');
    setGeoBlockedDetected(false);
    setErrorMessage(null);
    setReloadNonce((n) => n + 1);
    setOpenMenu('none');
  };

  const handleRetry = () => {
    const plan = buildFallbackPlan(media, engineOverride, ffmpegAvailable);
    planRef.current = plan;
    stepIndexRef.current = 0;
    setActiveEngine(plan[0]?.engine || 'direct');
    setActiveUrl(plan[0]?.url || media.streamUrl);
    setActiveStepUseProxy(plan[0]?.useProxy ?? true);
    setStatusMessage(plan[0]?.stageMessage || 'Connecting...');
    setGeoBlockedDetected(false);
    setErrorMessage(null);
    setReloadNonce((n) => n + 1);
  };

  // Keyboard shortcuts (Commercial cinema + Android TV remote controls)
  useEffect(() => {
    if (embedded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      pokeControls();
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (isLive) onNextItem?.();
          else seekBy(10);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (isLive) onPrevItem?.();
          else seekBy(-10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (isLive && onPrevItem) onPrevItem();
          else handleVolumeChange(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (isLive && onNextItem) onNextItem();
          else handleVolumeChange(Math.max(0, volume - 0.1));
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          togglePiP();
          break;
        case 'Escape':
          if (openMenu !== 'none') setOpenMenu('none');
          else {
            flushMediaProgressRef.current?.();
            onClose?.();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    embedded,
    isLive,
    onClose,
    onNextItem,
    onPrevItem,
    openMenu,
    pokeControls,
    seekBy,
    toggleFullscreen,
    toggleMute,
    togglePiP,
    togglePlay,
    volume,
  ]);

  const handleVideoSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (openMenu !== 'none') {
      setOpenMenu('none');
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const now = Date.now();
    const side: 'left' | 'right' = relX < 0.5 ? 'left' : 'right';

    if (
      !isLive &&
      lastTapRef.current &&
      now - lastTapRef.current.time < 300 &&
      lastTapRef.current.side === side &&
      (relX < 0.35 || relX > 0.65)
    ) {
      seekBy(side === 'right' ? 10 : -10);
      lastTapRef.current = null;
      return;
    }
    lastTapRef.current = { time: now, side };
    togglePlay();
  };

  const aspectStyleClass =
    aspectRatio === 'fill'
      ? 'w-full h-full object-cover'
      : aspectRatio === 'fit'
      ? 'w-full h-full object-contain'
      : aspectRatio === '16:9'
      ? 'w-full max-h-full aspect-video object-fill'
      : aspectRatio === '4:3'
      ? 'h-full max-w-full aspect-[4/3] object-fill'
      : 'w-full h-full object-contain';

  const qualityLabel = formatQualityBadge(videoDims.h);

  const showSkipIntro =
    !isLive &&
    typeof media.introStart === 'number' &&
    typeof media.introEnd === 'number' &&
    displayTime >= media.introStart &&
    displayTime < media.introEnd;

  const wrapperClass = embedded
    ? 'relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-white/10 select-none'
    : 'fixed inset-0 z-50 bg-black flex flex-col justify-center items-center select-none';

  return (
    <div
      ref={containerRef}
      onMouseMove={pokeControls}
      onTouchStart={pokeControls}
      className={wrapperClass}
    >
      {/* Hidden subtitle upload input */}
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".vtt,.srt"
        className="hidden"
        onChange={handleSubtitleFileUpload}
      />

      {/* Video Surface */}
      <div
        onClick={handleVideoSurfaceClick}
        className="w-full h-full flex items-center justify-center bg-black relative overflow-hidden"
      >
        <video
          ref={videoRef}
          playsInline
          crossOrigin={activeStepUseProxy && !media.isLocalBlob ? 'anonymous' : undefined}
          className={aspectStyleClass}
        >
          {localSubUrl && (
            <track
              kind="subtitles"
              src={localSubUrl}
              label={localSubLabel || 'Loaded Subtitle'}
              default={currentSubtitleTrack === 999}
            />
          )}
        </video>

        {/* Auto-Muted Unmute Prompt (when browser autoplay policy mutes initial playback) */}
        {autoMutedNotice && isMuted && !errorMessage && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleMute();
            }}
            className="absolute top-16 left-4 sm:left-6 z-30 px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold inline-flex items-center gap-2 shadow-xl transition-colors"
          >
            <VolumeX className="w-4 h-4" />
            {isTr ? 'Sesi Açmak İçin Dokunun' : 'Tap to Unmute'}
          </button>
        )}

        {/* Explicit Play Trigger if browser blocked even muted autoplay */}
        {autoplayBlocked && !isPlaying && !errorMessage && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const v = videoRef.current;
              if (v) {
                v.muted = false;
                setIsMuted(false);
                setAutoMutedNotice(false);
                setAutoplayBlocked(false);
                v.play().catch(() => {});
              }
            }}
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
            aria-label={t('common.play')}
          >
            <span className="w-16 h-16 rounded-full bg-[#E50914] hover:bg-[#F6121D] text-white flex items-center justify-center shadow-2xl transition-transform hover:scale-105">
              <Play className="w-7 h-7 fill-current ml-1" />
            </span>
          </button>
        )}

        {/* Seek feedback indicator */}
        {seekFeedback && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-5 py-2.5 rounded-xl bg-black/75 border border-white/15 text-white font-mono text-lg font-semibold tabular-nums">
              {seekFeedback}
            </div>
          </div>
        )}

        {/* Clean Buffering Spinner */}
        {isBuffering && !errorMessage && !autoplayBlocked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/45 pointer-events-none gap-3 px-4 text-center">
            <Loader2 className="w-10 h-10 text-[#E50914] animate-spin" />
            <p className="text-sm font-medium text-white/90">
              {isTr ? STAGE_MESSAGE_TR[statusMessage] || statusMessage : statusMessage}
            </p>
          </div>
        )}

        {/* Clean Commercial Error Overlay */}
        {errorMessage && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 flex flex-col items-center justify-center bg-[#08090D]/92 backdrop-blur-sm p-6 text-center z-20"
          >
            <div className="max-w-md w-full bg-[#12141B] border border-white/10 rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
              <div className="w-12 h-12 rounded-full bg-[#E50914]/15 text-[#E50914] flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-base sm:text-lg font-bold text-white">
                  {geoBlockedDetected
                    ? isTr
                      ? 'Mevcut Bölgede Kullanılamıyor'
                      : 'Unavailable in Current Region'
                    : isLive
                    ? isTr
                      ? 'Kanal Şu An Açılamıyor'
                      : 'Channel Temporarily Unavailable'
                    : t('player.errorTitle')}
                </h3>
                <p className="text-xs sm:text-sm text-[#9CA3B2] leading-relaxed">
                  {geoBlockedDetected
                    ? isTr
                      ? 'Bu yayın IPTV sağlayıcınız tarafından mevcut sunucu bölgesi için kısıtlanmış olabilir.'
                      : 'This broadcast is restricted by your IPTV provider for the current server region.'
                    : isLive
                    ? isTr
                      ? 'Şu anda bu canlı yayına bağlanılamadı. Tekrar deneyebilir veya başka bir kanala geçebilirsiniz.'
                      : 'We could not connect to this broadcast right now. Please try again or switch to another channel.'
                    : t('player.errorSubtitle')}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2.5 w-full pt-1">
                <button
                  type="button"
                  onClick={handleRetry}
                  className="px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('player.retry')}
                </button>

                {ffmpegAvailable && !media.isLocalBlob && !isCompatibilityModeActive && (
                  <button
                    type="button"
                    onClick={() => switchCompatibilityMode('transcode')}
                    className="px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                    {t('player.tryCompatMode')}
                  </button>
                )}

                {isLive && onNextItem && (
                  <button
                    type="button"
                    onClick={onNextItem}
                    className="px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    {t('player.nextChannel')}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}

                {isLive && onMarkUnavailable && (
                  <button
                    type="button"
                    onClick={onMarkUnavailable}
                    className="px-3.5 py-2.5 rounded-lg border border-white/15 hover:bg-white/5 text-[#9CA3B2] hover:text-white text-xs transition-colors whitespace-nowrap"
                  >
                    {t('live.hideChannel')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Skip Intro Button */}
      {showSkipIntro && (
        <button
          type="button"
          onClick={() => seekTo(media.introEnd!)}
          className="absolute right-6 bottom-24 z-20 px-4 py-2 rounded-lg bg-black/80 hover:bg-white hover:text-black border border-white/40 text-white text-sm font-semibold transition-colors"
        >
          {t('player.skipIntro')}
        </button>
      )}

      {/* Auto-Play Next Episode Countdown */}
      {nextCountdown !== null && onNextItem && (
        <div className="absolute right-6 bottom-24 z-30 bg-[#12141B]/95 border border-white/15 rounded-xl p-4 w-72 shadow-2xl">
          <p className="text-xs text-[#9CA3B2]">{t('player.nextEpisodeIn', { sec: nextCountdown })}</p>
          <p className="text-sm font-semibold text-white truncate mt-0.5">
            {nextLabel || (isTr ? 'Sonraki Bölüm' : 'Next Episode')}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={() => {
                setNextCountdown(null);
                onNextItem();
              }}
              className="flex-1 py-2 px-3 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold transition-colors"
            >
              {t('player.playNextNow')}
            </button>
            <button
              type="button"
              onClick={() => setNextCountdown(null)}
              className="py-2 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors"
            >
              {t('player.cancelNext')}
            </button>
          </div>
        </div>
      )}

      {/* TOP BAR HUD */}
      <div
        className={`absolute top-0 inset-x-0 z-20 px-4 sm:px-6 pt-4 pb-10 bg-gradient-to-b from-black/85 via-black/45 to-transparent flex items-center justify-between gap-4 transition-opacity duration-200 ${
          controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {!embedded && onClose && (
            <button
              type="button"
              onClick={() => {
                flushMediaProgressRef.current?.();
                onClose();
              }}
              aria-label={t('player.closePlayer')}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold text-white truncate leading-tight">
              {cleanMediaTitle(media.title)}
            </h2>
            {(media.subtitle || qualityLabel) && (
              <p className="text-xs text-white/70 truncate">
                {[
                  media.type === 'episode' && media.subtitle
                    ? cleanDisplaySubtitle(media.subtitle)
                    : media.subtitle,
                  qualityLabel,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
        </div>

        {embedded && onExpandFullscreenView && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onExpandFullscreenView}
              aria-label={isTr ? 'Tam ekran sinema oynatıcısını aç' : 'Open full cinema player'}
              className="px-3.5 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold whitespace-nowrap transition-colors"
            >
              {isTr ? 'Tam Oynatıcı' : 'Full Player'}
            </button>
          </div>
        )}
      </div>

      {/* SETTINGS POPOVER (Aspect Ratio, Speed, Quality, Audio, Compatibility Mode) */}
      {openMenu === 'settings' && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-24 right-4 sm:right-6 z-30 w-72 max-h-[65vh] overflow-y-auto bg-[#12141B]/96 backdrop-blur-md border border-white/15 rounded-xl p-4 shadow-2xl space-y-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">{t('player.playbackSettings')}</h3>
            <button
              type="button"
              onClick={() => setOpenMenu('none')}
              className="text-[#9CA3B2] hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Aspect Ratio */}
          <div>
            <p className="text-[#9CA3B2] mb-1.5 font-medium">{t('player.aspectRatio')}</p>
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_OPTIONS.map((a) => {
                const label =
                  a.value === 'auto'
                    ? t('player.aspectAuto')
                    : a.value === 'fit'
                    ? t('player.aspectFit')
                    : a.value === 'fill'
                    ? t('player.aspectFill')
                    : a.label;
                return (
                  <button
                    key={a.value}
                    type="button"
                    onClick={() => setAspectRatio(a.value)}
                    className={`px-2.5 py-1.5 rounded-md font-medium transition-colors ${
                      aspectRatio === a.value
                        ? 'bg-[#E50914] text-white'
                        : 'bg-white/5 hover:bg-white/10 text-white/80'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Playback Speed (VOD only) */}
          {!isLive && (
            <div>
              <p className="text-[#9CA3B2] mb-1.5 font-medium">{t('player.playbackSpeed')}</p>
              <div className="grid grid-cols-3 gap-1.5">
                {SPEED_OPTIONS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => changeSpeed(sp)}
                    className={`py-1.5 rounded-md font-mono tabular-nums font-medium transition-colors ${
                      playbackRate === sp
                        ? 'bg-[#E50914] text-white'
                        : 'bg-white/5 hover:bg-white/10 text-white/80'
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quality Selection */}
          {qualities.length > 0 && (
            <div>
              <p className="text-[#9CA3B2] mb-1.5 font-medium">{t('player.quality')}</p>
              <div className="flex flex-wrap gap-1.5">
                {qualities.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => selectQuality(q.id)}
                    className={`px-2.5 py-1.5 rounded-md font-mono tabular-nums transition-colors ${
                      currentQuality === q.id
                        ? 'bg-[#E50914] text-white'
                        : 'bg-white/5 hover:bg-white/10 text-white/80'
                    }`}
                  >
                    {q.id === -1 ? t('player.modeAuto') : q.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Audio Tracks */}
          {audioTracks.length > 1 && (
            <div>
              <p className="text-[#9CA3B2] mb-1.5 font-medium">{t('player.audioTrack')}</p>
              <div className="space-y-1">
                {audioTracks.map((tItem) => (
                  <button
                    key={tItem.id}
                    type="button"
                    onClick={() => selectAudioTrack(tItem.id)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-md transition-colors ${
                      currentAudioTrack === tItem.id
                        ? 'bg-[#E50914] text-white'
                        : 'bg-white/5 hover:bg-white/10 text-white/80'
                    }`}
                  >
                    {tItem.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Compatibility Mode */}
          {ffmpegAvailable && !media.isLocalBlob && (
            <div className="pt-2 border-t border-white/10">
              <p className="text-[#9CA3B2] mb-1.5 font-medium">
                {isTr ? 'Oynatma Modu' : 'Playback Mode'}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => switchCompatibilityMode('auto')}
                  className={`py-1.5 px-2.5 rounded-md font-medium transition-colors ${
                    engineOverride !== 'transcode'
                      ? 'bg-[#E50914] text-white'
                      : 'bg-white/5 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {t('player.modeAuto')}
                </button>
                <button
                  type="button"
                  onClick={() => switchCompatibilityMode('transcode')}
                  className={`py-1.5 px-2.5 rounded-md font-medium transition-colors ${
                    engineOverride === 'transcode'
                      ? 'bg-[#E50914] text-white'
                      : 'bg-white/5 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {t('player.modeTranscode')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUBTITLES POPOVER */}
      {openMenu === 'subtitles' && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-24 right-4 sm:right-16 z-30 w-64 bg-[#12141B]/96 backdrop-blur-md border border-white/15 rounded-xl p-4 shadow-2xl space-y-3 text-xs"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">{t('player.subtitles')}</h3>
            <button
              type="button"
              onClick={() => setOpenMenu('none')}
              className="text-[#9CA3B2] hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => selectSubtitleTrack(-1)}
              className={`w-full text-left px-2.5 py-1.5 rounded-md transition-colors ${
                currentSubtitleTrack === -1
                  ? 'bg-[#E50914] text-white'
                  : 'bg-white/5 hover:bg-white/10 text-white/80'
              }`}
            >
              {t('player.subtitlesOff')}
            </button>
            {subtitleTracks.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => selectSubtitleTrack(s.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-md transition-colors ${
                  currentSubtitleTrack === s.id
                    ? 'bg-[#E50914] text-white'
                    : 'bg-white/5 hover:bg-white/10 text-white/80'
                }`}
              >
                {s.label}
              </button>
            ))}
            {localSubUrl && (
              <button
                type="button"
                onClick={() => selectSubtitleTrack(999)}
                className={`w-full text-left px-2.5 py-1.5 rounded-md truncate transition-colors ${
                  currentSubtitleTrack === 999
                    ? 'bg-[#E50914] text-white'
                    : 'bg-white/5 hover:bg-white/10 text-white/80'
                }`}
              >
                {localSubLabel}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => subtitleInputRef.current?.click()}
            className="w-full py-2 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-white font-medium inline-flex items-center justify-center gap-2 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            {isTr ? '.SRT / .VTT Altyazı Yükle' : 'Load .SRT / .VTT File'}
          </button>
        </div>
      )}

      {/* BOTTOM CONTROLS BAR */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute bottom-0 inset-x-0 z-20 px-4 sm:px-6 pb-4 pt-12 bg-gradient-to-t from-black/92 via-black/60 to-transparent transition-opacity duration-200 ${
          controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Timeline Scrubber (VOD) or Live Indicator */}
        {!isLive ? (
          <div className="mb-3 flex items-center gap-3">
            <span className="text-xs font-mono tabular-nums text-white/90 min-w-[48px]">
              {formatDuration(displayTime)}
            </span>
            <div className="relative flex-1 h-5 flex items-center group/scrub">
              <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
                {effectiveDuration > 0 && (
                  <div
                    className="h-full bg-white/35"
                    style={{
                      width: `${Math.min(
                        100,
                        ((isRemuxSeekingEngine ? streamStartOffset + bufferedEnd : bufferedEnd) /
                          effectiveDuration) *
                          100
                      )}%`,
                    }}
                  />
                )}
              </div>
              <div
                className="absolute left-0 h-1.5 rounded-full bg-[#E50914] pointer-events-none"
                style={{
                  width:
                    effectiveDuration > 0
                      ? `${Math.min(100, (displayTime / effectiveDuration) * 100)}%`
                      : '0%',
                }}
              />
              <input
                type="range"
                aria-label="Seek timeline"
                min={0}
                max={effectiveDuration > 0 ? effectiveDuration : 100}
                step={1}
                value={effectiveDuration > 0 ? Math.min(effectiveDuration, displayTime) : 0}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="absolute inset-0 w-full opacity-0 cursor-pointer"
              />
            </div>
            <span className="text-xs font-mono tabular-nums text-white/70 min-w-[48px] text-right">
              {effectiveDuration > 0 ? formatDuration(effectiveDuration) : '--:--'}
            </span>
          </div>
        ) : (
          <div className="mb-3 flex items-center justify-between">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-white">
              <span className="w-2 h-2 rounded-full bg-[#E50914]" />
              <span>{t('player.liveBadge')}</span>
            </div>
            <button
              type="button"
              onClick={handleRetry}
              className="text-xs text-white/75 hover:text-white inline-flex items-center gap-1 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              {isTr ? 'Yayını Yenile' : 'Sync Live'}
            </button>
          </div>
        )}

        {/* Controls Row */}
        <div className="flex items-center justify-between gap-2">
          {/* Left Controls */}
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={t('player.playPause')}
              className="w-10 h-10 rounded-full bg-white text-black hover:bg-white/90 flex items-center justify-center transition-colors"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-current" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-0.5" />
              )}
            </button>

            {!isLive && (
              <>
                <button
                  type="button"
                  onClick={() => seekBy(-10)}
                  aria-label={t('player.rewind10')}
                  className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
                >
                  <Rewind className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => seekBy(10)}
                  aria-label={t('player.forward10')}
                  className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
                >
                  <FastForward className="w-4 h-4" />
                </button>
              </>
            )}

            {onPrevItem && (
              <button
                type="button"
                onClick={onPrevItem}
                title={prevLabel || (isLive ? t('player.prevChannel') : isTr ? 'Önceki Bölüm' : 'Previous Episode')}
                aria-label={prevLabel || t('player.prevChannel')}
                className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
              >
                {isLive ? <ChevronLeft className="w-5 h-5" /> : <SkipBack className="w-4 h-4" />}
              </button>
            )}

            {onNextItem && (
              <button
                type="button"
                onClick={onNextItem}
                title={nextLabel || (isLive ? t('player.nextChannel') : isTr ? 'Sonraki Bölüm' : 'Next Episode')}
                aria-label={nextLabel || t('player.nextChannel')}
                className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
              >
                {isLive ? <ChevronRight className="w-5 h-5" /> : <SkipForward className="w-4 h-4" />}
              </button>
            )}

            {/* Volume */}
            <div className="hidden sm:flex items-center gap-2 ml-1">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={t('player.mute')}
                className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                type="range"
                aria-label={isTr ? 'Ses Düzeyi' : 'Volume'}
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                className="w-20 accent-[#E50914] cursor-pointer"
              />
            </div>
          </div>

          {/* Right Controls */}
          <div className="flex items-center gap-1 sm:gap-1.5">
            <button
              type="button"
              onClick={() => setOpenMenu((m) => (m === 'subtitles' ? 'none' : 'subtitles'))}
              aria-label={t('player.subtitles')}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                openMenu === 'subtitles' || currentSubtitleTrack >= 0
                  ? 'bg-[#E50914] text-white'
                  : 'hover:bg-white/15 text-white'
              }`}
            >
              <Captions className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setOpenMenu((m) => (m === 'settings' ? 'none' : 'settings'))}
              aria-label={t('player.playbackSettings')}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                openMenu === 'settings' ? 'bg-[#E50914] text-white' : 'hover:bg-white/15 text-white'
              }`}
            >
              <Settings2 className="w-4 h-4" />
            </button>

            {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
              <button
                type="button"
                onClick={togglePiP}
                aria-label={t('player.pip')}
                className="hidden sm:flex w-9 h-9 rounded-lg hover:bg-white/15 text-white items-center justify-center transition-colors"
              >
                <PictureInPicture2 className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={t('player.fullscreen')}
              className="w-9 h-9 rounded-lg hover:bg-white/15 text-white flex items-center justify-center transition-colors"
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
