import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Film,
  FolderOpen,
  Globe,
  Link2,
  Loader2,
  Server,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import type {
  LiveChannel,
  MovieItem,
  PlaylistCatalog,
  PlaylistSource,
  SeriesItem,
} from '../types/iptv';
import { USER_AGENT_PROFILES } from '../types/iptv';
import {
  authenticateXtream,
  fetchAndParseM3U,
  fetchXmltvEpg,
  syncXtreamCatalog,
  type XtreamAuthResponse,
} from '../services/iptvApi';
import { findMatchingPlaylistId } from '../services/storage';
import { useI18n } from '../i18n/I18nContext';

interface PlaylistModalProps {
  isOpen: boolean;
  editingPlaylist?: PlaylistSource | null;
  existingPlaylists?: PlaylistSource[];
  onClose: () => void;
  onPlaylistSaved: (source: PlaylistSource, catalog: PlaylistCatalog) => Promise<void>;
}

type ModalTab = 'xtream' | 'm3u' | 'local';

export function PlaylistModal({
  isOpen,
  editingPlaylist,
  existingPlaylists = [],
  onClose,
  onPlaylistSaved,
}: PlaylistModalProps) {
  const { lang, t } = useI18n();
  const isTr = lang === 'tr';
  const [tab, setTab] = useState<ModalTab>('xtream');

  // Shared fields
  const [playlistName, setPlaylistName] = useState('');
  const [userAgent, setUserAgent] = useState(USER_AGENT_PROFILES[0].value);
  const [customUa, setCustomUa] = useState('');
  const [isDefault, setIsDefault] = useState(true);

  // Xtream fields
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [liveFormat, setLiveFormat] = useState<'auto' | 'm3u8' | 'ts'>('auto');
  const [testResult, setTestResult] = useState<XtreamAuthResponse | null>(null);
  const [testing, setTesting] = useState(false);

  // M3U fields
  const [m3uMode, setM3uMode] = useState<'url' | 'file'>('url');
  const [m3uUrl, setM3uUrl] = useState('');
  const [m3uFileText, setM3uFileText] = useState('');
  const [m3uFileName, setM3uFileName] = useState('');
  const [epgUrl, setEpgUrl] = useState('');

  // Local media fields
  const [localFiles, setLocalFiles] = useState<File[]>([]);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [progressStage, setProgressStage] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setTestResult(null);
    setProgressStage('');
    setProgressPct(0);

    if (editingPlaylist) {
      setPlaylistName(editingPlaylist.name);
      setIsDefault(Boolean(editingPlaylist.isDefault));
      setUserAgent(editingPlaylist.userAgent || USER_AGENT_PROFILES[0].value);
      setEpgUrl(editingPlaylist.epgUrl || '');

      if (editingPlaylist.type === 'xtream') {
        setTab('xtream');
        setServerUrl(editingPlaylist.serverUrl || editingPlaylist.resolvedServerUrl || '');
        setUsername(editingPlaylist.username || '');
        setPassword(editingPlaylist.password || '');
        setLiveFormat(editingPlaylist.liveFormat || 'auto');
      } else if (editingPlaylist.type === 'local') {
        setTab('local');
      } else {
        setTab('m3u');
        setM3uMode(editingPlaylist.type === 'm3u_file' ? 'file' : 'url');
        setM3uUrl(editingPlaylist.m3uUrl || '');
      }
    } else {
      setPlaylistName('');
      setServerUrl('');
      setUsername('');
      setPassword('');
      setLiveFormat('auto');
      setM3uUrl('');
      setM3uFileText('');
      setM3uFileName('');
      setEpgUrl('');
      setLocalFiles([]);
      setUserAgent(USER_AGENT_PROFILES[0].value);
      setCustomUa('');
      setIsDefault(true);
    }
  }, [isOpen, editingPlaylist]);

  if (!isOpen) return null;

  const effectiveUa = userAgent === 'custom' ? customUa.trim() || USER_AGENT_PROFILES[0].value : userAgent;

  // Smart auto-extract if user pastes a full get.php / player_api.php link in Xtream Server URL
  const extractCredentialsFromUrl = (val: string): { u?: string; p?: string } => {
    try {
      if (val.includes('username=') || val.includes('password=')) {
        const parsed = new URL(val.startsWith('http') ? val : `http://${val}`);
        return {
          u: parsed.searchParams.get('username')?.trim() || undefined,
          p: parsed.searchParams.get('password')?.trim() || undefined,
        };
      }
    } catch {
      // ignore partial input
    }
    return {};
  };

  const handleServerUrlChange = (val: string) => {
    setServerUrl(val);
    setTestResult(null);
    const extracted = extractCredentialsFromUrl(val);
    if (extracted.u && !username) setUsername(extracted.u);
    if (extracted.p && !password) setPassword(extracted.p);
  };

  const handleTestXtream = async () => {
    setError(null);
    setTestResult(null);
    const extracted = extractCredentialsFromUrl(serverUrl);
    const effUser = username.trim() || extracted.u || '';
    const effPass = password.trim() || extracted.p || '';
    if (!serverUrl.trim() || !effUser || !effPass) {
      setError(t('onboarding.errMissingXtream'));
      return;
    }
    if (!username.trim() && effUser) setUsername(effUser);
    if (!password.trim() && effPass) setPassword(effPass);

    setTesting(true);
    try {
      const res = await authenticateXtream({
        serverUrl: serverUrl.trim(),
        username: effUser,
        password: effPass,
        userAgent: effectiveUa,
      });
      setTestResult(res);
      if (!res.ok) {
        setError(res.error || t('onboarding.errConnection'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.errConnection'));
    } finally {
      setTesting(false);
    }
  };

  const handleM3uFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setM3uFileName(file.name);
    if (!playlistName) {
      setPlaylistName(file.name.replace(/\.(m3u8?|txt)$/i, ''));
    }
    const text = await file.text();
    setM3uFileText(text);
  };

  const handleLocalFilesSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setLocalFiles((prev) => [...prev, ...files]);
    if (!playlistName) setPlaylistName('Local Cinema Library');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const now = Date.now();

    if (tab === 'xtream') {
      const extracted = extractCredentialsFromUrl(serverUrl);
      const effUser = username.trim() || extracted.u || '';
      const effPass = password.trim() || extracted.p || '';

      if (!serverUrl.trim() || !effUser || !effPass) {
        setError(t('onboarding.errMissingXtream'));
        return;
      }

      setSubmitting(true);
      setProgressStage(
        isTr
          ? 'Xtream Codes sunucusuyla bağlantı kuruluyor...'
          : 'Authenticating with Xtream Codes server...'
      );
      setProgressPct(10);

      try {
        const auth = await authenticateXtream({
          serverUrl: serverUrl.trim(),
          username: effUser,
          password: effPass,
          userAgent: effectiveUa,
        });

        if (!auth.ok || !auth.resolvedServerUrl) {
          setTestResult(auth);
          setError(auth.error || t('onboarding.errConnection'));
          setSubmitting(false);
          return;
        }

        const matchedId = editingPlaylist
          ? null
          : findMatchingPlaylistId(existingPlaylists, {
              type: 'xtream',
              serverUrl: serverUrl.trim(),
              resolvedServerUrl: auth.resolvedServerUrl,
              username: auth.username || effUser,
            }) ||
            (auth.m3uUrl
              ? findMatchingPlaylistId(existingPlaylists, {
                  type: 'm3u_url',
                  m3uUrl: auth.m3uUrl,
                })
              : null);
        const id = editingPlaylist?.id || matchedId || `pl_${now}`;
        const existingPl =
          editingPlaylist ||
          (matchedId ? existingPlaylists.find((p) => p.id === matchedId) : undefined);

        // Seamless M3U Bridge Mode: provider restricted player_api.php, so server verified get.php!
        if (auth.mode === 'm3u_fallback' && auth.m3uUrl) {
          setProgressStage(
            isTr
              ? 'Katalog M3U köprüsü üzerinden içe aktarılıyor...'
              : 'Importing full catalog via M3U Bridge...'
          );
          setProgressPct(40);

          const parsed = await fetchAndParseM3U({
            url: auth.m3uUrl,
            playlistId: id,
            userAgent: auth.workingUserAgent || effectiveUa,
          });

          if (!parsed.ok) {
            setTestResult(auth);
            setError(parsed.error || t('onboarding.errConnection'));
            setSubmitting(false);
            return;
          }

          const resolvedEpgUrl =
            epgUrl.trim() ||
            parsed.detectedEpgUrl ||
            `${auth.resolvedServerUrl}/xmltv.php?username=${encodeURIComponent(
              auth.username || effUser
            )}&password=${encodeURIComponent(effPass)}`;

          let epgPrograms: PlaylistCatalog['epgPrograms'] = {};
          if (resolvedEpgUrl) {
            setProgressStage(
              isTr ? 'XMLTV TV Rehberi (EPG) yükleniyor...' : 'Syncing XMLTV TV Guide (EPG)...'
            );
            setProgressPct(80);
            const epgRes = await fetchXmltvEpg(
              resolvedEpgUrl,
              parsed.workingUserAgent || auth.workingUserAgent || effectiveUa
            ).catch(() => ({ ok: false, programs: undefined }));
            if (epgRes.ok && epgRes.programs) {
              epgPrograms = epgRes.programs;
            }
          }

          const hostname = (() => {
            try {
              return new URL(auth.resolvedServerUrl!).hostname;
            } catch {
              return 'IPTV';
            }
          })();

          const source: PlaylistSource = {
            id,
            name: playlistName.trim() || existingPl?.name || `Xtream (${hostname})`,
            type: 'm3u_url',
            isDefault,
            createdAt: existingPl?.createdAt || now,
            updatedAt: now,
            m3uUrl: parsed.finalUrl || auth.m3uUrl,
            serverUrl: serverUrl.trim(),
            resolvedServerUrl: auth.resolvedServerUrl,
            username: auth.username || effUser,
            password: effPass,
            accountInfo: auth.userInfo,
            userAgent: parsed.workingUserAgent || auth.workingUserAgent || effectiveUa,
            epgUrl: resolvedEpgUrl,
            channelCount: parsed.channels.length,
            movieCount: parsed.movies.length,
            seriesCount: parsed.series.length,
          };

          const catalog: PlaylistCatalog = {
            playlistId: id,
            channels: parsed.channels as LiveChannel[],
            movies: parsed.movies as MovieItem[],
            series: parsed.series as SeriesItem[],
            epgPrograms,
            epgUpdatedAt: Object.keys(epgPrograms).length > 0 ? now : undefined,
          };

          setProgressStage(isTr ? 'Kütüphane kaydediliyor...' : 'Saving library to local storage...');
          setProgressPct(100);
          await onPlaylistSaved(source, catalog);
          onClose();
          return;
        }

        const resolvedEpgUrl =
          epgUrl.trim() ||
          `${auth.resolvedServerUrl}/xmltv.php?username=${encodeURIComponent(
            auth.username || effUser
          )}&password=${encodeURIComponent(effPass)}`;

        const source: PlaylistSource = {
          id,
          name:
            playlistName.trim() ||
            existingPl?.name ||
            `Xtream (${new URL(auth.resolvedServerUrl).hostname})`,
          type: 'xtream',
          isDefault,
          createdAt: existingPl?.createdAt || now,
          updatedAt: now,
          serverUrl: serverUrl.trim(),
          resolvedServerUrl: auth.resolvedServerUrl,
          username: auth.username || effUser,
          password: effPass,
          accountInfo: auth.userInfo,
          userAgent: auth.workingUserAgent || effectiveUa,
          liveFormat,
          epgUrl: resolvedEpgUrl,
          channelCount: 0,
          movieCount: 0,
          seriesCount: 0,
        };

        const catalog = await syncXtreamCatalog(source, (stage, pct) => {
          setProgressStage(stage);
          setProgressPct(pct);
        });

        source.channelCount = catalog.channels.length;
        source.movieCount = catalog.movies.length;
        source.seriesCount = catalog.series.length;

        setProgressStage(isTr ? 'Kütüphane kaydediliyor...' : 'Saving library to local storage...');
        setProgressPct(100);
        await onPlaylistSaved(source, catalog);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('onboarding.errConnection'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (tab === 'm3u') {
      if (m3uMode === 'url' && !m3uUrl.trim()) {
        setError(t('onboarding.errMissingM3uUrl'));
        return;
      }
      if (m3uMode === 'file' && !m3uFileText.trim()) {
        setError(t('onboarding.errMissingM3uFile'));
        return;
      }

      const matchedM3uId =
        !editingPlaylist && m3uMode === 'url'
          ? findMatchingPlaylistId(existingPlaylists, {
              type: 'm3u_url',
              m3uUrl: m3uUrl.trim(),
            })
          : null;
      const id = editingPlaylist?.id || matchedM3uId || `pl_${now}`;
      const existingPl =
        editingPlaylist ||
        (matchedM3uId ? existingPlaylists.find((p) => p.id === matchedM3uId) : undefined);

      setSubmitting(true);
      setProgressStage(
        m3uMode === 'url'
          ? isTr
            ? 'M3U oynatma listesi indiriliyor ve ayrıştırılıyor...'
            : 'Downloading and parsing M3U playlist...'
          : isTr
          ? 'Yüklenen M3U dosyası ayrıştırılıyor...'
          : 'Parsing uploaded M3U file...'
      );
      setProgressPct(35);

      try {
        const parsed = await fetchAndParseM3U({
          url: m3uMode === 'url' ? m3uUrl.trim() : undefined,
          content: m3uMode === 'file' ? m3uFileText : undefined,
          playlistId: id,
          userAgent: effectiveUa,
        });

        if (!parsed.ok) {
          setError(parsed.error || t('onboarding.errConnection'));
          setSubmitting(false);
          return;
        }

        const effectiveEpg = epgUrl.trim() || parsed.detectedEpgUrl || undefined;
        let epgPrograms: PlaylistCatalog['epgPrograms'] = {};

        if (effectiveEpg) {
          setProgressStage(
            isTr ? 'XMLTV TV Rehberi (EPG) yükleniyor...' : 'Syncing XMLTV TV Guide (EPG)...'
          );
          setProgressPct(75);
          const epgRes = await fetchXmltvEpg(effectiveEpg, parsed.workingUserAgent || effectiveUa).catch(
            () => ({ ok: false, programs: undefined })
          );
          if (epgRes.ok && epgRes.programs) {
            epgPrograms = epgRes.programs;
          }
        }

        const source: PlaylistSource = {
          id,
          name:
            playlistName.trim() ||
            existingPl?.name ||
            (m3uMode === 'file'
              ? m3uFileName || (isTr ? 'Yüklenen M3U Listesi' : 'Uploaded M3U Playlist')
              : isTr
              ? 'M3U IPTV Listesi'
              : 'M3U IPTV Playlist'),
          type: m3uMode === 'file' ? 'm3u_file' : 'm3u_url',
          isDefault,
          createdAt: existingPl?.createdAt || now,
          updatedAt: now,
          m3uUrl: m3uMode === 'url' ? parsed.finalUrl || m3uUrl.trim() : undefined,
          epgUrl: effectiveEpg,
          userAgent: parsed.workingUserAgent || effectiveUa,
          channelCount: parsed.channels.length,
          movieCount: parsed.movies.length,
          seriesCount: parsed.series.length,
        };

        const catalog: PlaylistCatalog = {
          playlistId: id,
          channels: parsed.channels as LiveChannel[],
          movies: parsed.movies as MovieItem[],
          series: parsed.series as SeriesItem[],
          epgPrograms,
          epgUpdatedAt: Object.keys(epgPrograms).length > 0 ? now : undefined,
        };

        setProgressStage(isTr ? 'Kütüphane kaydediliyor...' : 'Saving library...');
        setProgressPct(100);
        await onPlaylistSaved(source, catalog);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('onboarding.errConnection'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Local Media Tab
    if (localFiles.length === 0) {
      setError(
        isTr
          ? 'En az bir yerel video veya medya dosyası (.mp4, .mkv, .webm, .mov, .mp3) seçin.'
          : 'Select at least one local media file (.mp4, .mkv, .webm, .mov, .mp3).'
      );
      return;
    }

    const id = editingPlaylist?.id || `pl_${now}`;
    setSubmitting(true);
    try {
      const movies: MovieItem[] = localFiles.map((file, idx) => {
        const cleanTitle = file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
        const ext = file.name.split('.').pop()?.toLowerCase();
        return {
          id: `${id}_local_${idx + 1}`,
          name: cleanTitle,
          streamUrl: URL.createObjectURL(file),
          containerExtension: ext,
          category: 'Local Media',
          genre: 'Local File',
          addedAt: file.lastModified || now,
          isLocal: true,
        };
      });

      const source: PlaylistSource = {
        id,
        name: playlistName.trim() || 'Local Media Library',
        type: 'local',
        isDefault,
        createdAt: editingPlaylist?.createdAt || now,
        updatedAt: now,
        channelCount: 0,
        movieCount: movies.length,
        seriesCount: 0,
      };

      const catalog: PlaylistCatalog = {
        playlistId: id,
        channels: [],
        movies,
        series: [],
        epgPrograms: {},
      };

      await onPlaylistSaved(source, catalog);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import local media.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-[#12141B] border border-white/10 rounded-2xl shadow-2xl overflow-hidden my-auto"
      >
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">
              {editingPlaylist ? t('playlistModal.titleEdit') : t('playlistModal.titleAdd')}
            </h2>
            <p className="text-xs text-[#9CA3B2] mt-1">
              {isTr
                ? 'Xtream Codes, M3U/M3U8 veya yerel medya kaynaklarını otomatik oynatma uyumluluğuyla bağlayın.'
                : 'Connect Xtream Codes, M3U/M3U8, or local media with automatic stream compatibility.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-lg hover:bg-white/10 text-[#9CA3B2] hover:text-white flex items-center justify-center transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Connection Type Segmented Selector */}
        <div className="px-6 pt-5">
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#08090D] rounded-xl border border-white/[0.06]">
            <button
              type="button"
              onClick={() => {
                setTab('xtream');
                setError(null);
              }}
              className={`py-2.5 px-3 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                tab === 'xtream'
                  ? 'bg-[#E50914] text-white'
                  : 'text-[#9CA3B2] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <Server className="w-4 h-4 shrink-0" />
              {t('onboarding.tabXtream')}
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('m3u');
                setError(null);
              }}
              className={`py-2.5 px-3 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                tab === 'm3u'
                  ? 'bg-[#E50914] text-white'
                  : 'text-[#9CA3B2] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <Link2 className="w-4 h-4 shrink-0" />
              M3U / M3U8
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('local');
                setError(null);
              }}
              className={`py-2.5 px-3 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                tab === 'local'
                  ? 'bg-[#E50914] text-white'
                  : 'text-[#9CA3B2] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              {t('playlistModal.tabLocal')}
            </button>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Playlist Name */}
          <div>
            <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
              {t('onboarding.playlistName')}
            </label>
            <input
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              placeholder={
                tab === 'xtream'
                  ? t('onboarding.playlistNamePlaceholder')
                  : tab === 'm3u'
                  ? isTr
                    ? 'Örn. Ana M3U Aboneliğim'
                    : 'e.g. Main M3U Subscription'
                  : isTr
                  ? 'Örn. Yerel Sinema Arşivi'
                  : 'e.g. Local Cinema Files'
              }
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white placeholder:text-[#666E80]"
            />
          </div>

          {/* XTREAM CODES FIELDS */}
          {tab === 'xtream' && (
            <>
              <div>
                <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                  {t('onboarding.serverUrl')}{' '}
                  <span className="text-[#666E80]">
                    {isTr
                      ? '(HTTP/HTTPS ve port dahil — veya tam get.php bağlantısını yapıştırın)'
                      : '(HTTP or HTTPS, port included — or paste full get.php URL)'}
                  </span>
                </label>
                <div className="relative">
                  <Globe className="w-4 h-4 text-[#666E80] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => handleServerUrlChange(e.target.value)}
                    placeholder={t('onboarding.serverPlaceholder')}
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono placeholder:text-[#666E80]"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('onboarding.username')}
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('onboarding.usernamePlaceholder')}
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white placeholder:text-[#666E80]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('onboarding.password')}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('onboarding.passwordPlaceholder')}
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white placeholder:text-[#666E80]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('settings.uaLabel')}
                  </label>
                  <select
                    value={userAgent}
                    onChange={(e) => setUserAgent(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white"
                  >
                    {USER_AGENT_PROFILES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">{isTr ? 'Özel User-Agent...' : 'Custom User-Agent...'}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('onboarding.liveFormat')}
                  </label>
                  <select
                    value={liveFormat}
                    onChange={(e) => setLiveFormat(e.target.value as 'auto' | 'm3u8' | 'ts')}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white"
                  >
                    <option value="auto">{t('onboarding.liveFormatAuto')}</option>
                    <option value="m3u8">{t('onboarding.liveFormatHls')}</option>
                    <option value="ts">{t('onboarding.liveFormatTs')}</option>
                  </select>
                </div>
              </div>

              {userAgent === 'custom' && (
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {isTr ? 'Özel User-Agent Metni' : 'Custom User-Agent String'}
                  </label>
                  <input
                    type="text"
                    value={customUa}
                    onChange={(e) => setCustomUa(e.target.value)}
                    placeholder="IPTVPlayer/2.0"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono"
                  />
                </div>
              )}

              {/* Connection Test Banner */}
              {testResult?.ok && testResult.userInfo && (
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs space-y-1">
                  <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      {t('onboarding.testSuccess', {
                        status: testResult.userInfo.status || t('common.active'),
                        expiry:
                          testResult.userInfo.expDate && Number(testResult.userInfo.expDate) > 0
                            ? t('onboarding.expirySuffix', {
                                date: new Date(Number(testResult.userInfo.expDate) * 1000).toLocaleDateString(
                                  isTr ? 'tr-TR' : 'en-US'
                                ),
                              })
                            : '',
                      })}
                    </span>
                  </div>
                  <p className="text-[#9CA3B2] font-mono tabular-nums">
                    {testResult.resolvedServerUrl} · {t('settings.subConnections')}:{' '}
                    {testResult.userInfo.activeCons || '0'}/{testResult.userInfo.maxConnections || '1'}
                  </p>
                </div>
              )}
            </>
          )}

          {/* M3U / M3U8 FIELDS */}
          {tab === 'm3u' && (
            <>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setM3uMode('url')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    m3uMode === 'url'
                      ? 'bg-white text-black'
                      : 'bg-white/5 text-[#9CA3B2] hover:text-white'
                  }`}
                >
                  {t('onboarding.tabM3uUrl')}
                </button>
                <button
                  type="button"
                  onClick={() => setM3uMode('file')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    m3uMode === 'file'
                      ? 'bg-white text-black'
                      : 'bg-white/5 text-[#9CA3B2] hover:text-white'
                  }`}
                >
                  {t('onboarding.tabM3uFile')}
                </button>
              </div>

              {m3uMode === 'url' ? (
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('onboarding.m3uUrlLabel')}
                  </label>
                  <input
                    type="text"
                    value={m3uUrl}
                    onChange={(e) => setM3uUrl(e.target.value)}
                    placeholder={t('onboarding.m3uUrlPlaceholder')}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono placeholder:text-[#666E80]"
                    required
                  />
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center border border-dashed border-white/20 hover:border-[#E50914] rounded-xl p-6 bg-[#08090D] cursor-pointer transition-colors">
                  <Upload className="w-7 h-7 text-[#9CA3B2] mb-2" />
                  <span className="text-sm font-medium text-white">
                    {m3uFileName || t('onboarding.m3uFilePick')}
                  </span>
                  <span className="text-xs text-[#666E80] mt-1">
                    {isTr
                      ? 'Canlı TV, Film ve Dizi içeren 80 MB’a kadar .m3u / .m3u8 listeleri desteklenir'
                      : 'Supports full IPTV playlists up to 80MB with Live TV, Movies & Series'}
                  </span>
                  <input
                    type="file"
                    accept=".m3u,.m3u8,.txt"
                    onChange={handleM3uFileSelect}
                    className="hidden"
                  />
                </label>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('onboarding.epgOptional')}
                  </label>
                  <input
                    type="text"
                    value={epgUrl}
                    onChange={(e) => setEpgUrl(e.target.value)}
                    placeholder={
                      isTr ? 'Listede varsa otomatik algılanır' : 'Auto-detected from playlist if available'
                    }
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono placeholder:text-[#666E80]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('settings.uaLabel')}
                  </label>
                  <select
                    value={userAgent}
                    onChange={(e) => setUserAgent(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white"
                  >
                    {USER_AGENT_PROFILES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {/* LOCAL MEDIA FIELDS */}
          {tab === 'local' && (
            <div className="space-y-3">
              <label className="flex flex-col items-center justify-center border border-dashed border-white/20 hover:border-[#E50914] rounded-xl p-6 bg-[#08090D] cursor-pointer transition-colors">
                <Film className="w-7 h-7 text-[#9CA3B2] mb-2" />
                <span className="text-sm font-medium text-white">
                  {t('playlistModal.localTitle')}
                </span>
                <span className="text-xs text-[#666E80] mt-1">
                  {t('playlistModal.localDesc')}
                </span>
                <input
                  type="file"
                  multiple
                  accept="video/*,audio/*,.mkv,.m3u8"
                  onChange={handleLocalFilesSelect}
                  className="hidden"
                />
              </label>

              {localFiles.length > 0 && (
                <div className="max-h-36 overflow-y-auto bg-[#08090D] border border-white/[0.08] rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-[#9CA3B2] pb-1 border-b border-white/[0.06]">
                    <span>
                      {isTr ? `${localFiles.length} dosya seçildi` : `${localFiles.length} file(s) selected`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setLocalFiles([])}
                      className="text-[#E50914] hover:underline"
                    >
                      {t('nav.clearAll')}
                    </button>
                  </div>
                  {localFiles.map((f, i) => (
                    <div key={`${f.name}_${i}`} className="flex items-center justify-between text-xs text-white/90">
                      <span className="truncate pr-2">{f.name}</span>
                      <span className="text-[#666E80] font-mono tabular-nums shrink-0">
                        {(f.size / (1024 * 1024)).toFixed(1)} MB
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Default Playlist Checkbox */}
          <label className="flex items-center gap-2.5 text-xs text-[#9CA3B2] pt-1 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded accent-[#E50914] w-4 h-4"
            />
            {isTr ? 'Açılışta varsayılan aktif kaynak olarak ayarla' : 'Set as active default source on startup'}
          </label>

          {/* Error Feedback */}
          {error && (
            <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 text-xs text-red-200 space-y-1.5">
              <div className="flex items-start gap-2 font-semibold text-white">
                <AlertCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              {testResult?.diagnostics && testResult.diagnostics.length > 0 && (
                <div className="pl-6 text-[11px] font-mono text-red-200/75 space-y-0.5">
                  {testResult.diagnostics.map((d, idx) => (
                    <div key={idx}>{d}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sync Progress */}
          {submitting && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/90 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#E50914]" />
                  {progressStage || t('playlistModal.syncProgress')}
                </span>
                <span className="font-mono tabular-nums text-[#9CA3B2]">{progressPct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-[#E50914] transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-3 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-[#666E80]">
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>
                {isTr ? 'Bilgileriniz yalnızca bu cihazda saklanır' : 'Credentials stay local on your device'}
              </span>
            </div>

            <div className="flex items-center gap-2.5 ml-auto">
              {tab === 'xtream' && (
                <button
                  type="button"
                  disabled={testing || submitting}
                  onClick={handleTestXtream}
                  className="px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
                >
                  {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {testing ? t('onboarding.testing') : t('onboarding.testConnection')}
                </button>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-50 text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingPlaylist
                  ? t('playlistModal.saveAndSync')
                  : tab === 'local'
                  ? isTr
                    ? 'Medyayı İçe Aktar'
                    : 'Import Media'
                  : t('playlistModal.saveAndSync')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
