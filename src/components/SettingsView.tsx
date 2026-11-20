import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  Globe,
  HardDrive,
  HelpCircle,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Shield,
  ShieldCheck,
  Sliders,
  Star,
  Trash2,
  UserCheck,
  Users,
  Volume2,
} from 'lucide-react';
import type {
  AppSettings,
  AspectRatioMode,
  PlaylistSource,
  StreamEnginePreference,
  UpdateCheckResult,
  UserProfile,
} from '../types/iptv';
import { USER_AGENT_PROFILES } from '../types/iptv';
import {
  APP_VERSION,
  APP_VERSION_CODE,
  GITHUB_OWNER,
  GITHUB_REPO,
  detectDistributionChannel,
} from '../config/appVersion';
import { useI18n } from '../i18n/I18nContext';
import { loadProfileData, type StorageDiagnostics } from '../services/storage';
import { playIntroSound, type IntroAudioHandle } from '../utils/introAudio';
import { BrandMark } from './BrandMark';
import { ProfileAvatar } from './ProfileAvatar';
import { MAX_PROFILES, ProfileEditorModal } from './ProfileGate';
import { getChannelDisplayKey } from './UpdateModal';

export type SettingsSection =
  | 'overview'
  | 'sources'
  | 'profiles'
  | 'playback'
  | 'privacy'
  | 'about';

interface SettingsViewProps {
  playlists: PlaylistSource[];
  activePlaylistId: string | null;
  settings: AppSettings;
  profiles: UserProfile[];
  activeProfile: UserProfile;
  hiddenChannelCount: number;
  refreshingPlaylistId: string | null;
  storageDiagnostics: StorageDiagnostics;
  initialSection?: SettingsSection;
  onUpdateSettings: (next: AppSettings) => void;
  onSelectPlaylist: (id: string) => void;
  onSetDefaultPlaylist: (id: string) => void;
  onRefreshPlaylist: (source: PlaylistSource) => void;
  onEditPlaylist: (source: PlaylistSource) => void;
  onDeletePlaylist: (id: string) => void;
  onAddPlaylist: () => void;
  onSyncCustomEpg: (url: string) => Promise<void>;
  onSaveProfile: (profile: UserProfile) => void;
  onDeleteProfile: (profileId: string) => void;
  onOpenProfileGate: (manage?: boolean) => void;
  onRestoreHiddenChannels: () => void;
  onClearHistory: () => void;
  onReturnToOnboarding: () => void;
  onResetAllData: () => void;
  onRetryVault?: () => Promise<void> | void;
  onResetLockedVault?: () => Promise<void> | void;
  updateCheckResult?: UpdateCheckResult | null;
  checkingUpdates?: boolean;
  onCheckForUpdates?: (force?: boolean) => Promise<void> | void;
  onOpenUpdateModal?: () => void;
  onBackToBrowse: () => void;
}

export function SettingsView({
  playlists,
  activePlaylistId,
  settings,
  profiles,
  activeProfile,
  hiddenChannelCount,
  refreshingPlaylistId,
  storageDiagnostics,
  initialSection,
  onUpdateSettings,
  onSelectPlaylist,
  onSetDefaultPlaylist,
  onRefreshPlaylist,
  onEditPlaylist,
  onDeletePlaylist,
  onAddPlaylist,
  onSyncCustomEpg,
  onSaveProfile,
  onDeleteProfile,
  onOpenProfileGate,
  onRestoreHiddenChannels,
  onClearHistory,
  onReturnToOnboarding,
  onResetAllData,
  onRetryVault,
  onResetLockedVault,
  updateCheckResult,
  checkingUpdates,
  onCheckForUpdates,
  onOpenUpdateModal,
  onBackToBrowse,
}: SettingsViewProps) {
  const { lang, setLang, t } = useI18n();

  const [section, setSection] = useState<SettingsSection>(initialSection || 'overview');
  const [epgUrlInput, setEpgUrlInput] = useState(settings.customEpgUrl || '');
  const [syncingEpg, setSyncingEpg] = useState(false);
  const [editingProfile, setEditingProfile] = useState<UserProfile | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [previewingSound, setPreviewingSound] = useState(false);
  const previewAudioRef = useRef<IntroAudioHandle | null>(null);
  const previewTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialSection) {
      setSection(initialSection);
    }
  }, [initialSection]);

  useEffect(() => {
    return () => {
      previewAudioRef.current?.stop();
      if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
    };
  }, []);

  const handlePreviewIntroSound = () => {
    previewAudioRef.current?.stop();
    if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
    setPreviewingSound(true);
    previewAudioRef.current = playIntroSound({ volume: 0.78 });
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewingSound(false);
    }, 2850);
  };

  const activePlaylist =
    playlists.find((p) => p.id === activePlaylistId) || playlists[0] || null;
  const nonGuestCount = profiles.filter((p) => !p.isGuest).length;

  const navItems: { id: SettingsSection; label: string; icon: typeof UserCheck }[] = [
    { id: 'overview', label: t('settings.navOverview'), icon: UserCheck },
    { id: 'sources', label: t('settings.navSources'), icon: Server },
    { id: 'profiles', label: t('settings.navProfiles'), icon: Users },
    { id: 'playback', label: t('settings.navPlayback'), icon: Sliders },
    { id: 'privacy', label: t('settings.navPrivacy'), icon: Shield },
    { id: 'about', label: t('settings.navAbout'), icon: HelpCircle },
  ];

  const storageBackendLabel =
    storageDiagnostics.backend === 'electron_userdata'
      ? storageDiagnostics.sqliteEnabled
        ? t('storage.backendElectronSqlite')
        : storageDiagnostics.encryptionMode === 'dpapi_safestorage'
        ? t('storage.backendElectron')
        : t('storage.backendElectronAes')
      : storageDiagnostics.encryptionMode === 'webcrypto_aes_256_gcm'
      ? t('storage.backendBrowserWebCrypto')
      : t('storage.backendBrowserAes');

  const activeChannel = updateCheckResult?.channel || detectDistributionChannel();

  const formatDateTime = (ts?: number | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const sourceTypeLabel = (type: PlaylistSource['type']) => {
    switch (type) {
      case 'xtream':
        return t('settings.subTypeXtream');
      case 'm3u_url':
        return t('settings.subTypeM3uUrl');
      case 'm3u_file':
        return t('settings.subTypeM3uFile');
      case 'local':
        return t('settings.subTypeLocal');
      default:
        return t('settings.subTypeDemo');
    }
  };

  const formatDate = (epochSecOrMs?: string | number) => {
    if (!epochSecOrMs) return '—';
    const num = Number(epochSecOrMs);
    if (!Number.isFinite(num) || num <= 0) return '—';
    const ms = num < 10_000_000_000 ? num * 1000 : num;
    return new Date(ms).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const handleEpgSync = async () => {
    if (!epgUrlInput.trim()) return;
    setSyncingEpg(true);
    try {
      onUpdateSettings({ ...settings, customEpgUrl: epgUrlInput.trim() });
      await onSyncCustomEpg(epgUrlInput.trim());
    } finally {
      setSyncingEpg(false);
    }
  };

  return (
    <div className="min-h-full px-4 sm:px-8 lg:px-12 py-6 sm:py-8 pb-12 max-w-6xl mx-auto">
      {/* Top Bar Contract: Title + single Back action */}
      <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4 pb-5 sm:pb-6 border-b border-white/[0.08]">
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            {t('settings.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-1 truncate">
            {activeProfile.name}
            {activePlaylist ? ` · ${activePlaylist.name}` : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={onBackToBrowse}
          className="min-h-[44px] px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-sm font-medium text-white inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('settings.backToBrowse')}</span>
        </button>
      </div>

      {/* Netflix Account Split Layout: Left Rail + Right Content */}
      <div className="mt-6 sm:mt-8 flex flex-col lg:flex-row gap-6 sm:gap-8 lg:gap-12">
        {/* Left Navigation Rail (Desktop) / Horizontal Scroll Tabs (Mobile) */}
        <nav
          aria-label={t('settings.title')}
          className="lg:w-60 shrink-0 flex lg:flex-col gap-1.5 overflow-x-auto pb-2 lg:pb-0 -mx-4 px-4 sm:mx-0 sm:px-0 no-scrollbar"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`min-h-[44px] px-3.5 py-2.5 rounded-lg text-sm font-medium inline-flex items-center gap-2.5 sm:gap-3 transition-colors whitespace-nowrap shrink-0 text-left ${
                  isActive
                    ? 'bg-white/[0.09] text-white font-semibold'
                    : 'text-[#9CA3B2] hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-[#E50914]' : 'text-[#6E7688]'
                  }`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right Workspace Canvas */}
        <div className="flex-1 min-w-0">
          {/* ================================================================ */}
          {/* 1. OVERVIEW */}
          {/* ================================================================ */}
          {section === 'overview' && (
            <div className="space-y-8">
              <div>
                <h2 className="font-display text-xl font-bold text-white">
                  {t('settings.overviewTitle')}
                </h2>
                <p className="text-sm text-[#9CA3B2] mt-1">
                  {t('settings.overviewDesc')}
                </p>
              </div>

              {/* Active Subscription Summary (Single elevation surface, hairline dividers) */}
              <section className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
                <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-[#9CA3B2]">
                      {t('settings.subscriptionCard')}
                    </p>
                    <h3 className="text-lg font-bold text-white mt-0.5">
                      {activePlaylist ? activePlaylist.name : t('settings.noActiveSub')}
                    </h3>
                  </div>

                  {activePlaylist && (
                    <span className="text-xs font-semibold text-emerald-400">
                      {activePlaylist.accountInfo?.status || t('common.active')}
                    </span>
                  )}
                </div>

                {activePlaylist ? (
                  <div className="px-6 py-5 grid grid-cols-2 sm:grid-cols-4 gap-5">
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('settings.subSourceType')}</p>
                      <p className="text-sm font-semibold text-white mt-1">
                        {sourceTypeLabel(activePlaylist.type)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('settings.subExpires')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.accountInfo?.expDate
                          ? formatDate(activePlaylist.accountInfo.expDate)
                          : t('common.unlimited')}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('settings.subConnections')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.accountInfo?.maxConnections
                          ? `${activePlaylist.accountInfo.activeCons || '0'} / ${activePlaylist.accountInfo.maxConnections}`
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('common.channels')} · {t('common.movies')} · {t('common.series')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.channelCount.toLocaleString()} · {activePlaylist.movieCount.toLocaleString()} · {activePlaylist.seriesCount.toLocaleString()}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="px-6 py-6 flex items-center justify-between gap-4">
                    <p className="text-sm text-[#9CA3B2]">{t('home.emptyDesc')}</p>
                    <button
                      type="button"
                      onClick={onAddPlaylist}
                      className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-sm font-semibold text-white whitespace-nowrap"
                    >
                      {t('nav.connectIptv')}
                    </button>
                  </div>
                )}
              </section>

              {/* Quick Actions List (Netflix Account Row Style) */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#7F8799] mb-3">
                  {t('settings.quickLinks')}
                </h3>
                <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                  {activePlaylist && activePlaylist.type !== 'demo' && activePlaylist.type !== 'local' && (
                    <button
                      type="button"
                      disabled={refreshingPlaylistId === activePlaylist.id}
                      onClick={() => onRefreshPlaylist(activePlaylist)}
                      className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-white/[0.03] transition-colors text-left disabled:opacity-60"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        {refreshingPlaylistId === activePlaylist.id ? (
                          <Loader2 className="w-5 h-5 text-[#E50914] animate-spin shrink-0" />
                        ) : (
                          <RefreshCw className="w-5 h-5 text-[#9CA3B2] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white">
                            {t('settings.quickRefreshCatalog')}
                          </p>
                          <p className="text-xs text-[#9CA3B2] mt-0.5 truncate">
                            {t('settings.quickRefreshDesc')}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#6E7688] shrink-0" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setSection('profiles')}
                    className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-white/[0.03] transition-colors text-left"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <ProfileAvatar avatarId={activeProfile.avatarId} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">
                          {t('settings.quickManageProfiles')}
                        </p>
                        <p className="text-xs text-[#9CA3B2] mt-0.5 truncate">
                          {t('settings.quickManageProfilesDesc', {
                            count: profiles.length,
                            active: activeProfile.name,
                          })}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6E7688] shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setSection('privacy')}
                    className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-white/[0.03] transition-colors text-left"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <Database className="w-5 h-5 text-emerald-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">
                          {t('storage.localStorageTitle')}
                        </p>
                        <p className="text-xs text-[#9CA3B2] mt-0.5 truncate">
                          {storageBackendLabel}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6E7688] shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={onAddPlaylist}
                    className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-white/[0.03] transition-colors text-left"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <Plus className="w-5 h-5 text-[#9CA3B2] shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">
                          {t('settings.quickAddSource')}
                        </p>
                        <p className="text-xs text-[#9CA3B2] mt-0.5 truncate">
                          {t('settings.quickAddSourceDesc')}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6E7688] shrink-0" />
                  </button>

                  <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <Globe className="w-5 h-5 text-[#9CA3B2] shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {t('settings.quickSwitchLanguage')}
                        </p>
                        <p className="text-xs text-[#9CA3B2] mt-0.5">
                          {t('settings.quickSwitchLanguageDesc')}
                        </p>
                      </div>
                    </div>
                    <div className="inline-flex items-center p-1 rounded-lg bg-[#08090D] border border-white/10">
                      <button
                        type="button"
                        onClick={() => setLang('tr')}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                          lang === 'tr'
                            ? 'bg-[#E50914] text-white'
                            : 'text-[#9CA3B2] hover:text-white'
                        }`}
                      >
                        Türkçe
                      </button>
                      <button
                        type="button"
                        onClick={() => setLang('en')}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                          lang === 'en'
                            ? 'bg-[#E50914] text-white'
                            : 'text-[#9CA3B2] hover:text-white'
                        }`}
                      >
                        English
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* ================================================================ */}
          {/* 2. IPTV SOURCES & EPG */}
          {/* ================================================================ */}
          {section === 'sources' && (
            <div className="space-y-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-xl font-bold text-white">
                    {t('settings.sourcesTitle')}
                  </h2>
                  <p className="text-sm text-[#9CA3B2] mt-1">
                    {t('settings.sourcesDesc')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={onAddPlaylist}
                  className="min-h-[44px] px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-sm font-semibold text-white inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('settings.addNewSource')}</span>
                </button>
              </div>

              {/* Active IPTV Subscription Details Card (relocated from desktop sidebar) */}
              {activePlaylist && (
                <div className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-white/[0.07] flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-[#9CA3B2]">
                      {t('settings.subscriptionCard')}
                    </span>
                    <span className="text-xs font-semibold text-emerald-400">
                      {activePlaylist.accountInfo?.status || t('common.active')}
                    </span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="min-w-0">
                      <p className="text-xs text-[#7F8799]">{t('settings.subSourceType')}</p>
                      <p className="text-sm font-semibold text-white truncate mt-1">
                        {activePlaylist.name}
                      </p>
                      <p className="text-xs text-[#9CA3B2] mt-0.5">
                        {sourceTypeLabel(activePlaylist.type)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('settings.subExpires')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.accountInfo?.expDate
                          ? formatDate(activePlaylist.accountInfo.expDate)
                          : t('common.unlimited')}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('settings.subConnections')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.accountInfo?.maxConnections
                          ? `${activePlaylist.accountInfo.activeCons || '0'} / ${activePlaylist.accountInfo.maxConnections}`
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">
                        {t('common.channels')} · {t('common.movies')} · {t('common.series')}
                      </p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {activePlaylist.channelCount.toLocaleString()} ·{' '}
                        {activePlaylist.movieCount.toLocaleString()} ·{' '}
                        {activePlaylist.seriesCount.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Saved Sources List */}
              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                {playlists.map((pl) => {
                  const isActive = pl.id === activePlaylistId;
                  const isRefreshing = refreshingPlaylistId === pl.id;
                  return (
                    <div
                      key={pl.id}
                      className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <h3 className="text-base font-bold text-white truncate">
                            {pl.name}
                          </h3>
                          <span className="text-xs font-medium text-[#9CA3B2]">
                            {[
                              sourceTypeLabel(pl.type),
                              isActive ? t('common.active') : null,
                              pl.isDefault ? t('common.default') : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </div>
                        <p className="text-xs text-[#7F8799] tabular-nums">
                          {pl.channelCount.toLocaleString()} {t('common.channels')} ·{' '}
                          {pl.movieCount.toLocaleString()} {t('common.movies')} ·{' '}
                          {pl.seriesCount.toLocaleString()} {t('common.series')} ·{' '}
                          {t('settings.lastUpdated', { date: formatDate(pl.updatedAt) })}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {!isActive && (
                          <button
                            type="button"
                            onClick={() => onSelectPlaylist(pl.id)}
                            className="px-3 py-1.5 rounded-lg bg-white text-black hover:bg-white/90 text-xs font-semibold transition-colors"
                          >
                            {t('common.switch')}
                          </button>
                        )}

                        {!pl.isDefault && (
                          <button
                            type="button"
                            onClick={() => onSetDefaultPlaylist(pl.id)}
                            title={t('settings.setDefault')}
                            className="px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-medium text-white inline-flex items-center gap-1.5 transition-colors"
                          >
                            <Star className="w-3.5 h-3.5" />
                            <span>{t('settings.setDefault')}</span>
                          </button>
                        )}

                        {pl.type !== 'demo' && pl.type !== 'local' && pl.type !== 'm3u_file' && (
                          <button
                            type="button"
                            disabled={isRefreshing}
                            onClick={() => onRefreshPlaylist(pl)}
                            className="px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] disabled:opacity-50 text-xs font-medium text-white inline-flex items-center gap-1.5 transition-colors"
                          >
                            {isRefreshing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {isRefreshing ? t('settings.refreshing') : t('settings.refreshSource')}
                            </span>
                          </button>
                        )}

                        {pl.type !== 'demo' && (
                          <>
                            <button
                              type="button"
                              onClick={() => onEditPlaylist(pl)}
                              aria-label={t('common.edit')}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[#9CA3B2] hover:text-white transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeletePlaylist(pl.id)}
                              aria-label={t('common.delete')}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-[#E50914]/20 text-[#9CA3B2] hover:text-[#FF6B73] transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* EPG Section */}
              <section className="rounded-xl bg-[#12141B] border border-white/[0.08] p-6 space-y-5">
                <div>
                  <h3 className="text-base font-bold text-white">
                    {t('settings.epgSectionTitle')}
                  </h3>
                  <p className="text-xs text-[#9CA3B2] mt-1">
                    {t('settings.epgSectionDesc')}
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    value={epgUrlInput}
                    onChange={(e) => setEpgUrlInput(e.target.value)}
                    placeholder={t('settings.epgInputPlaceholder')}
                    className="flex-1 px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono placeholder:text-[#5B6273]"
                  />
                  <button
                    type="button"
                    disabled={syncingEpg || !epgUrlInput.trim()}
                    onClick={handleEpgSync}
                    className="px-4 py-2.5 rounded-lg bg-white/[0.09] hover:bg-white/[0.15] disabled:opacity-45 text-sm font-semibold text-white inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                  >
                    {syncingEpg && <Loader2 className="w-4 h-4 animate-spin" />}
                    <span>{t('settings.epgSyncBtn')}</span>
                  </button>
                </div>

                <div className="pt-4 border-t border-white/[0.07] flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">
                      {t('settings.epgOffsetLabel')}
                    </p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">
                      {t('settings.epgOffsetDesc')}
                    </p>
                  </div>
                  <select
                    value={settings.epgTimeOffsetHours}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        epgTimeOffsetHours: Number(e.target.value),
                      })
                    }
                    className="px-3.5 py-2 rounded-lg bg-[#08090D] border border-white/12 text-sm text-white font-mono tabular-nums focus:border-[#E50914] focus:outline-none"
                  >
                    {Array.from({ length: 25 }, (_, i) => i - 12).map((h) => (
                      <option key={h} value={h}>
                        {h > 0 ? `+${h}h` : `${h}h`}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            </div>
          )}

          {/* ================================================================ */}
          {/* 3. PROFILES & PARENTAL PIN CONTROLS */}
          {/* ================================================================ */}
          {section === 'profiles' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-xl font-bold text-white">
                    {t('settings.profilesTitle')}
                  </h2>
                  <p className="text-sm text-[#9CA3B2] mt-1">
                    {t('settings.profilesDesc')}
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => onOpenProfileGate(false)}
                    className="px-3.5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-semibold text-white transition-colors whitespace-nowrap"
                  >
                    {t('settings.openProfilePicker')}
                  </button>
                  {nonGuestCount < MAX_PROFILES && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingProfile(null);
                        setProfileModalOpen(true);
                      }}
                      className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4" />
                      <span>{t('profiles.addProfile')}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Profiles List */}
              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                {profiles.map((prof) => {
                  const isCurrent = prof.id === activeProfile.id;
                  const isLocked = Boolean((prof.pin && prof.pin.length === 4) || prof.hasPin);
                  const stats = loadProfileData(prof.id);
                  return (
                    <div
                      key={prof.id}
                      className="p-5 flex flex-wrap items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="relative">
                          <ProfileAvatar avatarId={prof.avatarId} name={prof.name} size="md" />
                          {isLocked && (
                            <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#08090D] border border-white/20 flex items-center justify-center text-white">
                              <Lock className="w-2.5 h-2.5" />
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <h3 className="text-base font-bold text-white truncate">
                              {prof.name}
                            </h3>
                            {prof.isGuest && (
                              <span className="text-xs font-semibold text-teal-400">
                                {t('common.guest')}
                              </span>
                            )}
                            {isCurrent && (
                              <span className="text-xs font-semibold text-[#E50914]">
                                {t('profiles.activeBadge')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#9CA3B2] mt-0.5 tabular-nums">
                            {[
                              prof.isGuest
                                ? t('common.guest')
                                : prof.isKids
                                ? t('settings.kidsEnabled')
                                : t('settings.adultStandard'),
                              isLocked ? t('settings.pinProtected') : t('settings.pinUnlocked'),
                              t('profiles.savedCount', {
                                favs: stats.favorites.length,
                                watched: Object.keys(stats.watchProgress).length,
                              }),
                            ].join(' · ')}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setEditingProfile(prof);
                          setProfileModalOpen(true);
                        }}
                        className="px-3.5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>{t('common.edit')}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* 4. PLAYBACK & DISPLAY */}
          {/* ================================================================ */}
          {section === 'playback' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-display text-xl font-bold text-white">
                  {t('settings.playbackTitle')}
                </h2>
                <p className="text-sm text-[#9CA3B2] mt-1">
                  {t('settings.playbackDesc')}
                </p>
              </div>

              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                {/* Language */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-md">
                    <p className="text-sm font-semibold text-white">{t('settings.langLabel')}</p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">{t('settings.langDesc')}</p>
                  </div>
                  <div className="inline-flex items-center p-1 rounded-lg bg-[#08090D] border border-white/10">
                    <button
                      type="button"
                      onClick={() => setLang('tr')}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                        lang === 'tr' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
                      }`}
                    >
                      Türkçe
                    </button>
                    <button
                      type="button"
                      onClick={() => setLang('en')}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                        lang === 'en' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
                      }`}
                    >
                      English
                    </button>
                  </div>
                </div>

                {/* Default Engine */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-md">
                    <p className="text-sm font-semibold text-white">{t('settings.engineLabel')}</p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">{t('settings.engineDesc')}</p>
                  </div>
                  <select
                    value={settings.defaultEngine}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        defaultEngine: e.target.value as StreamEnginePreference,
                      })
                    }
                    className="w-full sm:w-64 px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/12 text-sm text-white focus:border-[#E50914] focus:outline-none"
                  >
                    <option value="auto">{t('settings.engineAuto')}</option>
                    <option value="hls">{t('settings.engineHls')}</option>
                    <option value="mpegts">{t('settings.engineMpegts')}</option>
                    <option value="audiofix">{t('settings.engineAudiofix')}</option>
                    <option value="transcode">{t('settings.engineTranscode')}</option>
                  </select>
                </div>

                {/* Default Aspect Ratio */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-md">
                    <p className="text-sm font-semibold text-white">{t('settings.aspectLabel')}</p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">{t('settings.aspectDesc')}</p>
                  </div>
                  <select
                    value={settings.defaultAspectRatio}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        defaultAspectRatio: e.target.value as AspectRatioMode,
                      })
                    }
                    className="w-full sm:w-52 px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/12 text-sm text-white focus:border-[#E50914] focus:outline-none"
                  >
                    <option value="auto">{t('player.aspectAuto')}</option>
                    <option value="16:9">16:9</option>
                    <option value="4:3">4:3</option>
                    <option value="fit">{t('player.aspectFit')}</option>
                    <option value="fill">{t('player.aspectFill')}</option>
                  </select>
                </div>

                {/* User-Agent */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-md">
                    <p className="text-sm font-semibold text-white">{t('settings.uaLabel')}</p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">{t('settings.uaDesc')}</p>
                  </div>
                  <select
                    value={settings.defaultUserAgent}
                    onChange={(e) =>
                      onUpdateSettings({ ...settings, defaultUserAgent: e.target.value })
                    }
                    className="w-full sm:w-64 px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/12 text-sm text-white focus:border-[#E50914] focus:outline-none"
                  >
                    {USER_AGENT_PROFILES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Subtitle Language */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-md">
                    <p className="text-sm font-semibold text-white">{t('settings.subLangLabel')}</p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">{t('settings.subLangDesc')}</p>
                  </div>
                  <select
                    value={settings.preferredSubtitleLang}
                    onChange={(e) =>
                      onUpdateSettings({ ...settings, preferredSubtitleLang: e.target.value })
                    }
                    className="w-full sm:w-52 px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/12 text-sm text-white focus:border-[#E50914] focus:outline-none"
                  >
                    <option value="tr">Türkçe (TR)</option>
                    <option value="en">English (EN)</option>
                    <option value="de">Deutsch (DE)</option>
                    <option value="fr">Français (FR)</option>
                    <option value="es">Español (ES)</option>
                    <option value="ar">العربية (AR)</option>
                    <option value="off">{t('player.subtitlesOff')}</option>
                  </select>
                </div>

                {/* Launch Intro Sound Toggle + Live Preview */}
                <div className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-lg min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {t('settings.introSoundLabel')}
                    </p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5 leading-relaxed">
                      {t('settings.introSoundDesc')}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={handlePreviewIntroSound}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] border border-white/[0.1] text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Volume2
                        className={`w-3.5 h-3.5 shrink-0 ${
                          previewingSound ? 'text-[#E50914] animate-pulse' : 'text-[#9CA3B2]'
                        }`}
                      />
                      <span>
                        {previewingSound
                          ? t('settings.introSoundPlaying')
                          : t('settings.introSoundPreview')}
                      </span>
                    </button>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.introSoundEnabled}
                      aria-label={t('settings.introSoundLabel')}
                      onClick={() =>
                        onUpdateSettings({
                          ...settings,
                          introSoundEnabled: !settings.introSoundEnabled,
                        })
                      }
                      className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                        settings.introSoundEnabled ? 'bg-[#E50914]' : 'bg-white/15'
                      }`}
                    >
                      <span
                        className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                          settings.introSoundEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Boolean Switches */}
                {[
                  {
                    key: 'autoPlayNextEpisode' as const,
                    label: t('settings.autoNextLabel'),
                    desc: t('settings.autoNextDesc'),
                  },
                  {
                    key: 'lowBandwidthMode' as const,
                    label: t('settings.lowBandwidthLabel'),
                    desc: t('settings.lowBandwidthDesc'),
                  },
                  {
                    key: 'tvRemoteMode' as const,
                    label: t('settings.tvRemoteLabel'),
                    desc: t('settings.tvRemoteDesc'),
                  },
                ].map((toggle) => {
                  const checked = settings[toggle.key];
                  return (
                    <div
                      key={toggle.key}
                      className="p-4 sm:p-5 flex items-center justify-between gap-4"
                    >
                      <div className="max-w-lg min-w-0">
                        <p className="text-sm font-semibold text-white">{toggle.label}</p>
                        <p className="text-xs text-[#9CA3B2] mt-0.5 leading-relaxed">{toggle.desc}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={toggle.label}
                        onClick={() =>
                          onUpdateSettings({ ...settings, [toggle.key]: !checked })
                        }
                        className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                          checked ? 'bg-[#E50914]' : 'bg-white/15'
                        }`}
                      >
                        <span
                          className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                            checked ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* 5. PRIVACY & DATA */}
          {/* ================================================================ */}
          {section === 'privacy' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-display text-xl font-bold text-white">
                  {t('settings.privacyTitle')}
                </h2>
                <p className="text-sm text-[#9CA3B2] mt-1">
                  {t('settings.privacyDesc')}
                </p>
              </div>

              {/* Durable Local Storage Diagnostics Card */}
              <section className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
                <div className="px-6 py-4 border-b border-white/[0.08] flex items-center gap-3">
                  <Database className="w-5 h-5 text-[#9CA3B2] shrink-0" />
                  <h3 className="text-base font-bold text-white">
                    {t('storage.localStorageTitle')}
                  </h3>
                </div>

                <div className="p-6 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('storage.localStorageTitle')}</p>
                      <p className="text-sm font-semibold text-white mt-1">
                        {storageBackendLabel}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">
                        {t('storage.localStorageLastSaveLabel')}
                      </p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {formatDateTime(storageDiagnostics.lastSavedAt)}
                      </p>
                    </div>
                    <div className="sm:col-span-2">
                      <p className="text-xs text-[#7F8799]">{t('storage.localStoragePathLabel')}</p>
                      <p className="text-xs font-mono text-[#B8BFCC] mt-1 break-all bg-[#08090D] border border-white/[0.07] rounded-lg px-3 py-2">
                        {storageDiagnostics.storagePath || 'IndexedDB (ipflix_store_v1)'}
                      </p>
                    </div>
                    <div className="sm:col-span-2 flex items-center gap-2 text-xs text-emerald-400">
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>
                        {t('storage.localStorageEncryptionLabel')}:{' '}
                        {t('storage.localStorageEncryptedActive')}
                      </span>
                    </div>
                  </div>

                  {(storageDiagnostics.vaultLocked || storageDiagnostics.lastError) && (
                    <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 space-y-2.5 text-xs text-red-200 leading-relaxed break-words">
                      <div className="flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          {storageDiagnostics.vaultLocked && (
                            <p className="font-bold text-white">{t('storage.vaultLockedTitle')}</p>
                          )}
                          <p>{storageDiagnostics.vaultError || storageDiagnostics.lastError}</p>
                        </div>
                      </div>
                      {storageDiagnostics.vaultLocked && (onRetryVault || onResetLockedVault) && (
                        <div className="flex flex-wrap items-center gap-2 pl-6">
                          {onRetryVault && (
                            <button
                              type="button"
                              onClick={() => void onRetryVault()}
                              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white inline-flex items-center gap-1.5"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>{t('storage.vaultRetryBtn')}</span>
                            </button>
                          )}
                          {onResetLockedVault && (
                            <button
                              type="button"
                              onClick={() => void onResetLockedVault()}
                              className="px-3 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs font-semibold text-white"
                            >
                              {t('storage.vaultResetSafeBtn')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                {/* Hidden Channels */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-lg">
                    <p className="text-sm font-semibold text-white">
                      {t('settings.hiddenChannelsTitle')}
                    </p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5 tabular-nums">
                      {t('settings.hiddenChannelsDesc', {
                        profile: activeProfile.name,
                        count: hiddenChannelCount,
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={hiddenChannelCount === 0}
                    onClick={onRestoreHiddenChannels}
                    className="px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] disabled:opacity-40 text-xs font-semibold text-white transition-colors whitespace-nowrap"
                  >
                    {t('settings.restoreHidden')}
                  </button>
                </div>

                {/* Clear Watch History */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-lg">
                    <p className="text-sm font-semibold text-white">
                      {t('settings.clearHistoryTitle')}
                    </p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">
                      {t('settings.clearHistoryDesc', { profile: activeProfile.name })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClearHistory}
                    className="px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-semibold text-white transition-colors whitespace-nowrap"
                  >
                    {t('settings.clearHistoryBtn')}
                  </button>
                </div>

                {/* Return to First-Launch IPTV Login Setup */}
                <div className="p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-lg">
                    <p className="text-sm font-semibold text-white">
                      {t('settings.signOutIptvTitle')}
                    </p>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">
                      {t('settings.signOutIptvDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onReturnToOnboarding}
                    className="px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>{t('settings.signOutIptvBtn')}</span>
                  </button>
                </div>

                {/* Reset Everything */}
                <div className="p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="max-w-lg">
                      <p className="text-sm font-semibold text-[#FF6B73]">
                        {t('settings.resetAllTitle')}
                      </p>
                      <p className="text-xs text-[#9CA3B2] mt-0.5">
                        {t('settings.resetAllDesc')}
                      </p>
                    </div>
                    {!confirmResetAll && (
                      <button
                        type="button"
                        onClick={() => setConfirmResetAll(true)}
                        className="px-4 py-2 rounded-lg bg-[#E50914]/15 hover:bg-[#E50914] text-[#FF6B73] hover:text-white border border-[#E50914]/35 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <HardDrive className="w-3.5 h-3.5" />
                        <span>{t('settings.resetAllBtn')}</span>
                      </button>
                    )}
                  </div>

                  {confirmResetAll && (
                    <div className="p-4 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 flex flex-wrap items-center justify-between gap-3">
                      <span className="text-xs text-red-100">
                        {t('settings.resetAllConfirm')}
                      </span>
                      <div className="flex items-center gap-2 ml-auto">
                        <button
                          type="button"
                          onClick={() => setConfirmResetAll(false)}
                          className="px-3.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-white"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmResetAll(false);
                            onResetAllData();
                          }}
                          className="px-3.5 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs font-semibold text-white"
                        >
                          {t('common.confirm')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* 6. HELP & ABOUT */}
          {/* ================================================================ */}
          {section === 'about' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-display text-xl font-bold text-white">
                  {t('settings.aboutTitle')}
                </h2>
                <p className="text-sm text-[#9CA3B2] mt-1">
                  {t('settings.aboutDesc')}
                </p>
              </div>

              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] p-6 space-y-4">
                <BrandMark size="md" />
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-white">
                    {t('settings.aboutPlatformTitle')}
                  </h3>
                  <p className="text-xs font-medium tracking-[0.16em] text-[#9CA3B2]">
                    {t('app.slogan')}
                  </p>
                </div>
                <p className="text-sm text-[#B8BFCC] leading-relaxed max-w-2xl">
                  {t('settings.aboutPlatformDesc')}
                </p>
              </div>

              {/* Multi-Platform Auto-Update & Release Channel Card */}
              <section className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
                <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      {t('update.sectionTitle')}
                    </h3>
                    <p className="text-xs text-[#9CA3B2] mt-0.5">
                      {t('update.sectionDesc')}
                    </p>
                  </div>
                  {onCheckForUpdates && (
                    <button
                      type="button"
                      data-focusable="true"
                      disabled={Boolean(checkingUpdates)}
                      onClick={() => void onCheckForUpdates(true)}
                      className="min-h-[44px] px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-55 text-xs font-semibold text-white inline-flex items-center gap-2 transition-colors whitespace-nowrap"
                    >
                      {checkingUpdates ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      <span>
                        {checkingUpdates ? t('update.checking') : t('update.checkNowBtn')}
                      </span>
                    </button>
                  )}
                </div>

                <div className="divide-y divide-white/[0.07]">
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('update.currentVersionLabel')}</p>
                      <p className="text-sm font-semibold text-white font-mono mt-1 tabular-nums">
                        v{updateCheckResult?.currentVersion || APP_VERSION} · Build{' '}
                        {updateCheckResult?.currentVersionCode || APP_VERSION_CODE}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('update.channelLabel')}</p>
                      <p className="text-sm font-semibold text-white mt-1">
                        {t(getChannelDisplayKey(activeChannel))}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#7F8799]">{t('update.lastCheckedLabel')}</p>
                      <p className="text-sm font-semibold text-white mt-1 tabular-nums">
                        {formatDateTime(updateCheckResult?.checkedAt)}
                      </p>
                    </div>
                  </div>

                  {/* Auto-check on launch switch */}
                  <div className="p-5 flex items-center justify-between gap-4">
                    <div className="max-w-lg min-w-0">
                      <p className="text-sm font-semibold text-white">
                        {t('update.autoCheckLabel')}
                      </p>
                      <p className="text-xs text-[#9CA3B2] mt-0.5 leading-relaxed">
                        {t('update.autoCheckDesc')}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-focusable="true"
                      role="switch"
                      aria-checked={settings.autoCheckUpdates !== false}
                      aria-label={t('update.autoCheckLabel')}
                      onClick={() =>
                        onUpdateSettings({
                          ...settings,
                          autoCheckUpdates: settings.autoCheckUpdates === false,
                        })
                      }
                      className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                        settings.autoCheckUpdates !== false ? 'bg-[#E50914]' : 'bg-white/15'
                      }`}
                    >
                      <span
                        className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                          settings.autoCheckUpdates !== false ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Live Update Check Status */}
                  {updateCheckResult && (
                    <div className="p-5">
                      {updateCheckResult.updateAvailable ? (
                        <div className="p-4 rounded-xl bg-emerald-500/12 border border-emerald-500/35 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-start gap-2.5 text-xs text-emerald-100">
                            <Download className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                            <div>
                              <p className="font-bold text-white">
                                {t('update.modalTitle')} (v{updateCheckResult.latest?.version})
                              </p>
                              <p className="mt-0.5 text-emerald-200/90">
                                {t('update.dataSafetyNote')}
                              </p>
                            </div>
                          </div>
                          {onOpenUpdateModal && (
                            <button
                              type="button"
                              data-focusable="true"
                              onClick={onOpenUpdateModal}
                              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs font-semibold text-white whitespace-nowrap"
                            >
                              {t('update.viewUpdateBtn')}
                            </button>
                          )}
                        </div>
                      ) : updateCheckResult.status === 'error' ? (
                        <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 text-xs text-red-200 flex items-start gap-2.5">
                          <AlertCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                          <span>{updateCheckResult.error}</span>
                        </div>
                      ) : (
                        <div className="p-3.5 rounded-xl bg-[#08090D] border border-white/[0.08] text-xs text-[#D6DCE8] flex items-start gap-2.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <span>
                            {updateCheckResult.status === 'no_releases'
                              ? t('update.noReleases', { repo: `${GITHUB_OWNER}/${GITHUB_REPO}` })
                              : updateCheckResult.status === 'asset_missing'
                              ? t('update.assetMissing', {
                                  version: updateCheckResult.latest?.version || APP_VERSION,
                                })
                              : updateCheckResult.status === 'play_store_managed'
                              ? t('update.playManaged')
                              : t('update.upToDate', {
                                  version: `v${updateCheckResult.currentVersion}`,
                                })}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] divide-y divide-white/[0.07]">
                <div className="px-5 py-4">
                  <h3 className="text-sm font-semibold text-white">
                    {t('settings.aboutShortcutsTitle')}
                  </h3>
                </div>
                <div className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <span className="text-xs sm:text-sm text-[#B8BFCC]">
                    {t('settings.aboutShortcutSearch')}
                  </span>
                  <kbd className="px-2.5 py-1 rounded-md bg-[#08090D] border border-white/15 text-xs font-mono text-white shrink-0">
                    Ctrl + K
                  </kbd>
                </div>
                <div className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <span className="text-xs sm:text-sm text-[#B8BFCC]">
                    {t('settings.aboutShortcutArrows')}
                  </span>
                  <kbd className="px-2.5 py-1 rounded-md bg-[#08090D] border border-white/15 text-xs font-mono text-white shrink-0">
                    ↑ ↓ ← → / Enter
                  </kbd>
                </div>
                <div className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <span className="text-xs sm:text-sm text-[#B8BFCC]">
                    {t('settings.aboutShortcutEsc')}
                  </span>
                  <kbd className="px-2.5 py-1 rounded-md bg-[#08090D] border border-white/15 text-xs font-mono text-white shrink-0">
                    Esc / Back
                  </kbd>
                </div>
              </div>

              <div className="rounded-xl bg-[#12141B] border border-white/[0.08] p-5 space-y-3">
                <h3 className="text-sm font-semibold text-white">
                  {t('settings.aboutHelpTitle')}
                </h3>
                <ul className="space-y-2.5 text-xs sm:text-sm text-[#9CA3B2] leading-relaxed">
                  <li>{t('settings.aboutHelpPlayback')}</li>
                  <li>{t('settings.aboutHelpSources')}</li>
                  <li>{t('settings.aboutHelpPrivacy')}</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Reusable Profile Editor Modal */}
      <ProfileEditorModal
        isOpen={profileModalOpen}
        editingProfile={editingProfile}
        canDelete={!editingProfile?.isGuest && nonGuestCount > 1}
        onClose={() => setProfileModalOpen(false)}
        onSave={onSaveProfile}
        onDelete={onDeleteProfile}
      />
    </div>
  );
}
