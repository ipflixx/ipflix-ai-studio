import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Film,
  Globe,
  Link2,
  Loader2,
  Lock,
  Server,
  ShieldCheck,
  Tv,
  Upload,
  Users,
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
import { ASSETS } from '../data/openSourceCatalog';
import { BrandMark } from './BrandMark';

interface OnboardingViewProps {
  savedSourceName?: string;
  existingPlaylists?: PlaylistSource[];
  onContinueExisting?: () => void;
  onCompleteWithSource: (source: PlaylistSource, catalog: PlaylistCatalog) => Promise<void>;
  onContinueWithDemo: () => void;
}

type SetupTab = 'xtream' | 'm3u_url' | 'm3u_file';

export function OnboardingView({
  savedSourceName,
  existingPlaylists = [],
  onContinueExisting,
  onCompleteWithSource,
  onContinueWithDemo,
}: OnboardingViewProps) {
  const { lang, setLang, t } = useI18n();

  const [tab, setTab] = useState<SetupTab>('xtream');
  const [playlistName, setPlaylistName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [liveFormat, setLiveFormat] = useState<'auto' | 'm3u8' | 'ts'>('auto');
  const [userAgent, setUserAgent] = useState(USER_AGENT_PROFILES[0].value);
  const [epgUrl, setEpgUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [m3uUrl, setM3uUrl] = useState('');
  const [m3uFileText, setM3uFileText] = useState('');
  const [m3uFileName, setM3uFileName] = useState('');
  const [m3uFileSizeKb, setM3uFileSizeKb] = useState(0);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<XtreamAuthResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progressStage, setProgressStage] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    const extracted = extractCredentialsFromUrl(val);
    if (extracted.u && !username) setUsername(extracted.u);
    if (extracted.p && !password) setPassword(extracted.p);
  };

  const handleM3uFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setM3uFileName(file.name);
    setM3uFileSizeKb(Math.max(1, Math.round(file.size / 1024)));
    if (!playlistName) {
      setPlaylistName(file.name.replace(/\.(m3u8?|txt)$/i, ''));
    }
    const text = await file.text();
    setM3uFileText(text);
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
        userAgent,
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
      setProgressStage(t('onboarding.syncing'));
      setProgressPct(12);

      try {
        const auth = await authenticateXtream({
          serverUrl: serverUrl.trim(),
          username: effUser,
          password: effPass,
          userAgent,
        });

        if (!auth.ok || !auth.resolvedServerUrl) {
          setTestResult(auth);
          setError(auth.error || t('onboarding.errConnection'));
          setSubmitting(false);
          return;
        }

        const matchedId =
          findMatchingPlaylistId(existingPlaylists, {
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
        const id = matchedId || `pl_${now}`;
        const existingPl = matchedId
          ? existingPlaylists.find((p) => p.id === matchedId)
          : undefined;

        if (auth.mode === 'm3u_fallback' && auth.m3uUrl) {
          setProgressPct(45);
          const parsed = await fetchAndParseM3U({
            url: auth.m3uUrl,
            playlistId: id,
            userAgent: auth.workingUserAgent || userAgent,
          });
          if (!parsed.ok) {
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
            setProgressPct(82);
            const epgRes = await fetchXmltvEpg(
              resolvedEpgUrl,
              parsed.workingUserAgent || auth.workingUserAgent || userAgent
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
            name: playlistName.trim() || existingPl?.name || `IPTV (${hostname})`,
            type: 'm3u_url',
            isDefault: true,
            createdAt: existingPl?.createdAt || now,
            updatedAt: now,
            m3uUrl: parsed.finalUrl || auth.m3uUrl,
            serverUrl: serverUrl.trim(),
            resolvedServerUrl: auth.resolvedServerUrl,
            username: auth.username || effUser,
            password: effPass,
            accountInfo: auth.userInfo,
            userAgent: parsed.workingUserAgent || auth.workingUserAgent || userAgent,
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

          setProgressPct(100);
          await onCompleteWithSource(source, catalog);
          return;
        }

        const resolvedEpgUrl =
          epgUrl.trim() ||
          `${auth.resolvedServerUrl}/xmltv.php?username=${encodeURIComponent(
            auth.username || effUser
          )}&password=${encodeURIComponent(effPass)}`;

        const hostname = (() => {
          try {
            return new URL(auth.resolvedServerUrl).hostname;
          } catch {
            return 'IPTV';
          }
        })();

        const source: PlaylistSource = {
          id,
          name: playlistName.trim() || existingPl?.name || `IPTV (${hostname})`,
          type: 'xtream',
          isDefault: true,
          createdAt: existingPl?.createdAt || now,
          updatedAt: now,
          serverUrl: serverUrl.trim(),
          resolvedServerUrl: auth.resolvedServerUrl,
          username: auth.username || effUser,
          password: effPass,
          accountInfo: auth.userInfo,
          userAgent: auth.workingUserAgent || userAgent,
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

        setProgressPct(100);
        await onCompleteWithSource(source, catalog);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('onboarding.errConnection'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // M3U URL or M3U File
    if (tab === 'm3u_url' && !m3uUrl.trim()) {
      setError(t('onboarding.errMissingM3uUrl'));
      return;
    }
    if (tab === 'm3u_file' && !m3uFileText.trim()) {
      setError(t('onboarding.errMissingM3uFile'));
      return;
    }

    const matchedM3uId =
      tab === 'm3u_url'
        ? findMatchingPlaylistId(existingPlaylists, {
            type: 'm3u_url',
            m3uUrl: m3uUrl.trim(),
          })
        : null;
    const id = matchedM3uId || `pl_${now}`;
    const existingPl = matchedM3uId
      ? existingPlaylists.find((p) => p.id === matchedM3uId)
      : undefined;

    setSubmitting(true);
    setProgressStage(t('onboarding.syncing'));
    setProgressPct(35);

    try {
      const parsed = await fetchAndParseM3U({
        url: tab === 'm3u_url' ? m3uUrl.trim() : undefined,
        content: tab === 'm3u_file' ? m3uFileText : undefined,
        playlistId: id,
        userAgent,
      });

      if (!parsed.ok) {
        setError(parsed.error || t('onboarding.errConnection'));
        setSubmitting(false);
        return;
      }

      const effectiveEpg = epgUrl.trim() || parsed.detectedEpgUrl || undefined;
      let epgPrograms: PlaylistCatalog['epgPrograms'] = {};

      if (effectiveEpg) {
        setProgressPct(78);
        const epgRes = await fetchXmltvEpg(effectiveEpg, parsed.workingUserAgent || userAgent).catch(
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
          (tab === 'm3u_file' ? m3uFileName || 'M3U Listem' : 'M3U IPTV'),
        type: tab === 'm3u_file' ? 'm3u_file' : 'm3u_url',
        isDefault: true,
        createdAt: existingPl?.createdAt || now,
        updatedAt: now,
        m3uUrl: tab === 'm3u_url' ? parsed.finalUrl || m3uUrl.trim() : undefined,
        epgUrl: effectiveEpg,
        userAgent: parsed.workingUserAgent || userAgent,
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

      setProgressPct(100);
      await onCompleteWithSource(source, catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.errConnection'));
    } finally {
      setSubmitting(false);
    }
  };

  const formattedExpiry =
    testResult?.userInfo?.expDate && Number(testResult.userInfo.expDate) > 0
      ? t('onboarding.expirySuffix', {
          date: new Date(Number(testResult.userInfo.expDate) * 1000).toLocaleDateString(
            lang === 'tr' ? 'tr-TR' : 'en-US'
          ),
        })
      : '';

  return (
    <div className="relative min-h-[100dvh] w-full bg-[#08090D] text-white flex flex-col overflow-x-clip safe-area-top safe-area-bottom">
      {/* Full-bleed cinema backdrop with measured dark scrim */}
      <div className="fixed inset-0 pointer-events-none select-none overflow-hidden">
        <img
          src={ASSETS.heroBackdrop}
          alt=""
          className="w-full h-full object-cover opacity-35 scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#08090D]/85 via-[#08090D]/75 to-[#08090D]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(229,9,20,0.14),transparent_60%)]" />
      </div>

      {/* Top Navigation Header */}
      <header className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 h-16 sm:h-20 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <BrandMark size="md" />
          <span className="hidden md:inline text-[10px] font-semibold tracking-[0.28em] text-white/40 uppercase border-l border-white/10 pl-4">
            {t('app.slogan')}
          </span>
        </div>

        <div className="inline-flex items-center p-1 rounded-lg bg-[#12141B]/90 border border-white/10 shrink-0">
          <button
            type="button"
            onClick={() => setLang('tr')}
            className={`min-h-[36px] px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
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
            className={`min-h-[36px] px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              lang === 'en'
                ? 'bg-[#E50914] text-white'
                : 'text-[#9CA3B2] hover:text-white'
            }`}
          >
            English
          </button>
        </div>
      </header>

      {/* Center Onboarding Card */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-3.5 sm:px-6 py-4 sm:py-10">
        <div className="w-full max-w-[540px] bg-[#12141B]/92 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-black/75 overflow-hidden">
          <div className="p-5 sm:p-8">
            <div className="mb-5 sm:mb-6">
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                {t('onboarding.headline')}
              </h1>
              <p className="text-xs sm:text-sm text-[#9CA3B2] mt-2 leading-relaxed">
                {t('onboarding.subheadline')}
              </p>
            </div>

            {/* Source Type Segmented Tabs (Stack icon+label cleanly on narrow 360px phones) */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#08090D] border border-white/[0.07] mb-5 sm:mb-6">
              <button
                type="button"
                onClick={() => {
                  setTab('xtream');
                  setError(null);
                }}
                className={`min-h-[44px] py-2 px-1.5 sm:px-2.5 rounded-lg text-[11px] sm:text-sm font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 transition-colors text-center leading-tight ${
                  tab === 'xtream'
                    ? 'bg-[#E50914] text-white'
                    : 'text-[#9CA3B2] hover:text-white'
                }`}
              >
                <Server className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-full">{t('onboarding.tabXtream')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('m3u_url');
                  setError(null);
                }}
                className={`min-h-[44px] py-2 px-1.5 sm:px-2.5 rounded-lg text-[11px] sm:text-sm font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 transition-colors text-center leading-tight ${
                  tab === 'm3u_url'
                    ? 'bg-[#E50914] text-white'
                    : 'text-[#9CA3B2] hover:text-white'
                }`}
              >
                <Link2 className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-full">{t('onboarding.tabM3uUrl')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('m3u_file');
                  setError(null);
                }}
                className={`min-h-[44px] py-2 px-1.5 sm:px-2.5 rounded-lg text-[11px] sm:text-sm font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 transition-colors text-center leading-tight ${
                  tab === 'm3u_file'
                    ? 'bg-[#E50914] text-white'
                    : 'text-[#9CA3B2] hover:text-white'
                }`}
              >
                <Upload className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-full">{t('onboarding.tabM3uFile')}</span>
              </button>
            </div>

            {/* Login Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              {tab === 'xtream' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-[#B8BFCC] mb-1.5">
                      {t('onboarding.serverUrl')}
                    </label>
                    <div className="relative">
                      <Globe className="w-4 h-4 text-[#666E80] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={serverUrl}
                        onChange={(e) => handleServerUrlChange(e.target.value)}
                        placeholder={t('onboarding.serverPlaceholder')}
                        autoComplete="off"
                        className="w-full min-h-[46px] pl-10 pr-3.5 py-3 rounded-lg bg-[#08090D] border border-white/12 focus:border-[#E50914] focus:outline-none text-base sm:text-sm text-white font-mono placeholder:text-[#5B6273]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-[#B8BFCC] mb-1.5">
                        {t('onboarding.username')}
                      </label>
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => {
                          setUsername(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder={t('onboarding.usernamePlaceholder')}
                        autoComplete="off"
                        className="w-full min-h-[46px] px-3.5 py-3 rounded-lg bg-[#08090D] border border-white/12 focus:border-[#E50914] focus:outline-none text-base sm:text-sm text-white placeholder:text-[#5B6273]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#B8BFCC] mb-1.5">
                        {t('onboarding.password')}
                      </label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder={t('onboarding.passwordPlaceholder')}
                        autoComplete="off"
                        className="w-full min-h-[46px] px-3.5 py-3 rounded-lg bg-[#08090D] border border-white/12 focus:border-[#E50914] focus:outline-none text-base sm:text-sm text-white placeholder:text-[#5B6273]"
                      />
                    </div>
                  </div>
                </>
              )}

              {tab === 'm3u_url' && (
                <div>
                  <label className="block text-xs font-medium text-[#B8BFCC] mb-1.5">
                    {t('onboarding.m3uUrlLabel')}
                  </label>
                  <input
                    type="text"
                    value={m3uUrl}
                    onChange={(e) => setM3uUrl(e.target.value)}
                    placeholder={t('onboarding.m3uUrlPlaceholder')}
                    autoComplete="off"
                    className="w-full min-h-[46px] px-3.5 py-3 rounded-lg bg-[#08090D] border border-white/12 focus:border-[#E50914] focus:outline-none text-base sm:text-sm text-white font-mono placeholder:text-[#5B6273]"
                  />
                </div>
              )}

              {tab === 'm3u_file' && (
                <div>
                  <label className="block text-xs font-medium text-[#B8BFCC] mb-1.5">
                    {t('onboarding.m3uFileLabel')}
                  </label>
                  <label className="flex flex-col items-center justify-center border border-dashed border-white/20 hover:border-[#E50914] rounded-xl py-7 px-4 bg-[#08090D] cursor-pointer transition-colors text-center">
                    <Upload className="w-6 h-6 text-[#9CA3B2] mb-2" />
                    <span className="text-sm font-medium text-white">
                      {m3uFileName || t('onboarding.m3uFilePick')}
                    </span>
                    {m3uFileSizeKb > 0 && (
                      <span className="text-xs text-emerald-400 mt-1 tabular-nums">
                        {t('onboarding.m3uFileLoaded', { size: m3uFileSizeKb })}
                      </span>
                    )}
                    <input
                      type="file"
                      accept=".m3u,.m3u8,.txt"
                      onChange={handleM3uFileSelect}
                      className="hidden"
                    />
                  </label>
                </div>
              )}

              {/* Collapsible Advanced Options */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#9CA3B2] hover:text-white transition-colors"
                >
                  {showAdvanced ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                  <span>{t('onboarding.advancedOptions')}</span>
                </button>

                {showAdvanced && (
                  <div className="mt-3 pt-3 border-t border-white/[0.07] space-y-3.5">
                    <div>
                      <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                        {t('onboarding.playlistName')}
                      </label>
                      <input
                        type="text"
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        placeholder={t('onboarding.playlistNamePlaceholder')}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white placeholder:text-[#5B6273]"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {tab === 'xtream' && (
                        <div>
                          <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                            {t('onboarding.liveFormat')}
                          </label>
                          <select
                            value={liveFormat}
                            onChange={(e) =>
                              setLiveFormat(e.target.value as 'auto' | 'm3u8' | 'ts')
                            }
                            className="w-full px-3 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white"
                          >
                            <option value="auto">{t('onboarding.liveFormatAuto')}</option>
                            <option value="m3u8">{t('onboarding.liveFormatHls')}</option>
                            <option value="ts">{t('onboarding.liveFormatTs')}</option>
                          </select>
                        </div>
                      )}

                      <div className={tab === 'xtream' ? '' : 'sm:col-span-2'}>
                        <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                          {t('onboarding.epgOptional')}
                        </label>
                        <input
                          type="text"
                          value={epgUrl}
                          onChange={(e) => setEpgUrl(e.target.value)}
                          placeholder={t('onboarding.epgPlaceholder')}
                          className="w-full px-3 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white font-mono placeholder:text-[#5B6273]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                        {t('settings.uaLabel')}
                      </label>
                      <select
                        value={userAgent}
                        onChange={(e) => setUserAgent(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-lg bg-[#08090D] border border-white/10 focus:border-[#E50914] focus:outline-none text-sm text-white"
                      >
                        {USER_AGENT_PROFILES.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {/* Verified Connection Banner */}
              {testResult?.ok && testResult.userInfo && (
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-start gap-2.5 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                  <span>
                    {t('onboarding.testSuccess', {
                      status: testResult.userInfo.status || t('common.active'),
                      expiry: formattedExpiry,
                    })}
                  </span>
                </div>
              )}

              {/* Error Feedback */}
              {error && (
                <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 flex items-start gap-2.5 text-xs text-red-200">
                  <AlertCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Sync Progress Bar */}
              {submitting && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/90 inline-flex items-center gap-2 truncate pr-3">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#E50914] shrink-0" />
                      <span className="truncate">{progressStage || t('onboarding.syncing')}</span>
                    </span>
                    <span className="font-mono tabular-nums text-[#9CA3B2] shrink-0">
                      {progressPct}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-[#E50914] transition-all duration-300"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Primary & Test Actions */}
              <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                {tab === 'xtream' && (
                  <button
                    type="button"
                    disabled={testing || submitting}
                    onClick={handleTestXtream}
                    className="min-h-[46px] sm:w-auto px-4 py-3 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                  >
                    {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                    <span>{testing ? t('onboarding.testing') : t('onboarding.testConnection')}</span>
                  </button>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[48px] flex-1 px-5 py-3 rounded-lg bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-50 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors shadow-lg shadow-[#E50914]/25 whitespace-nowrap"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>
                    {submitting ? t('onboarding.syncing') : t('onboarding.connectAndEnter')}
                  </span>
                </button>
              </div>
            </form>

            {/* Quick Resume Saved IPTV Source (when user signed out from Profile Menu) */}
            {savedSourceName && onContinueExisting && (
              <div className="mt-4">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={onContinueExisting}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs sm:text-sm font-semibold text-white transition-colors truncate"
                >
                  {t('onboarding.continueExisting', { name: savedSourceName })}
                </button>
              </div>
            )}

            {/* Local Privacy & Demo Fallback */}
            <div className="mt-6 pt-5 border-t border-white/[0.08] space-y-3">
              <div className="flex items-start gap-2 text-xs text-[#8D95A5]">
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>{t('onboarding.localPrivacyNote')}</span>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="hidden sm:flex items-center gap-4 text-[11px] text-[#6E7688]">
                  <span className="inline-flex items-center gap-1">
                    <Tv className="w-3.5 h-3.5" />
                    {t('onboarding.featureLive')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Film className="w-3.5 h-3.5" />
                    {t('onboarding.featureVod')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {t('onboarding.featureProfiles')}
                  </span>
                </div>

                <button
                  type="button"
                  disabled={submitting}
                  onClick={onContinueWithDemo}
                  className="text-xs text-[#9CA3B2] hover:text-white underline underline-offset-4 transition-colors ml-auto whitespace-nowrap"
                >
                  {t('onboarding.previewDemo')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Subtle footer lock note */}
      <footer className="relative z-10 pb-6 text-center text-[11px] text-[#5B6273] flex items-center justify-center gap-1.5 px-4">
        <Lock className="w-3 h-3" />
        <span>IPFLIX · {t('app.tagline')}</span>
      </footer>
    </div>
  );
}
