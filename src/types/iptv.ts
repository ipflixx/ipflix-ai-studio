export type PlaylistType = 'xtream' | 'm3u_url' | 'm3u_file' | 'local' | 'demo';

export type StreamEnginePreference =
  | 'auto'
  | 'hls'
  | 'mpegts'
  | 'dash'
  | 'direct'
  | 'audiofix'
  | 'transcode';

export type AspectRatioMode = 'auto' | '16:9' | '4:3' | 'fit' | 'fill';

export type NavSection =
  | 'home'
  | 'live'
  | 'movies'
  | 'series'
  | 'categories'
  | 'favorites'
  | 'search'
  | 'settings';

export interface XtreamAccountInfo {
  username: string;
  status: string;
  expDate?: string;
  isTrial?: string;
  activeCons?: string;
  maxConnections?: string;
  createdAt?: string;
  allowedOutputFormats?: string[];
  serverTimezone?: string;
  serverProtocol?: string;
  httpsPort?: string;
  httpsBaseUrl?: string;
}

export interface PlaylistSource {
  id: string;
  name: string;
  type: PlaylistType;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
  // Xtream config
  serverUrl?: string;
  resolvedServerUrl?: string;
  username?: string;
  password?: string;
  accountInfo?: XtreamAccountInfo;
  // M3U config
  m3uUrl?: string;
  // EPG config
  epgUrl?: string;
  // Marker indicating credentials are stored in encrypted vault (used for safe decrypt verification)
  hasEncryptedSecrets?: boolean;
  // Connection tuning
  userAgent?: string;
  liveFormat?: 'auto' | 'm3u8' | 'ts';
  // Counts
  channelCount: number;
  movieCount: number;
  seriesCount: number;
}

export interface LiveChannel {
  id: string;
  num: number;
  name: string;
  streamUrl: string;
  altStreamUrl?: string; // e.g., HLS fallback for TS or TS fallback for HLS
  httpsStreamUrl?: string; // HTTPS endpoint derived from Xtream server_info.https_port
  directSourceUrl?: string; // Direct HTTPS source when supplied by provider
  streamId?: string;
  logo?: string;
  category: string;
  normalizedCategory: string;
  epgId?: string;
  country?: string;
  language?: string;
  catchup?: boolean;
  catchupSource?: string;
  catchupDays?: number;
  customUserAgent?: string;
  customReferer?: string;
  isDemo?: boolean;
}

export interface MovieItem {
  id: string;
  name: string;
  streamUrl: string;
  httpsStreamUrl?: string;
  streamId?: string;
  containerExtension?: string;
  poster?: string;
  backdrop?: string;
  category: string;
  genre?: string;
  year?: string;
  rating?: number;
  duration?: string;
  durationSeconds?: number;
  plot?: string;
  director?: string;
  cast?: string;
  language?: string;
  country?: string;
  trailerUrl?: string;
  addedAt?: number;
  subtitles?: SubtitleTrackInfo[];
  audioTracksInfo?: string[];
  customUserAgent?: string;
  customReferer?: string;
  isLocal?: boolean;
  isDemo?: boolean;
}

export interface EpisodeItem {
  id: string;
  seriesId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  streamUrl: string;
  httpsStreamUrl?: string;
  containerExtension?: string;
  thumbnail?: string;
  plot?: string;
  duration?: string;
  durationSeconds?: number;
  rating?: number;
  airDate?: string;
  introStart?: number;
  introEnd?: number;
  customUserAgent?: string;
  customReferer?: string;
}

export interface SeasonGroup {
  seasonNumber: number;
  name: string;
  episodes: EpisodeItem[];
}

export interface SeriesItem {
  id: string;
  name: string;
  seriesId?: string;
  poster?: string;
  backdrop?: string;
  category: string;
  genre?: string;
  year?: string;
  rating?: number;
  plot?: string;
  director?: string;
  cast?: string;
  trailerUrl?: string;
  addedAt?: number;
  seasons: SeasonGroup[];
  seasonsLoaded?: boolean;
  isDemo?: boolean;
}

export interface SubtitleTrackInfo {
  id: string;
  label: string;
  language: string;
  url: string;
}

export interface EpgProgram {
  id: string;
  channelId: string;
  title: string;
  description?: string;
  start: number; // epoch ms
  end: number;   // epoch ms
  category?: string;
}

export interface PlaylistCatalog {
  playlistId: string;
  channels: LiveChannel[];
  movies: MovieItem[];
  series: SeriesItem[];
  epgPrograms: Record<string, EpgProgram[]>; // keyed by lowercase epgId or channel name
  epgUpdatedAt?: number;
}

export interface WatchProgress {
  itemId: string;
  type: 'movie' | 'episode' | 'live';
  title: string;
  subtitle?: string;
  poster?: string;
  backdrop?: string;
  position: number;
  duration: number;
  updatedAt: number;
  completed?: boolean;
  completedAt?: number;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeId?: string;
}

export interface PlayerMediaItem {
  id: string;
  type: 'live' | 'movie' | 'episode' | 'local';
  title: string;
  subtitle?: string;
  streamUrl: string;
  altStreamUrl?: string;
  httpsStreamUrl?: string;
  directSourceUrl?: string;
  poster?: string;
  backdrop?: string;
  containerExtension?: string;
  userAgent?: string;
  referer?: string;
  channel?: LiveChannel;
  movie?: MovieItem;
  series?: SeriesItem;
  episode?: EpisodeItem;
  introStart?: number;
  introEnd?: number;
  subtitles?: SubtitleTrackInfo[];
  isLocalBlob?: boolean;
  resumePosition?: number;
}

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  read?: boolean;
}

export type AppLanguage = 'tr' | 'en';

export type ProfileAvatarId =
  | 'crimson'
  | 'cobalt'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'coral'
  | 'teal'
  | 'kids';

export interface UserProfile {
  id: string;
  name: string;
  avatarId: ProfileAvatarId;
  pin?: string; // 4-digit numeric string when PIN-locked (encrypted at rest)
  hasPin?: boolean;
  isKids: boolean;
  isGuest?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export type ProfileListType = 'favorite' | 'watchlist' | 'hidden_channel' | 'recent_channel';

export interface ProfileData {
  favorites: string[];
  watchlist?: string[];
  watchProgress: Record<string, WatchProgress>;
  recentChannels: string[];
  hiddenChannels: string[];
  /** Last watched live channel ID for this profile */
  lastLiveChannelId?: string;
  /** Last selected Live TV category tab/group for this profile */
  lastLiveCategory?: string;
  /** Durable per-profile recent smart search queries */
  recentSearches?: string[];
  /** Per-item timestamps keyed by `${listType}:${itemId}` */
  listTimestamps?: Record<string, number>;
  /** Epoch ms when watch history was last explicitly cleared for this profile */
  clearedHistoryAt?: number;
}

export interface PersistedAppState {
  schemaVersion: number;
  updatedAt: number;
  onboardingCompleted: boolean;
  activePlaylistId: string | null;
  activeProfileId: string | null;
  settings: AppSettings;
  settingsUpdatedAt: number;
  playlists: PlaylistSource[];
  deletedPlaylists: Record<string, number>;
  profiles: UserProfile[];
  deletedProfiles: Record<string, number>;
  profileData: Record<string, ProfileData>;
  notifications: AppNotification[];
}

export interface AppSettings {
  language: AppLanguage;
  useServerProxy: boolean;
  directStreamFirst: boolean;
  customRelayUrl: string;
  defaultEngine: StreamEnginePreference;
  defaultUserAgent: string;
  defaultAspectRatio: AspectRatioMode;
  autoPlayNextEpisode: boolean;
  preferredSubtitleLang: string;
  lowBandwidthMode: boolean;
  tvRemoteMode: boolean;
  introSoundEnabled: boolean;
  hideUnavailableChannels: boolean;
  epgTimeOffsetHours: number;
  customEpgUrl: string;
  /** Persisted video player audio volume (0..1) */
  playerVolume: number;
  /** Persisted video player mute state */
  playerMuted: boolean;
  /** Persisted video player playback speed multiplier */
  playerPlaybackRate: number;
  /** Automatically check GitHub Releases / Play Store for updates at startup */
  autoCheckUpdates: boolean;
  /** Optional version string temporarily snoozed by the user */
  skippedUpdateVersion?: string;
}

export type UpdateStatusKind =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'no_releases'
  | 'asset_missing'
  | 'play_store_managed'
  | 'error';

export type UpdateDownloadStage =
  | 'idle'
  | 'downloading'
  | 'verifying_sha256'
  | 'verified'
  | 'installing'
  | 'error';

export interface PlatformUpdateMetadata {
  version: string;
  versionCode: number;
  tagName: string;
  releaseName: string;
  releaseDate: string;
  changelog: string;
  downloadUrl: string | null;
  assetName: string | null;
  assetSizeBytes: number | null;
  sha256: string | null;
  sha256Source?: 'asset' | 'manifest' | 'body' | 'none';
  minimumSupportedVersion: string;
  mandatoryUpdate: boolean;
  releaseHtmlUrl: string;
}

export interface UpdateCheckResult {
  status: UpdateStatusKind;
  channel:
    | 'windows_electron'
    | 'android_apk'
    | 'google_play'
    | 'android_tv_apk'
    | 'android_tv_play'
    | 'web';
  currentVersion: string;
  currentVersionCode: number;
  checkedAt: number;
  cached: boolean;
  updateAvailable: boolean;
  isExternalApkAllowed: boolean;
  playUpdateImmediateRequired?: boolean;
  playUpdateFlexibleReady?: boolean;
  latest?: PlatformUpdateMetadata;
  message?: string;
  error?: string;
}

export interface UpdateDownloadProgressEvent {
  stage: UpdateDownloadStage;
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  filePath?: string;
  sha256?: string;
  error?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'tr',
  useServerProxy: true,
  directStreamFirst: false,
  customRelayUrl: '',
  defaultEngine: 'auto',
  defaultUserAgent: 'IPTVSmartersPro',
  defaultAspectRatio: 'auto',
  autoPlayNextEpisode: true,
  preferredSubtitleLang: 'tr',
  lowBandwidthMode: false,
  tvRemoteMode: false,
  introSoundEnabled: true,
  hideUnavailableChannels: false,
  epgTimeOffsetHours: 0,
  customEpgUrl: '',
  playerVolume: 1,
  playerMuted: false,
  playerPlaybackRate: 1,
  autoCheckUpdates: true,
};

export const USER_AGENT_PROFILES = [
  { label: 'Otomatik (IPTV Smarters + Akıllı Yeniden Deneme)', value: 'IPTVSmartersPro' },
  { label: 'VLC Media Player', value: 'VLC/3.0.20 LibVLC/3.0.20' },
  { label: 'TiviMate Android TV', value: 'TiviMate/4.7.0 (Linux; Android 13)' },
  { label: 'ExoPlayer Android', value: 'ExoPlayerLib/2.18.1' },
  { label: 'Chrome Desktop', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
];
