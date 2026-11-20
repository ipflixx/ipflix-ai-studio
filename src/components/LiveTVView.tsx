import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  EyeOff,
  Hash,
  Heart,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Tv,
} from 'lucide-react';
import type {
  AppSettings,
  EpgProgram,
  LiveChannel,
  PlayerMediaItem,
  PlaylistCatalog,
  PlaylistSource,
} from '../types/iptv';
import {
  fetchXtreamChannelShortEpg,
  fetchXmltvEpg,
  formatShortTime,
  getEpgForChannel,
} from '../services/iptvApi';
import { ResilientImage } from './MediaArtwork';
import { VideoPlayer } from './VideoPlayer';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle, matchesMediaQuery } from '../utils/titleCleaner';

interface LiveTVViewProps {
  activePlaylist: PlaylistSource | null;
  catalog: PlaylistCatalog | null;
  settings: AppSettings;
  ffmpegAvailable: boolean;
  favorites: Set<string>;
  recentChannelIds: string[];
  hiddenChannelIds: Set<string>;
  lastChannelId?: string;
  lastCategory?: string;
  initialCategory?: string;
  suspended?: boolean;
  onCategoryChange?: (category: string) => void;
  onUpdatePlayerPrefs?: (prefs: {
    playerVolume?: number;
    playerMuted?: boolean;
    playerPlaybackRate?: number;
  }) => void;
  onToggleFavorite: (id: string) => void;
  onOpenFullPlayer: (media: PlayerMediaItem, channelList: LiveChannel[]) => void;
  onChannelTuned: (channel: LiveChannel) => void;
  onHideChannel: (channelId: string) => void;
  onRefreshPlaylist: () => Promise<void>;
  onUpdateEpg: (programs: Record<string, EpgProgram[]>, epgUrl?: string) => void;
  onOpenAddPlaylist: () => void;
}

const STANDARD_LIVE_TABS = [
  'All Channels',
  'Favorites',
  'Recently Watched',
  'Entertainment',
  'Movies',
  'Sports',
  'News',
  'Documentary',
  'Kids',
  'Music',
  'International',
  'Other',
];

const LIVE_TAB_TR: Record<string, string> = {
  'All Channels': 'Tüm Kanallar',
  Favorites: 'Favoriler',
  'Recently Watched': 'Son İzlenenler',
  Entertainment: 'Eğlence',
  Movies: 'Sinema',
  Sports: 'Spor',
  News: 'Haber',
  Documentary: 'Belgesel',
  Kids: 'Çocuk',
  Music: 'Müzik',
  International: 'Uluslararası',
  Other: 'Diğer',
};

const PAGE_SIZE = 80;

export function LiveTVView({
  activePlaylist,
  catalog,
  settings,
  ffmpegAvailable,
  favorites,
  recentChannelIds,
  hiddenChannelIds,
  lastChannelId,
  lastCategory,
  initialCategory,
  suspended = false,
  onCategoryChange,
  onUpdatePlayerPrefs,
  onToggleFavorite,
  onOpenFullPlayer,
  onChannelTuned,
  onHideChannel,
  onRefreshPlaylist,
  onUpdateEpg,
  onOpenAddPlaylist,
}: LiveTVViewProps) {
  const { lang, t } = useI18n();
  const isTr = lang === 'tr';
  const channels = catalog?.channels || [];
  const epgMap = catalog?.epgPrograms || {};

  const resolvePreferredChannel = (list: LiveChannel[]): LiveChannel | null => {
    if (list.length === 0) return null;
    if (lastChannelId) {
      const byLast = list.find((c) => c.id === lastChannelId);
      if (byLast) return byLast;
    }
    for (const rid of recentChannelIds) {
      const byRecent = list.find((c) => c.id === rid);
      if (byRecent) return byRecent;
    }
    return list[0];
  };

  const [viewMode, setViewMode] = useState<'channels' | 'epg'>('channels');
  const [selectedCategory, setSelectedCategory] = useState<string>(
    initialCategory || lastCategory || 'All Channels'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [channelNumInput, setChannelNumInput] = useState('');
  const [countryFilter, setCountryFilter] = useState('all');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [hideUnavailable, setHideUnavailable] = useState(settings.hideUnavailableChannels);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [activeChannel, setActiveChannel] = useState<LiveChannel | null>(() =>
    resolvePreferredChannel(channels)
  );
  const [shortEpgCache, setShortEpgCache] = useState<Record<string, EpgProgram[]>>({});
  const [refreshing, setRefreshing] = useState(false);

  // EPG guide states
  const [epgSearch, setEpgSearch] = useState('');
  const [epgUrlInput, setEpgUrlInput] = useState(activePlaylist?.epgUrl || settings.customEpgUrl || '');
  const [syncingEpg, setSyncingEpg] = useState(false);
  const [epgError, setEpgError] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState<{ channel: LiveChannel; program: EpgProgram } | null>(null);

  const handleSelectCategory = (cat: string) => {
    setSelectedCategory(cat);
    onCategoryChange?.(cat);
  };

  useEffect(() => {
    if (initialCategory) {
      setSelectedCategory(initialCategory);
      onCategoryChange?.(initialCategory);
    } else if (lastCategory) {
      setSelectedCategory(lastCategory);
    }
  }, [initialCategory, lastCategory]);

  useEffect(() => {
    setEpgUrlInput(activePlaylist?.epgUrl || settings.customEpgUrl || '');
  }, [activePlaylist?.epgUrl, settings.customEpgUrl]);

  // Restore last watched channel when catalog loads, profile switches, or playlist changes
  useEffect(() => {
    if (channels.length === 0) {
      setActiveChannel(null);
      return;
    }
    if (lastChannelId) {
      const savedMatch = channels.find((c) => c.id === lastChannelId);
      if (savedMatch && (!activeChannel || activeChannel.id !== savedMatch.id)) {
        setActiveChannel(savedMatch);
        return;
      }
    }
    if (!activeChannel || !channels.some((c) => c.id === activeChannel.id)) {
      setActiveChannel(resolvePreferredChannel(channels));
    }
  }, [channels, lastChannelId, recentChannelIds[0]]);

  // On-demand Xtream short EPG for the active channel if XMLTV isn't present
  useEffect(() => {
    if (!activeChannel || activePlaylist?.type !== 'xtream') return;
    const existing = getEpgForChannel(epgMap, activeChannel, settings.epgTimeOffsetHours);
    if (existing.all.length > 0 || shortEpgCache[activeChannel.id]) return;

    let cancelled = false;
    fetchXtreamChannelShortEpg(activePlaylist, activeChannel).then((list) => {
      if (!cancelled && list.length > 0) {
        setShortEpgCache((prev) => ({ ...prev, [activeChannel.id]: list }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeChannel?.id, activePlaylist?.id]);

  // Dynamic provider categories + countries + languages
  const providerCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ch of channels) {
      counts.set(ch.category, (counts.get(ch.category) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [channels]);

  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const ch of channels) {
      if (ch.country) set.add(ch.country);
    }
    return Array.from(set).sort();
  }, [channels]);

  const languages = useMemo(() => {
    const set = new Set<string>();
    for (const ch of channels) {
      if (ch.language) set.add(ch.language);
    }
    return Array.from(set).sort();
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const recentSet = new Set(recentChannelIds);

    return channels.filter((ch) => {
      if (hideUnavailable && hiddenChannelIds.has(ch.id)) return false;

      if (selectedCategory === 'Favorites' && !favorites.has(ch.id)) return false;
      else if (selectedCategory === 'Recently Watched' && !recentSet.has(ch.id)) return false;
      else if (
        selectedCategory !== 'All Channels' &&
        selectedCategory !== 'Favorites' &&
        selectedCategory !== 'Recently Watched'
      ) {
        const matchesStd = STANDARD_LIVE_TABS.includes(selectedCategory);
        if (matchesStd) {
          if (ch.normalizedCategory !== selectedCategory && ch.category !== selectedCategory) return false;
        } else if (ch.category !== selectedCategory) {
          return false;
        }
      }

      if (countryFilter !== 'all' && ch.country !== countryFilter) return false;
      if (languageFilter !== 'all' && ch.language !== languageFilter) return false;

      if (q && !matchesMediaQuery(ch.name, q, ch.category, String(ch.num))) {
        return false;
      }

      return true;
    });
  }, [
    channels,
    favorites,
    recentChannelIds,
    hiddenChannelIds,
    hideUnavailable,
    selectedCategory,
    countryFilter,
    languageFilter,
    searchQuery,
  ]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [selectedCategory, searchQuery, countryFilter, languageFilter, hideUnavailable]);

  const handleSelectChannel = (ch: LiveChannel) => {
    setActiveChannel(ch);
    onChannelTuned(ch);
  };

  const handleChannelNumberJump = (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseInt(channelNumInput.trim(), 10);
    if (Number.isNaN(num)) return;
    const found = channels.find((c) => c.num === num);
    if (found) {
      handleSelectChannel(found);
      setChannelNumInput('');
    }
  };

  const activeIdx = activeChannel
    ? filteredChannels.findIndex((c) => c.id === activeChannel.id)
    : -1;

  const zapPrev = () => {
    if (filteredChannels.length === 0) return;
    const prevIdx = activeIdx <= 0 ? filteredChannels.length - 1 : activeIdx - 1;
    handleSelectChannel(filteredChannels[prevIdx]);
  };

  const zapNext = () => {
    if (filteredChannels.length === 0) return;
    const nextIdx = activeIdx >= filteredChannels.length - 1 ? 0 : activeIdx + 1;
    handleSelectChannel(filteredChannels[nextIdx]);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshPlaylist();
    } finally {
      setRefreshing(false);
    }
  };

  const handleSyncEpg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!epgUrlInput.trim()) return;
    setSyncingEpg(true);
    setEpgError(null);
    try {
      const res = await fetchXmltvEpg(epgUrlInput.trim(), activePlaylist?.userAgent || settings.defaultUserAgent);
      if (!res.ok || !res.programs) {
        setEpgError(
          res.error ||
            (isTr
              ? 'Bu bağlantıdan XMLTV EPG ayrıştırılamadı.'
              : 'Could not parse XMLTV EPG from this URL.')
        );
      } else {
        onUpdateEpg(res.programs, epgUrlInput.trim());
      }
    } catch (err) {
      setEpgError(
        err instanceof Error ? err.message : isTr ? 'EPG senkronizasyonu başarısız' : 'EPG sync failed'
      );
    } finally {
      setSyncingEpg(false);
    }
  };

  const getChannelEpg = (ch: LiveChannel) => {
    const combinedMap = shortEpgCache[ch.id]
      ? { ...epgMap, [(ch.epgId || ch.name).toLowerCase()]: shortEpgCache[ch.id] }
      : epgMap;
    return getEpgForChannel(combinedMap, ch, settings.epgTimeOffsetHours);
  };

  const buildPlayerMedia = (ch: LiveChannel): PlayerMediaItem => ({
    id: ch.id,
    type: 'live',
    title: cleanMediaTitle(ch.name),
    subtitle: `${isTr ? 'Kanal' : 'Ch.'} ${ch.num} · ${ch.category}`,
    streamUrl: ch.streamUrl,
    altStreamUrl: ch.altStreamUrl,
    httpsStreamUrl: ch.httpsStreamUrl,
    directSourceUrl: ch.directSourceUrl,
    poster: ch.logo,
    userAgent: ch.customUserAgent || activePlaylist?.userAgent || settings.defaultUserAgent,
    referer: ch.customReferer,
    channel: ch,
  });

  // EPG timeline window (current hour - 1h to +6h)
  const timelineStart = useMemo(() => {
    const now = Date.now();
    return Math.floor(now / (3600 * 1000)) * (3600 * 1000) - 3600 * 1000;
  }, [viewMode]);
  const timelineHours = 7;
  const timelineDurationMs = timelineHours * 3600 * 1000;
  const nowPct = Math.max(0, Math.min(100, ((Date.now() - timelineStart) / timelineDurationMs) * 100));

  if (channels.length === 0) {
    return (
      <div className="px-5 sm:px-8 py-16">
        <div className="max-w-xl mx-auto rounded-2xl bg-[#12141B] border border-white/10 p-10 text-center space-y-4">
          <Tv className="w-10 h-10 text-[#666E80] mx-auto" />
          <h2 className="text-xl font-bold text-white">
            {isTr ? 'Henüz Canlı TV Kanalı Yüklenmedi' : 'No Live TV Channels Loaded'}
          </h2>
          <p className="text-sm text-[#9CA3B2]">
            {isTr
              ? 'EPG yayın akışı ve otomatik uyumlu oynatma ile canlı kanalları izlemek için Xtream Codes hesabınızı veya M3U listenizi bağlayın.'
              : 'Connect an Xtream Codes subscription or M3U/M3U8 playlist to watch live channels with EPG program guide and automatic MPEG-TS / HLS playback.'}
          </p>
          <button
            type="button"
            onClick={onOpenAddPlaylist}
            className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-sm font-semibold transition-colors"
          >
            {t('home.connectSource')}
          </button>
        </div>
      </div>
    );
  }

  const activeEpg = activeChannel ? getChannelEpg(activeChannel) : null;
  const localeStr = isTr ? 'tr-TR' : 'en-US';

  return (
    <div className="px-4 sm:px-8 lg:px-12 xl:px-14 py-5 sm:py-6 space-y-5 sm:space-y-6 pb-12 sm:pb-20">
      {/* Header & View Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5 sm:gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('live.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[#9CA3B2] mt-0.5 tabular-nums">
            {isTr
              ? `${channels.length.toLocaleString(localeStr)} kanaldan ${filteredChannels.length.toLocaleString(localeStr)} tanesi listeleniyor`
              : `${filteredChannels.length.toLocaleString(localeStr)} of ${channels.length.toLocaleString(localeStr)} channels available`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Segmented View Toggle */}
          <div className="inline-flex p-1 rounded-lg bg-[#12141B] border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setViewMode('channels')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'channels' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              {t('live.viewList')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('epg')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'epg' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
              }`}
            >
              <CalendarClock className="w-3.5 h-3.5" />
              {t('live.viewGuide')} (EPG)
            </button>
          </div>

          {/* Direct Channel Number Jump */}
          <form onSubmit={handleChannelNumberJump} className="relative w-24 sm:w-28">
            <Hash className="w-3.5 h-3.5 text-[#666E80] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="number"
              min={1}
              value={channelNumInput}
              onChange={(e) => setChannelNumInput(e.target.value)}
              placeholder={isTr ? 'Kanal #' : 'Ch #'}
              aria-label={isTr ? 'Kanal numarasına git' : 'Jump to channel number'}
              className="w-full min-h-[42px] sm:min-h-[38px] pl-7 pr-2.5 py-2 rounded-lg bg-[#12141B] border border-white/10 focus:border-[#E50914] focus:outline-none text-base sm:text-xs font-mono tabular-nums text-white placeholder:text-[#666E80]"
            />
          </form>

          <button
            type="button"
            onClick={() => setHideUnavailable((h) => !h)}
            className={`min-h-[42px] sm:min-h-[38px] px-3 py-2 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              hideUnavailable
                ? 'bg-white/10 border-white/25 text-white'
                : 'bg-[#12141B] border-white/10 text-[#9CA3B2] hover:text-white'
            }`}
          >
            <EyeOff className="w-3.5 h-3.5" />
            {isTr ? 'Gizlenenleri Sakla' : 'Hide Unavailable'}
          </button>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="min-h-[42px] sm:min-h-[38px] px-3 py-2 rounded-lg bg-[#12141B] border border-white/10 hover:border-white/25 text-xs font-medium text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* Category Filter Rail */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        {STANDARD_LIVE_TABS.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => handleSelectCategory(cat)}
            className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              selectedCategory === cat
                ? 'bg-[#E50914] text-white'
                : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
            }`}
          >
            {isTr ? LIVE_TAB_TR[cat] || cat : cat}
          </button>
        ))}

        {/* Provider exact groups */}
        {providerCategories
          .filter((p) => !STANDARD_LIVE_TABS.includes(p.name))
          .slice(0, 20)
          .map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => handleSelectCategory(p.name)}
              className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                selectedCategory === p.name
                  ? 'bg-[#E50914] text-white'
                  : 'bg-[#12141B] text-[#9CA3B2] hover:text-white border border-white/[0.06]'
              }`}
            >
              {p.name} ({p.count})
            </button>
          ))}
      </div>

      {/* LIVE CHANNELS + EMBEDDED PLAYER SPLIT VIEW */}
      {viewMode === 'channels' ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left / Top: Live Cinema Stage */}
          <div className="xl:col-span-7 space-y-4 xl:sticky xl:top-20">
            {activeChannel && (
              <>
                {suspended ? (
                  <div className="relative w-full aspect-video bg-[#0B0C11] rounded-xl overflow-hidden border border-white/10 flex flex-col items-center justify-center gap-3 text-center px-4">
                    <Tv className="w-8 h-8 text-[#666E80]" />
                    <p className="text-sm font-medium text-white/90">
                      {isTr ? 'Tam Ekran Sinema Modunda Oynatılıyor' : 'Playing in Fullscreen Cinema Mode'}
                    </p>
                    <p className="text-xs text-[#666E80]">
                      {isTr
                        ? 'Tek bağlantılı IPTV hesaplarının kesilmemesi için önizleme yayını duraklatıldı'
                        : 'Preview stream paused automatically to keep single-connection IPTV accounts active'}
                    </p>
                  </div>
                ) : (
                  <VideoPlayer
                    media={buildPlayerMedia(activeChannel)}
                    settings={settings}
                    ffmpegAvailable={ffmpegAvailable}
                    embedded
                    onUpdatePlayerPrefs={onUpdatePlayerPrefs}
                    onPrevItem={zapPrev}
                    onNextItem={zapNext}
                    prevLabel={t('player.prevChannel')}
                    nextLabel={t('player.nextChannel')}
                    onExpandFullscreenView={() =>
                      onOpenFullPlayer(buildPlayerMedia(activeChannel), filteredChannels)
                    }
                    onMarkUnavailable={() => {
                      onHideChannel(activeChannel.id);
                      zapNext();
                    }}
                  />
                )}

                {/* Active Channel Info & Now/Next Program Strip */}
                <div className="rounded-xl bg-[#12141B] border border-white/[0.08] p-5 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#181B24] shrink-0">
                        <ResilientImage
                          src={activeChannel.logo}
                          alt={cleanMediaTitle(activeChannel.name)}
                          fallbackTitle={cleanMediaTitle(activeChannel.name)}
                          fallbackKind="channel"
                          className="w-full h-full object-contain p-1"
                        />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold text-white truncate">
                          {cleanMediaTitle(activeChannel.name)}
                        </h2>
                        <p className="text-xs text-[#9CA3B2] tabular-nums">
                          {isTr ? 'Kanal' : 'Ch.'} {activeChannel.num} · {activeChannel.category}
                          {activeChannel.country ? ` · ${activeChannel.country}` : ''}
                          {activeChannel.language ? ` · ${activeChannel.language}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0 w-full sm:w-auto">
                      <button
                        type="button"
                        onClick={zapPrev}
                        aria-label={t('player.prevChannel')}
                        className="w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-[#181B24] hover:bg-white/10 text-white flex items-center justify-center transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={zapNext}
                        aria-label={t('player.nextChannel')}
                        className="w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-[#181B24] hover:bg-white/10 text-white flex items-center justify-center transition-colors"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleFavorite(activeChannel.id)}
                        aria-label={t('live.toggleFavorite')}
                        className={`w-11 h-11 sm:w-9 sm:h-9 rounded-lg border flex items-center justify-center transition-colors ${
                          favorites.has(activeChannel.id)
                            ? 'bg-[#E50914]/15 border-[#E50914] text-[#E50914]'
                            : 'bg-[#181B24] border-white/10 text-white/80 hover:text-white'
                        }`}
                      >
                        <Heart
                          className={`w-4 h-4 ${favorites.has(activeChannel.id) ? 'fill-current' : ''}`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onOpenFullPlayer(buildPlayerMedia(activeChannel), filteredChannels)
                        }
                        className="flex-1 sm:flex-none min-h-[44px] sm:min-h-[36px] px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold transition-colors whitespace-nowrap"
                      >
                        {isTr ? 'Tam Ekran İzle' : 'Fullscreen Mode'}
                      </button>
                    </div>
                  </div>

                  {/* Now & Next EPG Details */}
                  {activeEpg?.current ? (
                    <div className="pt-3 border-t border-white/[0.06] space-y-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-white">
                          {t('live.nowPlaying')}: {activeEpg.current.title}
                        </span>
                        <span className="font-mono tabular-nums text-[#9CA3B2] shrink-0">
                          {formatShortTime(activeEpg.current.start)} – {formatShortTime(activeEpg.current.end)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full bg-[#E50914]"
                          style={{ width: `${activeEpg.progressPct}%` }}
                        />
                      </div>
                      {activeEpg.current.description && (
                        <p className="text-xs text-[#9CA3B2] leading-relaxed">
                          {activeEpg.current.description}
                        </p>
                      )}
                      {activeEpg.next && (
                        <p className="text-xs text-[#666E80] tabular-nums">
                          {t('live.upNext')} ({formatShortTime(activeEpg.next.start)}):{' '}
                          <span className="text-[#9CA3B2]">{activeEpg.next.title}</span>
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs text-[#666E80]">
                      <span>{t('live.epgEmpty')}</span>
                      <button
                        type="button"
                        onClick={() => setViewMode('epg')}
                        className="text-white/80 hover:text-white underline"
                      >
                        {t('live.epgLoadCustom')}
                      </button>
                    </div>
                  )}

                  {activeChannel.catchup && activeChannel.catchupSource && (
                    <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs">
                      <span className="text-[#9CA3B2]">
                        {isTr
                          ? `Geri sarma arşivi mevcut (${activeChannel.catchupDays || 3} gün)`
                          : `Catch-up archive available (${activeChannel.catchupDays || 3} days)`}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onOpenFullPlayer(
                            {
                              ...buildPlayerMedia(activeChannel),
                              title: `${cleanMediaTitle(activeChannel.name)} (${t('live.catchup')})`,
                              streamUrl: activeChannel.catchupSource!,
                            },
                            filteredChannels
                          )
                        }
                        className="text-[#E50914] font-semibold hover:underline"
                      >
                        {isTr ? 'Arşivden İzle' : 'Play Catch-Up Stream'}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Right: Searchable Channel Directory */}
          <div className="xl:col-span-5 rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden flex flex-col">
            <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-[#666E80] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('live.searchPlaceholder')}
                  className="w-full min-h-[44px] sm:min-h-[38px] pl-9 pr-3 py-2 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-base sm:text-xs text-white placeholder:text-[#666E80]"
                />
              </div>

              {(countries.length > 0 || languages.length > 0) && (
                <div className="grid grid-cols-2 gap-2">
                  {countries.length > 0 && (
                    <select
                      value={countryFilter}
                      onChange={(e) => setCountryFilter(e.target.value)}
                      className="min-h-[40px] sm:min-h-[34px] px-2.5 py-1.5 rounded-lg bg-[#08090D] border border-white/10 text-sm sm:text-xs text-white"
                    >
                      <option value="all">{t('live.allCountries')}</option>
                      {countries.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                  {languages.length > 0 && (
                    <select
                      value={languageFilter}
                      onChange={(e) => setLanguageFilter(e.target.value)}
                      className="min-h-[40px] sm:min-h-[34px] px-2.5 py-1.5 rounded-lg bg-[#08090D] border border-white/10 text-sm sm:text-xs text-white"
                    >
                      <option value="all">{t('live.allLanguages')}</option>
                      {languages.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <div className="divide-y divide-white/[0.05] max-h-[60vh] xl:max-h-[68vh] overflow-y-auto">
              {filteredChannels.slice(0, visibleCount).map((ch) => {
                const isSelected = activeChannel?.id === ch.id;
                const isFav = favorites.has(ch.id);
                const chEpg = getChannelEpg(ch);
                const chDisplayName = cleanMediaTitle(ch.name);

                return (
                  <div
                    key={ch.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectChannel(ch)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectChannel(ch);
                      }
                    }}
                    className={`min-h-[60px] px-3 sm:px-3.5 py-3 flex items-center gap-2.5 sm:gap-3 transition-colors cursor-pointer ${
                      isSelected ? 'bg-[#E50914]/15' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="w-8 sm:w-9 text-right font-mono text-xs text-[#666E80] tabular-nums shrink-0">
                      {ch.num}
                    </span>

                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-[#181B24] shrink-0">
                      <ResilientImage
                        src={ch.logo}
                        alt={chDisplayName}
                        fallbackTitle={chDisplayName}
                        fallbackKind="channel"
                        className="w-full h-full object-contain p-0.5"
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-semibold truncate ${isSelected ? 'text-white' : 'text-white/90'}`}>
                          {chDisplayName}
                        </p>
                      </div>
                      <p className="text-xs text-[#9CA3B2] truncate">
                        {chEpg.current
                          ? `${chEpg.current.title} · ${formatShortTime(chEpg.current.start)}`
                          : ch.category}
                      </p>
                      {chEpg.current && (
                        <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden max-w-[180px]">
                          <div
                            className="h-full bg-[#E50914]"
                            style={{ width: `${chEpg.progressPct}%` }}
                          />
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(ch.id);
                      }}
                      aria-label={isFav ? t('common.removeFavorite') : t('common.favoriteAdd')}
                      className={`w-10 h-10 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                        isFav ? 'text-[#E50914]' : 'text-[#666E80] hover:text-white'
                      }`}
                    >
                      <Heart className={`w-4 h-4 ${isFav ? 'fill-current' : ''}`} />
                    </button>
                  </div>
                );
              })}

              {filteredChannels.length === 0 && (
                <div className="p-8 text-center text-sm text-[#9CA3B2]">
                  {t('live.noChannels')}
                </div>
              )}

              {visibleCount < filteredChannels.length && (
                <div className="p-4 text-center">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                    className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white transition-colors"
                  >
                    {t('movies.loadMore', {
                      remaining: (filteredChannels.length - visibleCount).toLocaleString(localeStr),
                    })}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ELECTRONIC PROGRAM GUIDE (EPG) TIMELINE VIEW */
        <div className="space-y-4">
          {/* XMLTV Sync & Program Search Toolbar */}
          <div className="rounded-xl bg-[#12141B] border border-white/[0.08] p-4 flex flex-col lg:flex-row gap-3 justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-[#666E80] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={epgSearch}
                onChange={(e) => setEpgSearch(e.target.value)}
                placeholder={
                  isTr
                    ? 'TV rehberinde program veya kanal ara...'
                    : 'Search TV guide programs or channels...'
                }
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-xs text-white placeholder:text-[#666E80]"
              />
            </div>

            <form onSubmit={handleSyncEpg} className="flex flex-1 max-w-xl gap-2">
              <input
                type="text"
                value={epgUrlInput}
                onChange={(e) => setEpgUrlInput(e.target.value)}
                placeholder={isTr ? 'XMLTV EPG Bağlantısı (.xml veya .xml.gz)' : 'XMLTV EPG URL (.xml or .xml.gz)'}
                className="flex-1 px-3 py-2 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-xs font-mono text-white placeholder:text-[#666E80]"
              />
              <button
                type="submit"
                disabled={syncingEpg || !epgUrlInput.trim()}
                className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                {syncingEpg && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('settings.epgSyncBtn')}
              </button>
            </form>
          </div>

          {epgError && (
            <p className="text-xs text-red-400 px-1">{epgError}</p>
          )}

          {/* Selected Program Inspector */}
          {selectedProgram && (
            <div className="rounded-xl bg-[#181B24] border border-white/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <p className="text-xs text-[#9CA3B2] tabular-nums">
                  {cleanMediaTitle(selectedProgram.channel.name)} · {formatShortTime(selectedProgram.program.start)} –{' '}
                  {formatShortTime(selectedProgram.program.end)}
                </p>
                <h3 className="text-base font-bold text-white">{selectedProgram.program.title}</h3>
                {selectedProgram.program.description && (
                  <p className="text-xs text-[#B6BCC9] max-w-2xl">
                    {selectedProgram.program.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  handleSelectChannel(selectedProgram.channel);
                  onOpenFullPlayer(buildPlayerMedia(selectedProgram.channel), filteredChannels);
                }}
                className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {t('live.watchNow')}
              </button>
            </div>
          )}

          {/* EPG Timeline Grid */}
          <div className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-x-auto">
            <div className="min-w-[960px]">
              {/* Time Ruler */}
              <div className="grid grid-cols-[220px_1fr] border-b border-white/[0.08] bg-[#0B0C11]">
                <div className="px-4 py-3 text-xs font-semibold text-[#9CA3B2] flex items-center gap-2 border-r border-white/[0.08]">
                  <Clock className="w-3.5 h-3.5" />
                  {t('live.epgTitle')}
                </div>
                <div className="relative grid grid-cols-7">
                  {Array.from({ length: timelineHours }).map((_, i) => (
                    <div
                      key={i}
                      className="px-3 py-3 text-xs font-mono tabular-nums text-[#9CA3B2] border-r border-white/[0.05]"
                    >
                      {formatShortTime(timelineStart + i * 3600 * 1000)}
                    </div>
                  ))}
                  {/* Current Time Line Header Marker */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-[#E50914] z-10 pointer-events-none"
                    style={{ left: `${nowPct}%` }}
                  />
                </div>
              </div>

              {/* Channel Rows */}
              <div className="divide-y divide-white/[0.06] max-h-[62vh] overflow-y-auto">
                {filteredChannels
                  .filter((ch) => {
                    if (!epgSearch.trim()) return true;
                    const q = epgSearch.toLowerCase();
                    if (matchesMediaQuery(ch.name, q)) return true;
                    const progs = getChannelEpg(ch).all;
                    return progs.some(
                      (p) =>
                        p.title.toLowerCase().includes(q) ||
                        (p.description || '').toLowerCase().includes(q)
                    );
                  })
                  .slice(0, 60)
                  .map((ch) => {
                    const chEpg = getChannelEpg(ch);
                    const chDisplayName = cleanMediaTitle(ch.name);
                    const now = Date.now();
                    const visibleProgs = chEpg.all.filter(
                      (p) => p.end > timelineStart && p.start < timelineStart + timelineDurationMs
                    );

                    return (
                      <div key={ch.id} className="grid grid-cols-[220px_1fr] min-h-[64px]">
                        <button
                          type="button"
                          onClick={() => {
                            handleSelectChannel(ch);
                            setViewMode('channels');
                          }}
                          className="px-3.5 py-2.5 flex items-center gap-2.5 text-left border-r border-white/[0.08] hover:bg-white/[0.04] transition-colors min-w-0"
                        >
                          <div className="w-8 h-8 rounded bg-[#181B24] overflow-hidden shrink-0">
                            <ResilientImage
                              src={ch.logo}
                              alt={chDisplayName}
                              fallbackTitle={chDisplayName}
                              fallbackKind="channel"
                              className="w-full h-full object-contain p-0.5"
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-white truncate">{chDisplayName}</p>
                            <p className="text-[11px] font-mono text-[#666E80] tabular-nums">
                              {isTr ? 'Kanal' : 'Ch.'} {ch.num}
                            </p>
                          </div>
                        </button>

                        <div className="relative bg-[#0E1017]">
                          {/* Live Red Now Line */}
                          <div
                            className="absolute top-0 bottom-0 w-0.5 bg-[#E50914]/70 z-10 pointer-events-none"
                            style={{ left: `${nowPct}%` }}
                          />

                          {visibleProgs.length > 0 ? (
                            visibleProgs.map((prog) => {
                              const leftPct = Math.max(
                                0,
                                ((prog.start - timelineStart) / timelineDurationMs) * 100
                              );
                              const rightPct = Math.min(
                                100,
                                ((prog.end - timelineStart) / timelineDurationMs) * 100
                              );
                              const widthPct = Math.max(2, rightPct - leftPct);
                              const isCurrent = prog.start <= now && prog.end > now;

                              return (
                                <button
                                  key={prog.id}
                                  type="button"
                                  onClick={() => setSelectedProgram({ channel: ch, program: prog })}
                                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                                  className={`absolute top-1.5 bottom-1.5 px-2.5 py-1 rounded-md border text-left overflow-hidden transition-colors ${
                                    isCurrent
                                      ? 'bg-[#E50914]/20 border-[#E50914]/60 text-white'
                                      : 'bg-[#161923] border-white/[0.08] hover:border-white/25 text-white/85'
                                  }`}
                                >
                                  <p className="text-xs font-semibold truncate">{prog.title}</p>
                                  <p className="text-[10px] font-mono tabular-nums text-[#9CA3B2] truncate">
                                    {formatShortTime(prog.start)} – {formatShortTime(prog.end)}
                                  </p>
                                </button>
                              );
                            })
                          ) : (
                            <div className="h-full flex items-center px-4 text-xs text-[#666E80]">
                              {isTr
                                ? 'Program akışı mevcut değil — doldurmak için yukarıdan XMLTV bağlantısı yükleyin'
                                : 'No program schedule available — attach an XMLTV source above to populate'}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
