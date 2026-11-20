import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  Bell,
  Check,
  ChevronDown,
  Clapperboard,
  Film,
  FolderKanban,
  Globe,
  Heart,
  HelpCircle,
  Home,
  Loader2,
  Lock,
  LogOut,
  Plus,
  Search,
  Server,
  Settings,
  Tv,
  Users,
  X,
} from 'lucide-react';
import type {
  AppLanguage,
  AppNotification,
  AppSettings,
  EpgProgram,
  EpisodeItem,
  LiveChannel,
  MovieItem,
  NavSection,
  PlayerMediaItem,
  PlaylistCatalog,
  PlaylistSource,
  ProfileData,
  SeriesItem,
  UpdateCheckResult,
  UserProfile,
  WatchProgress,
} from './types/iptv';
import { DEFAULT_SETTINGS } from './types/iptv';
import { createOpenSourceDemoBundle, DEMO_PLAYLIST_ID } from './data/openSourceCatalog';
import {
  clearAllUserData,
  createDefaultProfile,
  createGuestProfile,
  deleteCatalog,
  deleteProfileData,
  ensureGuestProfile,
  flushPendingSaves,
  flushPendingSavesSync,
  getStorageDiagnostics,
  hydratePersistentStorage,
  loadActivePlaylistId,
  loadActiveProfileId,
  loadBootLanguageHint,
  loadCatalog,
  loadNotifications,
  loadOnboardingCompleted,
  loadPlaylists,
  loadProfileData,
  loadProfiles,
  loadSettings,
  resetLockedVaultSafely,
  retryVaultRecovery,
  saveActivePlaylistId,
  saveActiveProfileId,
  saveCatalog,
  saveNotifications,
  saveOnboardingCompleted,
  savePlaylists,
  saveProfileData,
  saveProfiles,
  saveSettings,
  subscribeStorageEvents,
  type StorageDiagnostics,
} from './services/storage';
import {
  checkServerCapabilities,
  fetchAndParseM3U,
  fetchXmltvEpg,
  syncXtreamCatalog,
} from './services/iptvApi';
import { I18nProvider, useI18n } from './i18n/I18nContext';
import { useHybridNavigation } from './hooks/useHybridNavigation';
import { cleanMediaTitle } from './utils/titleCleaner';
import { addRecentSearchTerm } from './utils/smartSearch';
import { BrandMark } from './components/BrandMark';
import { ProfileAvatar } from './components/ProfileAvatar';
import { SplashScreen } from './components/SplashScreen';
import { OnboardingView } from './components/OnboardingView';
import { PinPromptModal, ProfileGate } from './components/ProfileGate';
import { UpdateModal } from './components/UpdateModal';
import { HomeView } from './components/HomeView';
import { checkForPlatformUpdates } from './services/updater';
import {
  CategoriesView,
  FavoritesView,
  MoviesView,
  SearchView,
  SeriesView,
} from './components/LibraryViews';

import type { SettingsSection } from './components/SettingsView';

// Lazy-loaded heavy views & modals for crisp startup performance
const LiveTVView = lazy(() =>
  import('./components/LiveTVView').then((m) => ({ default: m.LiveTVView }))
);
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView }))
);
const PlaylistModal = lazy(() =>
  import('./components/PlaylistModal').then((m) => ({ default: m.PlaylistModal }))
);
const MovieDetailPage = lazy(() =>
  import('./components/MovieDetailPage').then((m) => ({ default: m.MovieDetailPage }))
);
const SeriesDetailPage = lazy(() =>
  import('./components/SeriesDetailPage').then((m) => ({ default: m.SeriesDetailPage }))
);
const TrailerModal = lazy(() =>
  import('./components/TrailerModal').then((m) => ({ default: m.TrailerModal }))
);
const VideoPlayer = lazy(() =>
  import('./components/VideoPlayer').then((m) => ({ default: m.VideoPlayer }))
);

type DetailRoute =
  | { kind: 'movie'; item: MovieItem }
  | { kind: 'series'; item: SeriesItem };

const ADULT_CONTENT_REGEX =
  /\b(18\+|xxx|adult|adults|erotic|erotik|porn|porno|yetişkin|yetiskin|for adults|nsfw)\b/i;

function isAdultText(category?: string, name?: string): boolean {
  return ADULT_CONTENT_REGEX.test(`${category || ''} ${name || ''}`);
}

function isWatchProgressCompleted(progress?: WatchProgress | null): boolean {
  if (!progress) return false;
  if (progress.completed) return true;
  return progress.duration > 0 && progress.position / progress.duration >= 0.92;
}

function ViewLoadingFallback() {
  return (
    <div className="min-h-[55vh] flex items-center justify-center">
      <Loader2 className="w-6 h-6 text-[#E50914] animate-spin" />
    </div>
  );
}

function OverlayLoadingFallback() {
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center">
      <Loader2 className="w-7 h-7 text-[#E50914] animate-spin" />
    </div>
  );
}

function AppShell({ onSyncLanguage }: { onSyncLanguage: (next: AppLanguage) => void }) {
  const { lang, setLang, t } = useI18n();

  const [navSection, setNavSection] = useState<NavSection>('home');
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('overview');
  const [searchInitialQuery, setSearchInitialQuery] = useState('');
  const [categoryJump, setCategoryJump] = useState<{ section: NavSection; category: string } | null>(null);

  // Launch & bootstrap flow: SplashScreen (once per cold session) -> Onboarding -> ProfileGate -> Home
  const [initializing, setInitializing] = useState(true);
  const [showSplash, setShowSplash] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem('ipflix_intro_played_v1') !== '1';
    } catch {
      return true;
    }
  });
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSource[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PlaylistCatalog | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [refreshingPlaylistId, setRefreshingPlaylistId] = useState<string | null>(null);

  // Profiles & per-profile isolated data
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>('');
  const [profileGateOpen, setProfileGateOpen] = useState(false);
  const [profileGateManageMode, setProfileGateManageMode] = useState(false);
  const [profileGateDismissible, setProfileGateDismissible] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [dropdownPinTarget, setDropdownPinTarget] = useState<UserProfile | null>(null);

  const [favoritesList, setFavoritesList] = useState<string[]>([]);
  const [watchlistList, setWatchlistList] = useState<string[]>([]);
  const [watchProgress, setWatchProgress] = useState<Record<string, WatchProgress>>({});
  const [recentChannelIds, setRecentChannelIds] = useState<string[]>([]);
  const [hiddenChannelList, setHiddenChannelList] = useState<string[]>([]);
  const [lastLiveChannelId, setLastLiveChannelId] = useState<string | undefined>(undefined);
  const [lastLiveCategory, setLastLiveCategory] = useState<string | undefined>(undefined);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  // Durable Local Storage Diagnostics (Electron userData + DPAPI OR Browser IndexedDB + AES-256-GCM)
  const [storageDiagnostics, setStorageDiagnostics] = useState<StorageDiagnostics>(() =>
    getStorageDiagnostics()
  );

  // Overlays & full-screen detail navigation stack
  const [playlistModalOpen, setPlaylistModalOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistSource | null>(null);
  const [detailStack, setDetailStack] = useState<DetailRoute[]>([]);
  const [activeTrailer, setActiveTrailer] = useState<{ url: string; title: string } | null>(null);
  const [playerMedia, setPlayerMedia] = useState<PlayerMediaItem | null>(null);
  const [playerChannelQueue, setPlayerChannelQueue] = useState<LiveChannel[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; level: 'info' | 'success' | 'error' } | null>(null);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const notifMenuRef = useRef<HTMLDivElement | null>(null);
  const startupUpdateCheckedRef = useRef(false);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || profiles[0] || createDefaultProfile('Ana Profil'),
    [profiles, activeProfileId]
  );

  // Apply Kids Profile filtering cleanly across the entire catalog
  const effectiveCatalog = useMemo<PlaylistCatalog | null>(() => {
    if (!catalog) return null;
    if (!activeProfile.isKids) return catalog;
    return {
      ...catalog,
      channels: catalog.channels.filter((ch) => !isAdultText(ch.category, ch.name)),
      movies: catalog.movies.filter((m) => !isAdultText(m.category, m.name)),
      series: catalog.series.filter((s) => !isAdultText(s.category, s.name)),
    };
  }, [catalog, activeProfile.isKids]);

  const favoritesSet = useMemo(() => new Set(favoritesList), [favoritesList]);
  const watchlistSet = useMemo(() => new Set(watchlistList), [watchlistList]);
  const hiddenChannelSet = useMemo(() => new Set(hiddenChannelList), [hiddenChannelList]);
  const activePlaylist = useMemo(
    () => playlists.find((p) => p.id === activePlaylistId) || playlists[0] || null,
    [playlists, activePlaylistId]
  );

  // Resolve topmost detail view against live catalog so hydrated metadata stays up to date
  const activeDetail = useMemo<DetailRoute | null>(() => {
    if (detailStack.length === 0) return null;
    const top = detailStack[detailStack.length - 1];
    if (top.kind === 'movie') {
      const latest = effectiveCatalog?.movies.find((m) => m.id === top.item.id) || top.item;
      return { kind: 'movie', item: latest };
    }
    const latest = effectiveCatalog?.series.find((s) => s.id === top.item.id) || top.item;
    return { kind: 'series', item: latest };
  }, [detailStack, effectiveCatalog?.movies, effectiveCatalog?.series]);

  const openMovieDetail = useCallback((movie: MovieItem) => {
    setDetailStack((prev) => {
      const top = prev[prev.length - 1];
      if (top?.kind === 'movie' && top.item.id === movie.id) return prev;
      return [...prev.slice(-9), { kind: 'movie', item: movie }];
    });
  }, []);

  const openSeriesDetail = useCallback((series: SeriesItem) => {
    setDetailStack((prev) => {
      const top = prev[prev.length - 1];
      if (top?.kind === 'series' && top.item.id === series.id) return prev;
      return [...prev.slice(-9), { kind: 'series', item: series }];
    });
  }, []);

  const popDetailPage = useCallback(() => {
    setDetailStack((prev) => prev.slice(0, -1));
  }, []);

  // Prevent background page double-scrolling while full-screen Detail Page, Trailer, or Player is open
  const hasFullscreenOverlay =
    detailStack.length > 0 || Boolean(activeTrailer) || Boolean(playerMedia);
  useEffect(() => {
    if (!hasFullscreenOverlay) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [hasFullscreenOverlay]);

  // Close header dropdowns (profile, provider, notifications) on outside click
  useEffect(() => {
    if (!profileDropdownOpen && !providerDropdownOpen && !notificationsOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (profileDropdownOpen && profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setProfileDropdownOpen(false);
      }
      if (providerDropdownOpen && providerMenuRef.current && !providerMenuRef.current.contains(target)) {
        setProviderDropdownOpen(false);
      }
      if (notificationsOpen && notifMenuRef.current && !notifMenuRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [profileDropdownOpen, providerDropdownOpen, notificationsOpen]);

  // Global Ctrl+K / Cmd+K shortcut to focus Home Smart Search from anywhere in the app shell
  useEffect(() => {
    if (showSplash || initializing || !onboardingCompleted || profileGateOpen || Boolean(playerMedia)) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setProfileDropdownOpen(false);
        setProviderDropdownOpen(false);
        setNotificationsOpen(false);
        setActiveTrailer(null);
        setDetailStack([]);
        if (navSection === 'home') {
          window.dispatchEvent(new CustomEvent('ipflix:focus-home-search'));
        } else {
          setCategoryJump(null);
          setNavSection('home');
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('ipflix:focus-home-search'));
          }, 90);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSplash, initializing, onboardingCompleted, profileGateOpen, playerMedia, navSection]);

  // Android TV & Desktop Keyboard Back / Spatial D-pad navigation
  const handleGlobalBack = useCallback(() => {
    // 0. Mandatory update lock cannot be bypassed with Back
    if (updateModalOpen) {
      const mandatory = Boolean(
        updateCheckResult?.latest?.mandatoryUpdate || updateCheckResult?.playUpdateImmediateRequired
      );
      if (!mandatory) {
        setUpdateModalOpen(false);
      }
      return;
    }
    // 1. Trailer always closes first and returns user directly to the Detail Page
    if (activeTrailer) {
      setActiveTrailer(null);
      return;
    }
    if (dropdownPinTarget) {
      setDropdownPinTarget(null);
      return;
    }
    // 2. Step back through detail navigation stack before returning to Browse
    if (detailStack.length > 0) {
      setDetailStack((prev) => prev.slice(0, -1));
      return;
    }
    if (playlistModalOpen) {
      setPlaylistModalOpen(false);
      setEditingPlaylist(null);
      return;
    }
    if (profileGateOpen && profileGateDismissible) {
      setProfileGateOpen(false);
      return;
    }
    if (profileDropdownOpen) {
      setProfileDropdownOpen(false);
      return;
    }
    if (providerDropdownOpen) {
      setProviderDropdownOpen(false);
      return;
    }
    if (notificationsOpen) {
      setNotificationsOpen(false);
      return;
    }
    if (navSection !== 'home') {
      setCategoryJump(null);
      setNavSection('home');
    }
  }, [
    updateModalOpen,
    updateCheckResult,
    activeTrailer,
    dropdownPinTarget,
    detailStack.length,
    playlistModalOpen,
    profileGateOpen,
    profileGateDismissible,
    profileDropdownOpen,
    providerDropdownOpen,
    notificationsOpen,
    navSection,
  ]);

  useHybridNavigation({
    tvRemoteMode: settings.tvRemoteMode,
    disabled: Boolean(playerMedia) || showSplash,
    onBack: handleGlobalBack,
  });

  const persistCurrentProfileData = useCallback(
    (profileId: string, patch: Partial<ProfileData>) => {
      if (!profileId) return;
      const current = loadProfileData(profileId);
      saveProfileData(profileId, { ...current, ...patch });
    },
    []
  );

  const applyProfileState = useCallback((profileId: string) => {
    const data = loadProfileData(profileId);
    setFavoritesList(data.favorites);
    setWatchlistList(data.watchlist || []);
    setWatchProgress(data.watchProgress);
    setRecentChannelIds(data.recentChannels);
    setHiddenChannelList(data.hiddenChannels);
    setLastLiveChannelId(data.lastLiveChannelId);
    setLastLiveCategory(data.lastLiveCategory);
    setRecentSearches(data.recentSearches || []);
  }, []);

  const showToast = useCallback((text: string, level: 'info' | 'success' | 'error' = 'info') => {
    setToastMessage({ text, level });
    window.setTimeout(() => {
      setToastMessage((prev) => (prev?.text === text ? null : prev));
    }, 4200);
  }, []);

  const pushNotification = useCallback(
    (title: string, message: string, level: AppNotification['level'] = 'info') => {
      const next: AppNotification = {
        id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title,
        message,
        level,
        timestamp: Date.now(),
        read: false,
      };
      setNotifications((prev) => {
        const updated = [next, ...prev].slice(0, 30);
        saveNotifications(updated);
        return updated;
      });
    },
    []
  );

  // Bootstrap durable local storage (Electron userData + DPAPI / Browser IndexedDB + AES-256-GCM)
  // strictly BEFORE defaults are initialized, and guard abrupt closures with synchronous flushing.
  useEffect(() => {
    let mounted = true;

    const handleAbruptUnload = () => {
      flushPendingSavesSync();
      void flushPendingSaves();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingSavesSync();
        void flushPendingSaves();
      }
    };
    window.addEventListener('beforeunload', handleAbruptUnload);
    window.addEventListener('pagehide', handleAbruptUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const unsubStorage = subscribeStorageEvents(({ diagnostics: nextDiag }) => {
      if (mounted) setStorageDiagnostics(nextDiag);
    });

    async function init() {
      // 1. Hydrate durable local storage FIRST (Electron userData / Browser IndexedDB)
      await hydratePersistentStorage();
      const initDiag = getStorageDiagnostics();
      if (mounted) {
        setStorageDiagnostics(initDiag);
      }

      const storedSettings = loadSettings();
      onSyncLanguage(storedSettings.language);

      const caps = await checkServerCapabilities();
      if (mounted) {
        setFfmpegAvailable(caps.ffmpegAvailable);
      }

      let storedProfiles = loadProfiles();
      if (!initDiag.vaultLocked) {
        const ensured = ensureGuestProfile(storedProfiles, storedSettings.language);
        if (ensured.added) {
          storedProfiles = ensured.profiles;
          saveProfiles(storedProfiles);
        }
      }

      let storedActiveProfileId = loadActiveProfileId();
      if (!storedActiveProfileId || !storedProfiles.some((p) => p.id === storedActiveProfileId)) {
        storedActiveProfileId = storedProfiles[0].id;
        saveActiveProfileId(storedActiveProfileId);
      }

      const initialProfile =
        storedProfiles.find((p) => p.id === storedActiveProfileId) || storedProfiles[0];
      const initialProfileData = loadProfileData(initialProfile.id);

      const storedNotifs = loadNotifications();
      const doneOnboarding = loadOnboardingCompleted();
      let storedPlaylists = loadPlaylists();
      let activeId = loadActivePlaylistId();

      // Always keep the legal Open Cinema Showcase available as demo fallback (never clobbers real accounts)
      if (!storedPlaylists.some((p) => p.id === DEMO_PLAYLIST_ID)) {
        const demo = createOpenSourceDemoBundle();
        storedPlaylists = [...storedPlaylists, demo.source];
        await saveCatalog(demo.catalog);
        savePlaylists(storedPlaylists);
      }

      if (!activeId || !storedPlaylists.some((p) => p.id === activeId)) {
        const preferred =
          storedPlaylists.find((p) => p.isDefault && p.type !== 'demo') ||
          storedPlaylists.find((p) => p.type !== 'demo') ||
          storedPlaylists.find((p) => p.isDefault) ||
          storedPlaylists[0];
        activeId = preferred?.id || null;
        saveActivePlaylistId(activeId);
      }

      let activeCatalog: PlaylistCatalog | null = null;
      if (activeId) {
        activeCatalog = await loadCatalog(activeId);
        if (!activeCatalog && activeId === DEMO_PLAYLIST_ID) {
          const demo = createOpenSourceDemoBundle();
          activeCatalog = demo.catalog;
          await saveCatalog(demo.catalog);
        }
      }

      if (!mounted) return;
      setSettings(storedSettings);
      setProfiles(storedProfiles);
      setActiveProfileId(initialProfile.id);
      setFavoritesList(initialProfileData.favorites);
      setWatchlistList(initialProfileData.watchlist || []);
      setWatchProgress(initialProfileData.watchProgress);
      setRecentChannelIds(initialProfileData.recentChannels);
      setHiddenChannelList(initialProfileData.hiddenChannels);
      setLastLiveChannelId(initialProfileData.lastLiveChannelId);
      setLastLiveCategory(initialProfileData.lastLiveCategory);
      setRecentSearches(initialProfileData.recentSearches || []);
      setNotifications(storedNotifs);
      setPlaylists(storedPlaylists);
      setActivePlaylistId(activeId);
      setCatalog(activeCatalog);
      setOnboardingCompleted(doneOnboarding);
      setStorageDiagnostics(getStorageDiagnostics());

      // Launch Flow: Splash Screen -> "Kim İzliyor?" Profile Selection Screen on every cold launch -> Home
      if (doneOnboarding) {
        setProfileGateManageMode(false);
        setProfileGateDismissible(false);
        setProfileGateOpen(true);
      }

      setInitializing(false);
    }

    init();
    return () => {
      mounted = false;
      unsubStorage();
      window.removeEventListener('beforeunload', handleAbruptUnload);
      window.removeEventListener('pagehide', handleAbruptUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [onSyncLanguage]);

  // Keep local settings state mirrored when user changes language from I18n toggle (no extra disk write)
  useEffect(() => {
    setSettings((prev) => (prev.language === lang ? prev : { ...prev, language: lang }));
  }, [lang]);

  const handleUpdateSettings = useCallback(
    (nextOrPatch: AppSettings | Partial<AppSettings>) => {
      setSettings((prev) => {
        const next: AppSettings = { ...prev, ...nextOrPatch };
        saveSettings(next);
        if (next.language !== lang) {
          onSyncLanguage(next.language);
        }
        return next;
      });
    },
    [lang, onSyncLanguage]
  );

  const runUpdateCheck = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      const force = Boolean(options?.force);
      const silent = Boolean(options?.silent);
      setCheckingUpdates(true);
      try {
        const res = await checkForPlatformUpdates({ force });
        setUpdateCheckResult(res);

        if (res.updateAvailable) {
          const isMandatory = Boolean(
            res.latest?.mandatoryUpdate || res.playUpdateImmediateRequired
          );
          const skipped =
            !isMandatory &&
            !force &&
            settings.skippedUpdateVersion &&
            res.latest?.version &&
            settings.skippedUpdateVersion === res.latest.version;

          if (!skipped) {
            setUpdateModalOpen(true);
          }
        } else if (!silent) {
          if (res.status === 'error') {
            showToast(res.error || t('update.checkNowBtn'), 'error');
          } else if (res.status === 'up_to_date') {
            showToast(t('update.upToDate', { version: `v${res.currentVersion}` }), 'success');
          } else if (res.status === 'play_store_managed') {
            showToast(t('update.playManaged'), 'info');
          }
        }
      } catch (err) {
        if (!silent) {
          showToast(
            err instanceof Error ? err.message : t('onboarding.errConnection'),
            'error'
          );
        }
      } finally {
        setCheckingUpdates(false);
      }
    },
    [settings.skippedUpdateVersion, showToast, t]
  );

  // Background silent auto-update check after startup onboarding & profile selection complete
  useEffect(() => {
    if (
      initializing ||
      showSplash ||
      !onboardingCompleted ||
      profileGateOpen ||
      settings.autoCheckUpdates === false ||
      startupUpdateCheckedRef.current
    ) {
      return;
    }
    startupUpdateCheckedRef.current = true;
    const timer = window.setTimeout(() => {
      void runUpdateCheck({ force: false, silent: true });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [
    initializing,
    showSplash,
    onboardingCompleted,
    profileGateOpen,
    settings.autoCheckUpdates,
    runUpdateCheck,
  ]);

  // Profile actions
  const handleSelectProfile = useCallback(
    (profile: UserProfile) => {
      setActiveProfileId(profile.id);
      saveActiveProfileId(profile.id);
      applyProfileState(profile.id);
      setProfileGateOpen(false);
      setProfileDropdownOpen(false);
      setActiveTrailer(null);
      setDetailStack([]);
      setNavSection('home');
      showToast(t('toast.profileSwitched', { name: profile.name }), 'info');
    },
    [applyProfileState, showToast, t]
  );

  const handleSaveProfile = useCallback(
    (profile: UserProfile) => {
      const stamped: UserProfile = {
        ...profile,
        hasPin: Boolean(profile.pin && profile.pin.length === 4),
        updatedAt: Date.now(),
      };
      setProfiles((prev) => {
        const exists = prev.some((p) => p.id === stamped.id);
        const next = exists
          ? prev.map((p) => (p.id === stamped.id ? stamped : p))
          : [...prev, stamped];
        saveProfiles(next);
        showToast(
          exists
            ? t('toast.profileUpdated', { name: stamped.name })
            : t('toast.profileCreated', { name: stamped.name }),
          'success'
        );
        return next;
      });
    },
    [showToast, t]
  );

  const handleRetryVault = useCallback(async () => {
    await retryVaultRecovery();
    const diag = getStorageDiagnostics();
    setStorageDiagnostics(diag);
    const refreshedProfiles = loadProfiles();
    setProfiles(refreshedProfiles);
    const nextProfId =
      refreshedProfiles.find((p) => p.id === activeProfileId)?.id || refreshedProfiles[0]?.id || '';
    if (nextProfId) {
      setActiveProfileId(nextProfId);
      applyProfileState(nextProfId);
    }
    setPlaylists(loadPlaylists());
    setSettings(loadSettings());
    setNotifications(loadNotifications());
    if (!diag.vaultLocked) {
      showToast(t('common.saved'), 'success');
    } else if (diag.vaultError) {
      showToast(diag.vaultError, 'error');
    }
  }, [activeProfileId, applyProfileState, showToast, t]);

  const handleResetLockedVault = useCallback(async () => {
    await resetLockedVaultSafely();
    const diag = getStorageDiagnostics();
    setStorageDiagnostics(diag);
    const storedSettings = loadSettings();
    const ensured = ensureGuestProfile(loadProfiles(), storedSettings.language);
    if (ensured.added) {
      saveProfiles(ensured.profiles);
    }
    setProfiles(ensured.profiles);
    const nextProfId =
      ensured.profiles.find((p) => p.id === activeProfileId)?.id || ensured.profiles[0]?.id || '';
    if (nextProfId) {
      setActiveProfileId(nextProfId);
      applyProfileState(nextProfId);
    }
    setPlaylists(loadPlaylists());
    setSettings(storedSettings);
    setNotifications(loadNotifications());
    showToast(t('common.saved'), 'success');
  }, [activeProfileId, applyProfileState, showToast, t]);

  const handleDeleteProfile = useCallback(
    (profileId: string) => {
      setProfiles((prev) => {
        const target = prev.find((p) => p.id === profileId);
        if (!target || target.isGuest || prev.filter((p) => !p.isGuest).length <= 1) {
          return prev;
        }
        const remaining = prev.filter((p) => p.id !== profileId);
        saveProfiles(remaining);
        deleteProfileData(profileId);

        if (activeProfileId === profileId && remaining[0]) {
          setActiveProfileId(remaining[0].id);
          saveActiveProfileId(remaining[0].id);
          applyProfileState(remaining[0].id);
        }
        showToast(t('toast.profileDeleted', { name: target.name }), 'info');
        return remaining;
      });
    },
    [activeProfileId, applyProfileState, showToast, t]
  );

  const openProfileGate = useCallback((manage = false) => {
    setProfileDropdownOpen(false);
    setProfileGateManageMode(manage);
    setProfileGateDismissible(true);
    setProfileGateOpen(true);
  }, []);

  // Playlist / Catalog actions
  const handleSelectPlaylist = useCallback(
    async (id: string) => {
      setActivePlaylistId(id);
      saveActivePlaylistId(id);
      let loaded = await loadCatalog(id);
      if (!loaded && id === DEMO_PLAYLIST_ID) {
        const demo = createOpenSourceDemoBundle();
        loaded = demo.catalog;
        await saveCatalog(demo.catalog);
      }
      setCatalog(loaded);
      const pl = playlists.find((p) => p.id === id);
      if (pl) {
        showToast(`${pl.name}`, 'info');
      }
    },
    [playlists, showToast]
  );

  const handlePlaylistSaved = useCallback(
    async (source: PlaylistSource, newCatalog: PlaylistCatalog) => {
      const now = Date.now();
      const stampedSource: PlaylistSource = {
        ...source,
        updatedAt: now,
      };
      await saveCatalog(newCatalog);
      setPlaylists((prev) => {
        const existing = prev.find((p) => p.id === stampedSource.id);
        const mergedSource: PlaylistSource = existing
          ? { ...stampedSource, createdAt: existing.createdAt || stampedSource.createdAt }
          : stampedSource;
        const filtered = prev.filter((p) => p.id !== mergedSource.id);
        const updatedList = mergedSource.isDefault
          ? [
              mergedSource,
              ...filtered.map((p) =>
                p.isDefault ? { ...p, isDefault: false, updatedAt: now } : p
              ),
            ]
          : [mergedSource, ...filtered];
        savePlaylists(updatedList);
        return updatedList;
      });
      setActivePlaylistId(source.id);
      saveActivePlaylistId(source.id);
      setCatalog(newCatalog);
      setEditingPlaylist(null);
      saveOnboardingCompleted(true);
      setOnboardingCompleted(true);

      const toastMsg = t('toast.sourceConnected', {
        name: source.name,
        channels: source.channelCount.toLocaleString(),
        movies: source.movieCount.toLocaleString(),
        series: source.seriesCount.toLocaleString(),
      });
      pushNotification(source.name, toastMsg, 'success');
      showToast(toastMsg, 'success');
    },
    [pushNotification, showToast, t]
  );

  const handleRefreshPlaylist = useCallback(
    async (sourceOrId?: PlaylistSource | string) => {
      const targetId =
        typeof sourceOrId === 'string'
          ? sourceOrId
          : sourceOrId?.id || activePlaylist?.id;
      const target = playlists.find((p) => p.id === targetId);
      if (!target) return;

      setRefreshingPlaylistId(target.id);
      try {
        if (target.type === 'xtream') {
          const freshCatalog = await syncXtreamCatalog(target);
          const updatedSource: PlaylistSource = {
            ...target,
            updatedAt: Date.now(),
            channelCount: freshCatalog.channels.length,
            movieCount: freshCatalog.movies.length,
            seriesCount: freshCatalog.series.length,
          };
          await saveCatalog(freshCatalog);
          setPlaylists((prev) => {
            const next = prev.map((p) => (p.id === target.id ? updatedSource : p));
            savePlaylists(next);
            return next;
          });
          if (target.id === activePlaylistId) setCatalog(freshCatalog);
          const msg = t('toast.sourceRefreshed', { name: target.name });
          pushNotification(target.name, msg, 'success');
          showToast(msg, 'success');
        } else if (target.type === 'm3u_url' && target.m3uUrl) {
          const parsed = await fetchAndParseM3U({
            url: target.m3uUrl,
            playlistId: target.id,
            userAgent: target.userAgent || settings.defaultUserAgent,
          });
          if (!parsed.ok) {
            showToast(parsed.error || t('onboarding.errConnection'), 'error');
            return;
          }
          let epgPrograms = catalog?.epgPrograms || {};
          const epgUrl = target.epgUrl || parsed.detectedEpgUrl;
          if (epgUrl) {
            const epgRes = await fetchXmltvEpg(epgUrl, target.userAgent).catch(() => ({
              ok: false,
              programs: undefined,
            }));
            if (epgRes.ok && epgRes.programs) epgPrograms = epgRes.programs;
          }

          const freshCatalog: PlaylistCatalog = {
            playlistId: target.id,
            channels: parsed.channels as LiveChannel[],
            movies: parsed.movies as MovieItem[],
            series: parsed.series as SeriesItem[],
            epgPrograms,
            epgUpdatedAt: Date.now(),
          };
          const updatedSource: PlaylistSource = {
            ...target,
            updatedAt: Date.now(),
            epgUrl,
            channelCount: freshCatalog.channels.length,
            movieCount: freshCatalog.movies.length,
            seriesCount: freshCatalog.series.length,
          };
          await saveCatalog(freshCatalog);
          setPlaylists((prev) => {
            const next = prev.map((p) => (p.id === target.id ? updatedSource : p));
            savePlaylists(next);
            return next;
          });
          if (target.id === activePlaylistId) setCatalog(freshCatalog);
          showToast(t('toast.sourceRefreshed', { name: target.name }), 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('onboarding.errConnection'), 'error');
      } finally {
        setRefreshingPlaylistId(null);
      }
    },
    [
      activePlaylist,
      activePlaylistId,
      catalog?.epgPrograms,
      playlists,
      pushNotification,
      settings.defaultUserAgent,
      showToast,
      t,
    ]
  );

  const handleDeletePlaylist = useCallback(
    async (id: string) => {
      await deleteCatalog(id);
      const remaining = playlists.filter((p) => p.id !== id);
      savePlaylists(remaining);
      setPlaylists(remaining);

      if (activePlaylistId === id) {
        const nextActive = remaining[0]?.id || null;
        setActivePlaylistId(nextActive);
        saveActivePlaylistId(nextActive);
        if (nextActive) {
          const loaded = await loadCatalog(nextActive);
          setCatalog(loaded);
        } else {
          setCatalog(null);
        }
      }
      showToast(t('toast.sourceDeleted'), 'info');
    },
    [activePlaylistId, playlists, showToast, t]
  );

  const handleSetDefaultPlaylist = useCallback(
    (id: string) => {
      const now = Date.now();
      setPlaylists((prev) => {
        const next = prev.map((p) => {
          const nextDefault = p.id === id;
          return p.isDefault === nextDefault
            ? p
            : { ...p, isDefault: nextDefault, updatedAt: now };
        });
        savePlaylists(next);
        return next;
      });
      showToast(t('common.saved'), 'success');
    },
    [showToast, t]
  );

  // Per-profile isolated favorites, watchlist, recents, hidden channels, watch progress
  const handleToggleFavorite = useCallback(
    (id: string) => {
      setFavoritesList((prev) => {
        const exists = prev.includes(id);
        const next = exists ? prev.filter((x) => x !== id) : [id, ...prev];
        persistCurrentProfileData(activeProfile.id, { favorites: next });
        showToast(exists ? t('toast.removedFavorite') : t('toast.addedFavorite'), 'info');
        return next;
      });
    },
    [activeProfile.id, persistCurrentProfileData, showToast, t]
  );

  const handleToggleWatchlist = useCallback(
    (id: string) => {
      setWatchlistList((prev) => {
        const exists = prev.includes(id);
        const next = exists ? prev.filter((x) => x !== id) : [id, ...prev];
        persistCurrentProfileData(activeProfile.id, { watchlist: next });
        showToast(exists ? t('toast.removedWatchlist') : t('toast.addedWatchlist'), 'info');
        return next;
      });
    },
    [activeProfile.id, persistCurrentProfileData, showToast, t]
  );

  const handleChannelTuned = useCallback(
    (ch: LiveChannel) => {
      setLastLiveChannelId(ch.id);
      setRecentChannelIds((prev) => {
        const next = [ch.id, ...prev.filter((id) => id !== ch.id)].slice(0, 30);
        persistCurrentProfileData(activeProfile.id, {
          recentChannels: next,
          lastLiveChannelId: ch.id,
        });
        return next;
      });
    },
    [activeProfile.id, persistCurrentProfileData]
  );

  const handleLiveCategoryChange = useCallback(
    (category: string) => {
      setLastLiveCategory(category);
      persistCurrentProfileData(activeProfile.id, { lastLiveCategory: category });
    },
    [activeProfile.id, persistCurrentProfileData]
  );

  const handleUpdateRecentSearches = useCallback(
    (next: string[]) => {
      setRecentSearches(next);
      persistCurrentProfileData(activeProfile.id, { recentSearches: next });
    },
    [activeProfile.id, persistCurrentProfileData]
  );

  const handleRecordRecentSearch = useCallback(
    (query: string) => {
      setRecentSearches((prev) => {
        const next = addRecentSearchTerm(prev, query);
        persistCurrentProfileData(activeProfile.id, { recentSearches: next });
        return next;
      });
    },
    [activeProfile.id, persistCurrentProfileData]
  );

  const handleHideChannel = useCallback(
    (channelId: string) => {
      const ch = catalog?.channels.find((c) => c.id === channelId);
      setHiddenChannelList((prev) => {
        if (prev.includes(channelId)) return prev;
        const next = [...prev, channelId];
        persistCurrentProfileData(activeProfile.id, { hiddenChannels: next });
        return next;
      });
      showToast(t('toast.channelHidden', { name: cleanMediaTitle(ch?.name) }), 'info');
    },
    [activeProfile.id, catalog?.channels, persistCurrentProfileData, showToast, t]
  );

  const handleUpdateEpg = useCallback(
    async (programs: Record<string, EpgProgram[]>, epgUrl?: string) => {
      if (!catalog) return;
      const updatedCatalog: PlaylistCatalog = {
        ...catalog,
        epgPrograms: programs,
        epgUpdatedAt: Date.now(),
      };
      setCatalog(updatedCatalog);
      await saveCatalog(updatedCatalog);

      if (epgUrl && activePlaylist) {
        const now = Date.now();
        setPlaylists((prev) => {
          const next = prev.map((p) =>
            p.id === activePlaylist.id ? { ...p, epgUrl, updatedAt: now } : p
          );
          savePlaylists(next);
          return next;
        });
      }
      const chCount = Object.keys(programs).length;
      const msg = t('toast.epgSynced', { count: chCount.toLocaleString() });
      pushNotification('EPG', msg, 'success');
      showToast(msg, 'success');
    },
    [activePlaylist, catalog, pushNotification, showToast, t]
  );

  const handleSyncCustomEpg = useCallback(
    async (epgUrl: string) => {
      try {
        const res = await fetchXmltvEpg(epgUrl, activePlaylist?.userAgent || settings.defaultUserAgent);
        if (res.ok && res.programs) {
          await handleUpdateEpg(res.programs, epgUrl);
        } else {
          showToast(res.error || t('onboarding.errConnection'), 'error');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('onboarding.errConnection'), 'error');
      }
    },
    [activePlaylist?.userAgent, handleUpdateEpg, settings.defaultUserAgent, showToast, t]
  );

  // Hydrate movie / series Xtream metadata back into IndexedDB catalog
  const handleMovieHydrated = useCallback((updated: MovieItem) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const next: PlaylistCatalog = {
        ...prev,
        movies: prev.movies.map((m) => (m.id === updated.id ? updated : m)),
      };
      saveCatalog(next).catch(() => {});
      return next;
    });
  }, []);

  const handleSeriesHydrated = useCallback((updated: SeriesItem) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const next: PlaylistCatalog = {
        ...prev,
        series: prev.series.map((s) => (s.id === updated.id ? updated : s)),
      };
      saveCatalog(next).catch(() => {});
      return next;
    });
  }, []);

  // Playback launchers
  const openChannelPlayer = useCallback(
    (ch: LiveChannel, list?: LiveChannel[]) => {
      handleChannelTuned(ch);
      setPlayerChannelQueue(list || effectiveCatalog?.channels || []);
      setPlayerMedia({
        id: ch.id,
        type: 'live',
        title: cleanMediaTitle(ch.name),
        subtitle: `${ch.num} · ${ch.category}`,
        streamUrl: ch.streamUrl,
        altStreamUrl: ch.altStreamUrl,
        httpsStreamUrl: ch.httpsStreamUrl,
        directSourceUrl: ch.directSourceUrl,
        poster: ch.logo,
        userAgent: ch.customUserAgent || activePlaylist?.userAgent || settings.defaultUserAgent,
        referer: ch.customReferer,
        channel: ch,
      });
    },
    [activePlaylist?.userAgent, effectiveCatalog?.channels, handleChannelTuned, settings.defaultUserAgent]
  );

  const openMoviePlayer = useCallback(
    (movie: MovieItem, resumePosition?: number) => {
      const saved = watchProgress[movie.id];
      const startAt =
        resumePosition !== undefined
          ? resumePosition
          : saved && !isWatchProgressCompleted(saved) && saved.position >= 2
          ? saved.position
          : 0;

      // Close trailer if open; keep Detail Page underneath so closing VideoPlayer returns cleanly to it
      setActiveTrailer(null);
      setPlayerChannelQueue([]);
      setPlayerMedia({
        id: movie.id,
        type: movie.isLocal ? 'local' : 'movie',
        title: cleanMediaTitle(movie.name),
        subtitle: [movie.year, movie.category].filter(Boolean).join(' · '),
        streamUrl: movie.streamUrl,
        httpsStreamUrl: movie.httpsStreamUrl,
        poster: movie.poster,
        backdrop: movie.backdrop,
        containerExtension: movie.containerExtension,
        userAgent: movie.customUserAgent || activePlaylist?.userAgent || settings.defaultUserAgent,
        referer: movie.customReferer,
        movie,
        isLocalBlob: movie.isLocal,
        resumePosition: startAt,
      });
    },
    [activePlaylist?.userAgent, settings.defaultUserAgent, watchProgress]
  );

  const openEpisodePlayer = useCallback(
    (series: SeriesItem, episode: EpisodeItem, resumePosition?: number) => {
      const saved = watchProgress[episode.id];
      const startAt =
        resumePosition !== undefined
          ? resumePosition
          : saved && !isWatchProgressCompleted(saved) && saved.position >= 2
          ? saved.position
          : 0;

      // Close trailer if open; keep Series Detail Page underneath so closing VideoPlayer returns with updated progress
      setActiveTrailer(null);
      setPlayerChannelQueue([]);
      setPlayerMedia({
        id: episode.id,
        type: 'episode',
        title: `${cleanMediaTitle(series.name)} — S${episode.seasonNumber} E${episode.episodeNumber}`,
        subtitle: cleanMediaTitle(episode.title),
        streamUrl: episode.streamUrl,
        httpsStreamUrl: episode.httpsStreamUrl,
        poster: episode.thumbnail || series.poster,
        backdrop: series.backdrop,
        containerExtension: episode.containerExtension,
        userAgent: episode.customUserAgent || activePlaylist?.userAgent || settings.defaultUserAgent,
        referer: episode.customReferer,
        series,
        episode,
        introStart: episode.introStart,
        introEnd: episode.introEnd,
        resumePosition: startAt,
      });
    },
    [activePlaylist?.userAgent, settings.defaultUserAgent, watchProgress]
  );

  const handlePlaySeriesDirect = useCallback(
    (series: SeriesItem) => {
      const allEps = series.seasons.flatMap((s) => s.episodes);
      if (allEps.length === 0) {
        openSeriesDetail(series);
        return;
      }
      let target = allEps[0];
      let latest = 0;
      for (const ep of allEps) {
        const p = watchProgress[ep.id];
        if (p && p.updatedAt > latest) {
          latest = p.updatedAt;
          target = ep;
        }
      }
      const latestProgress = watchProgress[target.id];
      if (isWatchProgressCompleted(latestProgress)) {
        const idx = allEps.findIndex((e) => e.id === target.id);
        if (idx >= 0 && allEps[idx + 1]) {
          openEpisodePlayer(series, allEps[idx + 1], 0);
          return;
        }
        openEpisodePlayer(series, target, 0);
        return;
      }
      openEpisodePlayer(series, target);
    },
    [openEpisodePlayer, openSeriesDetail, watchProgress]
  );

  const handleResumeProgress = useCallback(
    (entry: WatchProgress) => {
      if (!effectiveCatalog) return;
      const done = isWatchProgressCompleted(entry);
      if (entry.type === 'movie') {
        const m = effectiveCatalog.movies.find((x) => x.id === entry.itemId);
        if (m) openMoviePlayer(m, done ? 0 : entry.position);
      } else if (entry.type === 'episode' && entry.seriesId) {
        const s = effectiveCatalog.series.find((x) => x.id === entry.seriesId);
        const allEps = s?.seasons.flatMap((sec) => sec.episodes) || [];
        const ep =
          allEps.find((e) => e.id === entry.itemId) ||
          allEps.find(
            (e) =>
              entry.seasonNumber !== undefined &&
              entry.episodeNumber !== undefined &&
              e.seasonNumber === entry.seasonNumber &&
              e.episodeNumber === entry.episodeNumber
          );
        if (s && ep) {
          if (done) {
            const idx = allEps.findIndex((e) => e.id === ep.id);
            const nextEp = idx >= 0 ? allEps[idx + 1] : undefined;
            openEpisodePlayer(s, nextEp || ep, 0);
          } else {
            openEpisodePlayer(s, ep, entry.position);
          }
        } else if (s) {
          openSeriesDetail(s);
        }
      }
    },
    [effectiveCatalog, openEpisodePlayer, openMoviePlayer, openSeriesDetail]
  );

  const handleProgressUpdate = useCallback(
    (position: number, duration: number, completed?: boolean) => {
      if (!playerMedia || playerMedia.type === 'live') return;
      const isDone =
        typeof completed === 'boolean'
          ? completed
          : duration > 0 && position / duration >= 0.92;
      const now = Date.now();
      const entry: WatchProgress = {
        itemId: playerMedia.id,
        type: playerMedia.type === 'episode' ? 'episode' : 'movie',
        // Preserve original source titles in storage; cleaning is applied at the display layer
        title: playerMedia.series
          ? playerMedia.series.name
          : playerMedia.movie
          ? playerMedia.movie.name
          : playerMedia.title,
        subtitle: playerMedia.episode
          ? `S${playerMedia.episode.seasonNumber} E${playerMedia.episode.episodeNumber} · ${playerMedia.episode.title}`
          : playerMedia.movie
          ? [playerMedia.movie.year, playerMedia.movie.category].filter(Boolean).join(' · ')
          : playerMedia.subtitle,
        poster: playerMedia.poster,
        backdrop: playerMedia.backdrop,
        position,
        duration,
        completed: isDone,
        completedAt: isDone ? now : undefined,
        updatedAt: now,
        seriesId: playerMedia.series?.id,
        seasonNumber: playerMedia.episode?.seasonNumber,
        episodeNumber: playerMedia.episode?.episodeNumber,
        episodeId: playerMedia.episode?.id,
      };
      setWatchProgress((prev) => {
        const next = { ...prev, [entry.itemId]: entry };
        persistCurrentProfileData(activeProfile.id, { watchProgress: next });
        return next;
      });
    },
    [activeProfile.id, persistCurrentProfileData, playerMedia]
  );

  // Fullscreen Player Prev/Next Navigation
  const playerNav = useMemo(() => {
    if (!playerMedia) return {};

    if (playerMedia.type === 'live' && playerMedia.channel && playerChannelQueue.length > 1) {
      const idx = playerChannelQueue.findIndex((c) => c.id === playerMedia.channel!.id);
      if (idx >= 0) {
        const prevCh = playerChannelQueue[idx <= 0 ? playerChannelQueue.length - 1 : idx - 1];
        const nextCh = playerChannelQueue[idx >= playerChannelQueue.length - 1 ? 0 : idx + 1];
        return {
          onPrev: () => openChannelPlayer(prevCh, playerChannelQueue),
          onNext: () => openChannelPlayer(nextCh, playerChannelQueue),
          prevLabel: cleanMediaTitle(prevCh.name),
          nextLabel: cleanMediaTitle(nextCh.name),
        };
      }
    }

    if (playerMedia.type === 'episode' && playerMedia.series && playerMedia.episode) {
      const allEps = playerMedia.series.seasons.flatMap((s) => s.episodes);
      const idx = allEps.findIndex((e) => e.id === playerMedia.episode!.id);
      const prevEp = idx > 0 ? allEps[idx - 1] : undefined;
      const nextEp = idx >= 0 && idx < allEps.length - 1 ? allEps[idx + 1] : undefined;
      return {
        onPrev: prevEp ? () => openEpisodePlayer(playerMedia.series!, prevEp, 0) : undefined,
        onNext: nextEp ? () => openEpisodePlayer(playerMedia.series!, nextEp, 0) : undefined,
        prevLabel: prevEp ? `S${prevEp.seasonNumber} E${prevEp.episodeNumber}: ${cleanMediaTitle(prevEp.title)}` : undefined,
        nextLabel: nextEp ? `S${nextEp.seasonNumber} E${nextEp.episodeNumber}: ${cleanMediaTitle(nextEp.title)}` : undefined,
      };
    }

    return {};
  }, [playerMedia, playerChannelQueue, openChannelPlayer, openEpisodePlayer]);

  const openSettingsSection = useCallback((section: SettingsSection) => {
    setProfileDropdownOpen(false);
    setProviderDropdownOpen(false);
    setNotificationsOpen(false);
    setSettingsInitialSection(section);
    setNavSection('settings');
  }, []);

  const unreadNotifCount = notifications.filter((n) => !n.read).length;

  const markNotificationsRead = () => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveNotifications(next);
      return next;
    });
  };

  const clearNotifications = () => {
    setNotifications([]);
    saveNotifications([]);
  };

  // 1. CINEMATIC IPFLIX SPLASH SCREEN (plays once on cold start; never replays endlessly on return)
  if (showSplash || initializing) {
    return (
      <AnimatePresence mode="wait">
        <SplashScreen
          key="ipflix-splash"
          ready={!initializing}
          introSoundEnabled={settings.introSoundEnabled}
          onComplete={() => {
            try {
              window.sessionStorage.setItem('ipflix_intro_played_v1', '1');
            } catch {
              // ignore storage errors
            }
            setShowSplash(false);
          }}
        />
      </AnimatePresence>
    );
  }

  // 2. FIRST-LAUNCH IPTV CREDENTIALS ONBOARDING GATE (Strictly M3U & Xtream Codes)
  if (!onboardingCompleted) {
    const savedRealSource =
      playlists.find((p) => p.id === activePlaylistId && p.type !== 'demo') ||
      playlists.find((p) => p.type !== 'demo');
    return (
      <OnboardingView
        savedSourceName={savedRealSource?.name}
        existingPlaylists={playlists}
        onContinueExisting={
          savedRealSource
            ? async () => {
                saveOnboardingCompleted(true);
                setOnboardingCompleted(true);
                await handleSelectPlaylist(savedRealSource.id);
                setProfileGateManageMode(false);
                setProfileGateDismissible(false);
                setProfileGateOpen(true);
              }
            : undefined
        }
        onCompleteWithSource={async (source, newCatalog) => {
          await handlePlaylistSaved(source, newCatalog);
          setProfileGateManageMode(false);
          setProfileGateDismissible(false);
          setProfileGateOpen(true);
        }}
        onContinueWithDemo={async () => {
          saveOnboardingCompleted(true);
          setOnboardingCompleted(true);
          await handleSelectPlaylist(DEMO_PLAYLIST_ID);
          setProfileGateManageMode(false);
          setProfileGateDismissible(false);
          setProfileGateOpen(true);
        }}
      />
    );
  }

  // 3. NETFLIX-STYLE "KIM İZLİYOR?" PROFILE SELECTION GATE (Shown on every cold launch)
  if (profileGateOpen) {
    return (
      <ProfileGate
        profiles={profiles}
        activeProfileId={activeProfile.id}
        initialManageMode={profileGateManageMode}
        canDismiss={profileGateDismissible}
        vaultLocked={storageDiagnostics.vaultLocked}
        vaultError={storageDiagnostics.vaultError}
        onRetryVault={handleRetryVault}
        onResetLockedVault={handleResetLockedVault}
        onDismiss={() => setProfileGateOpen(false)}
        onSelectProfile={handleSelectProfile}
        onSaveProfile={handleSaveProfile}
        onDeleteProfile={handleDeleteProfile}
      />
    );
  }

  // 4. MAIN IPFLIX CINEMATIC APPLICATION SHELL (FULL-WIDTH DESKTOP — NO SIDEBAR)
  return (
    <div
      className={`min-h-screen bg-[#08090D] text-[#F5F7FA] flex flex-col ${
        settings.tvRemoteMode ? 'tv-focus-mode' : ''
      }`}
    >
      {/* PRIMARY HORIZONTAL TOP NAVIGATION BAR (Consistent across all pages, never overlaps content) */}
      <header className="sticky top-0 z-30 min-h-[56px] md:min-h-[68px] safe-area-top px-4 sm:px-8 lg:px-12 xl:px-14 bg-[#08090D]/92 backdrop-blur-xl border-b border-white/[0.07] flex items-center justify-between gap-3">
        {/* Left: IPFLIX Logo + Primary Horizontal Navigation */}
        <div className="flex items-center gap-5 lg:gap-8 min-w-0">
          <button
            type="button"
            data-focusable="true"
            onClick={() => {
              setCategoryJump(null);
              setNavSection('home');
            }}
            className="min-h-[44px] inline-flex items-center shrink-0 focus-visible:outline-none"
            aria-label={t('nav.home')}
          >
            <span className="md:hidden">
              <BrandMark size="sm" />
            </span>
            <span className="hidden md:inline-flex">
              <BrandMark size="md" />
            </span>
          </button>

          <nav
            className="hidden md:flex items-center gap-5 lg:gap-7 text-sm font-medium"
            aria-label={t('nav.primaryNav')}
          >
            {(
              [
                { id: 'home', label: t('nav.home') },
                { id: 'live', label: t('nav.live') },
                { id: 'movies', label: t('nav.movies') },
                { id: 'series', label: t('nav.series') },
                { id: 'favorites', label: t('nav.watchlist') },
              ] as const
            ).map((link) => {
              const isActive = navSection === link.id;
              return (
                <button
                  key={link.id}
                  type="button"
                  data-focusable="true"
                  onClick={() => {
                    setCategoryJump(null);
                    setNavSection(link.id);
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  className={`relative py-2 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    isActive
                      ? 'text-white font-semibold border-[#E50914]'
                      : 'text-[#9CA3B2] hover:text-white border-transparent'
                  }`}
                >
                  {link.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right Action Cluster: IPTV Provider Account Selector + Search Icon + Notifications + Profile Menu */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          {/* IPTV Provider Account Selector (Desktop / Tablet) */}
          <div className="relative hidden md:block" ref={providerMenuRef}>
            <button
              type="button"
              data-focusable="true"
              onClick={() => {
                setProviderDropdownOpen((o) => !o);
                setProfileDropdownOpen(false);
                setNotificationsOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={providerDropdownOpen}
              aria-label={t('nav.activeProvider')}
              className="h-9 px-3 rounded-lg bg-[#12141B] hover:bg-[#171A24] border border-white/[0.09] hover:border-white/20 text-xs font-medium text-white inline-flex items-center gap-2 max-w-[180px] lg:max-w-[220px] transition-colors"
            >
              <Server className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
              <span className="truncate">
                {activePlaylist?.name || t('nav.addSource')}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-[#9CA3B2] shrink-0 transition-transform ${
                  providerDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {providerDropdownOpen && (
              <div className="absolute right-0 mt-2 w-72 bg-[#12141B] border border-white/12 rounded-xl shadow-2xl shadow-black/75 overflow-hidden z-40">
                <div className="px-3.5 py-2.5 border-b border-white/[0.08] flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3B2]">
                    {t('nav.switchProvider')}
                  </span>
                  <span className="text-[11px] text-[#666E80] tabular-nums">
                    {playlists.length}
                  </span>
                </div>

                <div className="p-1.5 max-h-60 overflow-y-auto space-y-0.5">
                  {playlists.map((pl) => {
                    const isActivePl = pl.id === activePlaylist?.id;
                    return (
                      <button
                        key={pl.id}
                        type="button"
                        onClick={() => {
                          setProviderDropdownOpen(false);
                          if (!isActivePl) {
                            handleSelectPlaylist(pl.id);
                          }
                        }}
                        className={`w-full px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 text-left transition-colors ${
                          isActivePl
                            ? 'bg-white/[0.08] text-white'
                            : 'text-[#B8BFCC] hover:bg-white/[0.05] hover:text-white'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold truncate">{pl.name}</p>
                          <p className="text-[11px] text-[#666E80] tabular-nums truncate">
                            {pl.channelCount} {t('common.channels')} · {pl.movieCount}{' '}
                            {t('common.movies')}
                          </p>
                        </div>
                        {isActivePl && <Check className="w-3.5 h-3.5 text-[#E50914] shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="p-1.5 border-t border-white/[0.08] space-y-0.5">
                  <button
                    type="button"
                    onClick={() => openSettingsSection('sources')}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center gap-2 text-left transition-colors"
                  >
                    <Server className="w-3.5 h-3.5 text-[#7F8799]" />
                    <span>{t('nav.manageSources')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProviderDropdownOpen(false);
                      setEditingPlaylist(null);
                      setPlaylistModalOpen(true);
                    }}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-semibold text-white hover:bg-white/[0.05] flex items-center gap-2 text-left transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5 text-[#E50914]" />
                    <span>{t('nav.addSource')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Search Icon Button */}
          <button
            type="button"
            data-focusable="true"
            onClick={() => {
              setProviderDropdownOpen(false);
              setProfileDropdownOpen(false);
              setNotificationsOpen(false);
              if (navSection === 'home') {
                window.dispatchEvent(new CustomEvent('ipflix:focus-home-search'));
              } else {
                setSearchInitialQuery('');
                setNavSection('search');
              }
            }}
            aria-label={t('nav.search')}
            title={`${t('nav.search')} (Ctrl+K)`}
            className={`w-11 h-11 md:w-9 md:h-9 rounded-lg flex items-center justify-center transition-colors ${
              navSection === 'search'
                ? 'bg-[#E50914] text-white'
                : 'text-[#9CA3B2] hover:text-white hover:bg-white/[0.06]'
            }`}
          >
            <Search className="w-[18px] h-[18px] md:w-4 md:h-4" />
          </button>

          {/* Subtle Notifications Popover */}
          <div className="relative hidden sm:block" ref={notifMenuRef}>
            <button
              type="button"
              data-focusable="true"
              onClick={() => {
                setNotificationsOpen((o) => !o);
                setProfileDropdownOpen(false);
                setProviderDropdownOpen(false);
                if (!notificationsOpen) markNotificationsRead();
              }}
              aria-label={t('nav.notifications')}
              className="w-9 h-9 rounded-lg text-[#9CA3B2] hover:text-white hover:bg-white/[0.06] flex items-center justify-center transition-colors relative"
            >
              <Bell className="w-4 h-4" />
              {unreadNotifCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#E50914]" />
              )}
            </button>

            {notificationsOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-[#12141B] border border-white/12 rounded-xl shadow-2xl shadow-black/75 overflow-hidden z-40">
                <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white">{t('nav.notifications')}</span>
                  <div className="flex items-center gap-2.5">
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={clearNotifications}
                        className="text-[11px] font-medium text-[#9CA3B2] hover:text-white transition-colors"
                      >
                        {t('search.clearRecent')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setNotificationsOpen(false)}
                      aria-label={t('common.close')}
                      className="text-[#9CA3B2] hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto divide-y divide-white/[0.06]">
                  {notifications.length > 0 ? (
                    notifications.map((n) => (
                      <div key={n.id} className="px-4 py-3 space-y-0.5">
                        <p className="text-xs font-semibold text-white">{n.title}</p>
                        <p className="text-xs text-[#9CA3B2]">{n.message}</p>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-xs text-[#666E80]">
                      {t('nav.noNotifications')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Profile Avatar & Complete Relocated Menu (BÖLÜM 3) */}
          <div className="relative" ref={profileMenuRef}>
            <button
              type="button"
              data-focusable="true"
              onClick={() => {
                setProfileDropdownOpen((o) => !o);
                setProviderDropdownOpen(false);
                setNotificationsOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={profileDropdownOpen}
              aria-label={activeProfile.name}
              className="flex items-center gap-1.5 sm:gap-2 pl-1 pr-1.5 sm:pr-2 py-1 min-h-[44px] md:min-h-[40px] rounded-lg hover:bg-white/[0.07] transition-colors shrink-0"
            >
              <ProfileAvatar avatarId={activeProfile.avatarId} name={activeProfile.name} size="sm" />
              <span className="hidden xl:inline text-xs font-semibold text-white max-w-[100px] truncate">
                {activeProfile.name}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-[#9CA3B2] transition-transform ${
                  profileDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {profileDropdownOpen && (
              <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.5rem)] bg-[#12141B] border border-white/12 rounded-xl shadow-2xl shadow-black/75 overflow-hidden z-40">
                {/* Quick Profile Switcher */}
                <div className="p-2 border-b border-white/[0.08] space-y-0.5">
                  {profiles.map((prof) => {
                    const isCurrent = prof.id === activeProfile.id;
                    const isLocked = Boolean((prof.pin && prof.pin.length === 4) || prof.hasPin);
                    const hasUnreadablePin = Boolean(
                      prof.hasPin && (!prof.pin || prof.pin.length !== 4)
                    );
                    return (
                      <button
                        key={prof.id}
                        type="button"
                        onClick={() => {
                          setProfileDropdownOpen(false);
                          if (isCurrent) return;
                          if (hasUnreadablePin) {
                            showToast(t('storage.vaultPinUnavailable'), 'error');
                            openProfileGate(false);
                            return;
                          }
                          if (isLocked) {
                            setDropdownPinTarget(prof);
                          } else {
                            handleSelectProfile(prof);
                          }
                        }}
                        className={`w-full px-2.5 py-2 rounded-lg flex items-center justify-between gap-2.5 text-left transition-colors ${
                          isCurrent
                            ? 'bg-white/[0.08] text-white'
                            : 'text-[#B8BFCC] hover:bg-white/[0.05] hover:text-white'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <ProfileAvatar avatarId={prof.avatarId} name={prof.name} size="xs" />
                          <span className="text-xs font-semibold truncate">{prof.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {prof.isGuest && (
                            <span className="text-[10px] font-semibold text-teal-400">
                              {t('common.guest')}
                            </span>
                          )}
                          {prof.isKids && (
                            <span className="text-[10px] font-semibold text-amber-400">
                              {t('common.kids')}
                            </span>
                          )}
                          {isLocked && <Lock className="w-3 h-3 text-[#7F8799]" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Relocated Sidebar & Account Menu Items */}
                <div className="p-2 border-b border-white/[0.08] space-y-0.5">
                  <button
                    type="button"
                    onClick={() => openProfileGate(true)}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center gap-2.5 text-left transition-colors"
                  >
                    <Users className="w-4 h-4 text-[#7F8799] shrink-0" />
                    <span>{t('nav.manageProfiles')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setProfileDropdownOpen(false);
                      setCategoryJump(null);
                      setNavSection('categories');
                    }}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center gap-2.5 text-left transition-colors"
                  >
                    <FolderKanban className="w-4 h-4 text-[#7F8799] shrink-0" />
                    <span>{t('nav.categories')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openSettingsSection('overview')}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center gap-2.5 text-left transition-colors"
                  >
                    <Settings className="w-4 h-4 text-[#7F8799] shrink-0" />
                    <span>{t('nav.settings')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openSettingsSection('sources')}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center justify-between gap-2 text-left transition-colors"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Server className="w-4 h-4 text-[#E50914] shrink-0" />
                      <span className="truncate">{t('nav.manageSources')}</span>
                    </span>
                    {activePlaylist && (
                      <span className="text-[10px] text-[#666E80] truncate max-w-[78px] shrink-0">
                        {activePlaylist.name}
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => openSettingsSection('about')}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#B8BFCC] hover:text-white hover:bg-white/[0.05] flex items-center gap-2.5 text-left transition-colors"
                  >
                    <HelpCircle className="w-4 h-4 text-[#7F8799] shrink-0" />
                    <span>{t('nav.helpAndAbout')}</span>
                  </button>
                </div>

                {/* Inline Language Toggle */}
                <div className="px-3.5 py-2.5 border-b border-white/[0.08] flex items-center justify-between gap-2">
                  <span className="text-xs text-[#9CA3B2] inline-flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" />
                    {t('nav.language')}
                  </span>
                  <div className="inline-flex items-center p-0.5 rounded-md bg-[#08090D] border border-white/10">
                    <button
                      type="button"
                      onClick={() => setLang('tr')}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                        lang === 'tr' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
                      }`}
                    >
                      TR
                    </button>
                    <button
                      type="button"
                      onClick={() => setLang('en')}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                        lang === 'en' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
                      }`}
                    >
                      EN
                    </button>
                  </div>
                </div>

                {/* Sign Out to IPTV Account Setup */}
                <div className="p-2">
                  <button
                    type="button"
                    onClick={() => {
                      setProfileDropdownOpen(false);
                      saveOnboardingCompleted(false);
                      setOnboardingCompleted(false);
                    }}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium text-[#9CA3B2] hover:text-red-300 hover:bg-[#E50914]/10 flex items-center gap-2.5 text-left transition-colors"
                  >
                    <LogOut className="w-4 h-4 shrink-0" />
                    <span>{t('nav.signOut')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ACTIVE FULL-WIDTH VIEWPORT WITH SMOOTH PAGE TRANSITIONS & MOBILE BOTTOM NAV CLEARANCE */}
      <main className="flex-1 min-w-0 pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] md:pb-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${navSection}_${activeProfile.id}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            {navSection === 'home' && (
              <HomeView
                activePlaylist={activePlaylist}
                catalog={effectiveCatalog}
                profileId={activeProfile.id}
                isKidsProfile={activeProfile.isKids}
                favorites={favoritesSet}
                watchProgress={watchProgress}
                recentChannelIds={recentChannelIds}
                recentSearches={recentSearches}
                onUpdateRecentSearches={handleUpdateRecentSearches}
                onPlayChannel={(ch) => openChannelPlayer(ch)}
                onPlayMovie={(m) => openMoviePlayer(m)}
                onOpenMovieDetail={openMovieDetail}
                onOpenSeriesDetail={openSeriesDetail}
                onPlaySeriesDirect={handlePlaySeriesDirect}
                onPlayEpisode={(s, ep) => openEpisodePlayer(s, ep)}
                onSelectCategory={(sec, cat) => {
                  setCategoryJump({ section: sec, category: cat });
                  setNavSection(sec);
                }}
                onOpenFullSearch={(q) => {
                  setSearchInitialQuery(q);
                  setNavSection('search');
                }}
                onResumeProgress={handleResumeProgress}
                onToggleFavorite={handleToggleFavorite}
                onOpenAddPlaylist={() => {
                  setEditingPlaylist(null);
                  setPlaylistModalOpen(true);
                }}
                onNavigate={(sec) => setNavSection(sec)}
              />
            )}

              {navSection === 'live' && (
                <Suspense fallback={<ViewLoadingFallback />}>
                  <LiveTVView
                    activePlaylist={activePlaylist}
                    catalog={effectiveCatalog}
                    settings={settings}
                    ffmpegAvailable={ffmpegAvailable}
                    favorites={favoritesSet}
                    recentChannelIds={recentChannelIds}
                    hiddenChannelIds={hiddenChannelSet}
                    lastChannelId={lastLiveChannelId}
                    lastCategory={lastLiveCategory}
                    initialCategory={categoryJump?.section === 'live' ? categoryJump.category : undefined}
                    suspended={Boolean(playerMedia) || detailStack.length > 0}
                    onCategoryChange={handleLiveCategoryChange}
                    onUpdatePlayerPrefs={handleUpdateSettings}
                    onToggleFavorite={handleToggleFavorite}
                    onOpenFullPlayer={(media, list) => {
                      setPlayerChannelQueue(list);
                      setPlayerMedia(media);
                    }}
                    onChannelTuned={handleChannelTuned}
                    onHideChannel={handleHideChannel}
                    onRefreshPlaylist={() => handleRefreshPlaylist()}
                    onUpdateEpg={handleUpdateEpg}
                    onOpenAddPlaylist={() => {
                      setEditingPlaylist(null);
                      setPlaylistModalOpen(true);
                    }}
                  />
                </Suspense>
              )}

              {navSection === 'movies' && (
                <MoviesView
                  movies={effectiveCatalog?.movies || []}
                  favorites={favoritesSet}
                  watchProgress={watchProgress}
                  initialCategory={categoryJump?.section === 'movies' ? categoryJump.category : undefined}
                  onPlayMovie={(m) => openMoviePlayer(m)}
                  onOpenMovieDetail={openMovieDetail}
                  onToggleFavorite={handleToggleFavorite}
                  onOpenAddPlaylist={() => {
                    setEditingPlaylist(null);
                    setPlaylistModalOpen(true);
                  }}
                />
              )}

              {navSection === 'series' && (
                <SeriesView
                  series={effectiveCatalog?.series || []}
                  favorites={favoritesSet}
                  initialCategory={categoryJump?.section === 'series' ? categoryJump.category : undefined}
                  onPlaySeriesDirect={handlePlaySeriesDirect}
                  onOpenSeriesDetail={openSeriesDetail}
                  onToggleFavorite={handleToggleFavorite}
                  onOpenAddPlaylist={() => {
                    setEditingPlaylist(null);
                    setPlaylistModalOpen(true);
                  }}
                />
              )}

              {navSection === 'categories' && (
                <CategoriesView
                  catalog={effectiveCatalog}
                  onSelectCategory={(sec, cat) => {
                    setCategoryJump({ section: sec, category: cat });
                    setNavSection(sec);
                  }}
                />
              )}

              {navSection === 'favorites' && (
                <FavoritesView
                  catalog={effectiveCatalog}
                  profileName={activeProfile.name}
                  favorites={favoritesSet}
                  watchlist={watchlistSet}
                  onPlayChannel={(ch) => openChannelPlayer(ch)}
                  onPlayMovie={(m) => openMoviePlayer(m)}
                  onOpenMovieDetail={openMovieDetail}
                  onPlaySeriesDirect={handlePlaySeriesDirect}
                  onOpenSeriesDetail={openSeriesDetail}
                  onToggleFavorite={handleToggleFavorite}
                />
              )}

              {navSection === 'search' && (
                <SearchView
                  catalog={effectiveCatalog}
                  favorites={favoritesSet}
                  initialQuery={searchInitialQuery}
                  recentSearches={recentSearches}
                  onRecordRecentSearch={handleRecordRecentSearch}
                  onPlayChannel={(ch) => openChannelPlayer(ch)}
                  onPlayMovie={(m) => openMoviePlayer(m)}
                  onOpenMovieDetail={openMovieDetail}
                  onPlaySeriesDirect={handlePlaySeriesDirect}
                  onOpenSeriesDetail={openSeriesDetail}
                  onPlayEpisode={(s, ep) => openEpisodePlayer(s, ep)}
                  onSelectCategory={(sec, cat) => {
                    setCategoryJump({ section: sec, category: cat });
                    setNavSection(sec);
                  }}
                  onToggleFavorite={handleToggleFavorite}
                />
              )}

              {navSection === 'settings' && (
                <Suspense fallback={<ViewLoadingFallback />}>
                  <SettingsView
                    initialSection={settingsInitialSection}
                    playlists={playlists}
                    activePlaylistId={activePlaylistId}
                    settings={settings}
                    profiles={profiles}
                    activeProfile={activeProfile}
                    hiddenChannelCount={hiddenChannelList.length}
                    refreshingPlaylistId={refreshingPlaylistId}
                    storageDiagnostics={storageDiagnostics}
                    onUpdateSettings={handleUpdateSettings}
                    onSelectPlaylist={handleSelectPlaylist}
                    onSetDefaultPlaylist={handleSetDefaultPlaylist}
                    onRefreshPlaylist={(src) => handleRefreshPlaylist(src)}
                    onEditPlaylist={(pl) => {
                      setEditingPlaylist(pl);
                      setPlaylistModalOpen(true);
                    }}
                    onDeletePlaylist={handleDeletePlaylist}
                    onAddPlaylist={() => {
                      setEditingPlaylist(null);
                      setPlaylistModalOpen(true);
                    }}
                    onSyncCustomEpg={handleSyncCustomEpg}
                    onSaveProfile={handleSaveProfile}
                    onDeleteProfile={handleDeleteProfile}
                    onOpenProfileGate={openProfileGate}
                    onRestoreHiddenChannels={() => {
                      setHiddenChannelList([]);
                      persistCurrentProfileData(activeProfile.id, { hiddenChannels: [] });
                      showToast(t('toast.hiddenRestored'), 'success');
                    }}
                    onClearHistory={() => {
                      setWatchProgress({});
                      setRecentChannelIds([]);
                      setRecentSearches([]);
                      setLastLiveChannelId(undefined);
                      persistCurrentProfileData(activeProfile.id, {
                        watchProgress: {},
                        recentChannels: [],
                        recentSearches: [],
                        lastLiveChannelId: undefined,
                        clearedHistoryAt: Date.now(),
                      });
                      showToast(t('toast.historyCleared'), 'info');
                    }}
                    onReturnToOnboarding={() => {
                      saveOnboardingCompleted(false);
                      setOnboardingCompleted(false);
                    }}
                    onResetAllData={async () => {
                      await clearAllUserData();
                      const demo = createOpenSourceDemoBundle();
                      await saveCatalog(demo.catalog);
                      savePlaylists([demo.source]);
                      saveActivePlaylistId(demo.source.id);
                      const freshProfile = createDefaultProfile('Ana Profil');
                      const guestProfile = createGuestProfile(DEFAULT_SETTINGS.language);
                      saveProfiles([freshProfile, guestProfile]);
                      saveActiveProfileId(freshProfile.id);

                      setPlaylists([demo.source]);
                      setActivePlaylistId(demo.source.id);
                      setCatalog(demo.catalog);
                      setProfiles([freshProfile, guestProfile]);
                      setActiveProfileId(freshProfile.id);
                      setFavoritesList([]);
                      setWatchlistList([]);
                      setWatchProgress({});
                      setRecentChannelIds([]);
                      setHiddenChannelList([]);
                      setLastLiveChannelId(undefined);
                      setLastLiveCategory(undefined);
                      setRecentSearches([]);
                      setActiveTrailer(null);
                      setDetailStack([]);
                      setSettings(DEFAULT_SETTINGS);
                      onSyncLanguage(DEFAULT_SETTINGS.language);
                      setOnboardingCompleted(false);
                      showToast(t('toast.dataReset'), 'info');
                    }}
                    onRetryVault={handleRetryVault}
                    onResetLockedVault={handleResetLockedVault}
                    updateCheckResult={updateCheckResult}
                    checkingUpdates={checkingUpdates}
                    onCheckForUpdates={(force) => runUpdateCheck({ force: Boolean(force), silent: false })}
                    onOpenUpdateModal={() => setUpdateModalOpen(true)}
                    onBackToBrowse={() => setNavSection('home')}
                  />
                </Suspense>
              )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ANDROID PHONE / MOBILE BOTTOM NAVIGATION BAR (44px+ touch targets, <= 15% combined sticky height) */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 min-h-[56px] safe-area-bottom bg-[#0A0B10]/95 backdrop-blur-xl border-t border-white/[0.08] grid grid-cols-5"
        aria-label={t('nav.mobileNav')}
      >
        {(
          [
            { id: 'home', label: t('nav.home'), icon: Home },
            { id: 'live', label: t('nav.live'), icon: Tv },
            { id: 'movies', label: t('nav.movies'), icon: Film },
            { id: 'series', label: t('nav.series'), icon: Clapperboard },
            { id: 'favorites', label: t('nav.favorites'), icon: Heart },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = navSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setCategoryJump(null);
                setNavSection(tab.id);
              }}
              className={`relative min-h-[54px] py-1.5 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors active:scale-95 ${
                active ? 'text-[#E50914] font-semibold' : 'text-[#9CA3B2]'
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-[#E50914]"
                />
              )}
              <Icon className="w-[19px] h-[19px] shrink-0" />
              <span className="truncate max-w-full px-1 leading-tight">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* PIN PROMPT MODAL FOR QUICK PROFILE SWITCH */}
      <PinPromptModal
        profile={dropdownPinTarget}
        onClose={() => setDropdownPinTarget(null)}
        onUnlocked={(unlockedProfile) => {
          setDropdownPinTarget(null);
          handleSelectProfile(unlockedProfile);
        }}
      />

      {/* PLAYLIST & ACCOUNT CONNECTION MODAL */}
      {playlistModalOpen && (
        <Suspense fallback={<OverlayLoadingFallback />}>
          <PlaylistModal
            isOpen={playlistModalOpen}
            editingPlaylist={editingPlaylist}
            existingPlaylists={playlists}
            onClose={() => {
              setPlaylistModalOpen(false);
              setEditingPlaylist(null);
            }}
            onPlaylistSaved={handlePlaylistSaved}
          />
        </Suspense>
      )}

      {/* FULL-SCREEN CINEMATIC MOVIE & SERIES DETAIL PAGES */}
      <Suspense fallback={<OverlayLoadingFallback />}>
        <AnimatePresence mode="wait">
          {activeDetail?.kind === 'movie' && (
            <MovieDetailPage
              key={`movie_${activeDetail.item.id}`}
              movie={activeDetail.item}
              source={activePlaylist}
              allMovies={effectiveCatalog?.movies || []}
              allSeries={effectiveCatalog?.series || []}
              favorites={favoritesSet}
              isFavorite={favoritesSet.has(activeDetail.item.id)}
              isInWatchlist={watchlistSet.has(activeDetail.item.id)}
              progress={watchProgress[activeDetail.item.id]}
              tvRemoteMode={settings.tvRemoteMode}
              onBack={popDetailPage}
              onPlay={(m, pos) => openMoviePlayer(m, pos)}
              onOpenTrailer={(url, title) => setActiveTrailer({ url, title })}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatchlist={handleToggleWatchlist}
              onSelectMovie={openMovieDetail}
              onSelectSeries={openSeriesDetail}
              onPlaySeriesDirect={handlePlaySeriesDirect}
              onMovieHydrated={handleMovieHydrated}
            />
          )}

          {activeDetail?.kind === 'series' && (
            <SeriesDetailPage
              key={`series_${activeDetail.item.id}`}
              series={activeDetail.item}
              source={activePlaylist}
              allSeries={effectiveCatalog?.series || []}
              allMovies={effectiveCatalog?.movies || []}
              favorites={favoritesSet}
              isFavorite={favoritesSet.has(activeDetail.item.id)}
              isInWatchlist={watchlistSet.has(activeDetail.item.id)}
              watchProgress={watchProgress}
              tvRemoteMode={settings.tvRemoteMode}
              onBack={popDetailPage}
              onPlayEpisode={(s, ep, pos) => openEpisodePlayer(s, ep, pos)}
              onPlayMovie={(m, pos) => openMoviePlayer(m, pos)}
              onOpenTrailer={(url, title) => setActiveTrailer({ url, title })}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatchlist={handleToggleWatchlist}
              onSelectSeries={openSeriesDetail}
              onSelectMovie={openMovieDetail}
              onSeriesHydrated={handleSeriesHydrated}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* ISOLATED CINEMATIC TRAILER OVERLAY (Closes directly back to Detail Page) */}
      <Suspense fallback={<OverlayLoadingFallback />}>
        <AnimatePresence>
          {activeTrailer && (
            <TrailerModal
              key="ipflix_trailer_modal"
              trailerUrl={activeTrailer.url}
              title={activeTrailer.title}
              onClose={() => setActiveTrailer(null)}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* FULLSCREEN CINEMA VIDEO PLAYER */}
      {playerMedia && (
        <Suspense fallback={<OverlayLoadingFallback />}>
          <VideoPlayer
            key={playerMedia.id}
            media={playerMedia}
            settings={settings}
            ffmpegAvailable={ffmpegAvailable}
            onClose={() => {
              setPlayerMedia(null);
              flushPendingSavesSync();
            }}
            onProgressUpdate={handleProgressUpdate}
            onUpdatePlayerPrefs={handleUpdateSettings}
            onPrevItem={playerNav.onPrev}
            onNextItem={playerNav.onNext}
            prevLabel={playerNav.prevLabel}
            nextLabel={playerNav.nextLabel}
            onMarkUnavailable={
              playerMedia.channel
                ? () => {
                    handleHideChannel(playerMedia.channel!.id);
                    if (playerNav.onNext) playerNav.onNext();
                    else {
                      setPlayerMedia(null);
                      flushPendingSavesSync();
                    }
                  }
                : undefined
            }
          />
        </Suspense>
      )}

      {/* MULTI-PLATFORM AUTO-UPDATE DIALOG */}
      <UpdateModal
        isOpen={updateModalOpen}
        result={updateCheckResult}
        onRemindLater={(ver) => {
          if (ver) {
            handleUpdateSettings({ skippedUpdateVersion: ver });
          }
          setUpdateModalOpen(false);
        }}
        onClose={() => setUpdateModalOpen(false)}
      />

      {/* NON-INTRUSIVE STATUS TOAST */}
      {toastMessage && (
        <div className="fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom,0px))] md:bottom-6 left-4 right-4 sm:left-auto sm:right-6 z-50 sm:max-w-sm px-4 py-3 rounded-xl bg-[#181B24] border border-white/15 shadow-2xl flex items-center gap-3 text-xs font-medium text-white">
          <span className="leading-snug">{toastMessage.text}</span>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<AppLanguage>(() => loadBootLanguageHint());

  const handleChangeLang = useCallback((nextLang: AppLanguage) => {
    setLang(nextLang);
    const current = loadSettings();
    saveSettings({ ...current, language: nextLang });
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <I18nProvider lang={lang} onChangeLang={handleChangeLang}>
        <AppShell onSyncLanguage={setLang} />
      </I18nProvider>
    </MotionConfig>
  );
}
