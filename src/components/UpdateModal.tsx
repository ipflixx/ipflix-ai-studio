import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  UpdateCheckResult,
  UpdateDownloadProgressEvent,
} from '../types/iptv';
import { useI18n } from '../i18n/I18nContext';
import { getAndroidBridge } from '../services/androidBridge';
import { flushPendingSaves, flushPendingSavesSync } from '../services/storage';
import { downloadAndInstallPlatformUpdate } from '../services/updater';
import type { DistributionChannel } from '../config/appVersion';

interface UpdateModalProps {
  isOpen: boolean;
  result: UpdateCheckResult | null;
  onRemindLater: (version?: string) => void;
  onClose: () => void;
}

function formatBytesToMb(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function getChannelDisplayKey(channel: DistributionChannel) {
  switch (channel) {
    case 'windows_electron':
      return 'update.channelWindows' as const;
    case 'android_apk':
      return 'update.channelAndroidApk' as const;
    case 'google_play':
      return 'update.channelGooglePlay' as const;
    case 'android_tv_apk':
      return 'update.channelAndroidTvApk' as const;
    case 'android_tv_play':
      return 'update.channelAndroidTvPlay' as const;
    default:
      return 'update.channelWeb' as const;
  }
}

export function UpdateModal({
  isOpen,
  result,
  onRemindLater,
  onClose,
}: UpdateModalProps) {
  const { lang, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UpdateDownloadProgressEvent | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [manualApkReady, setManualApkReady] = useState(false);

  const primaryBtnRef = useRef<HTMLButtonElement | null>(null);
  const permBtnRef = useRef<HTMLButtonElement | null>(null);

  const latest = result?.latest;
  const isMandatory = Boolean(
    latest?.mandatoryUpdate || result?.playUpdateImmediateRequired
  );

  useEffect(() => {
    if (!isOpen) {
      setBusy(false);
      setProgress(null);
      setErrorMsg(null);
      setNeedsPermission(false);
      setManualApkReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      primaryBtnRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (needsPermission) {
      window.setTimeout(() => {
        permBtnRef.current?.focus();
      }, 40);
    }
  }, [needsPermission]);

  if (!isOpen || !result || !result.updateAvailable) {
    return null;
  }

  const formattedReleaseDate = latest?.releaseDate
    ? new Date(latest.releaseDate).toLocaleDateString(
        lang === 'tr' ? 'tr-TR' : 'en-US',
        {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }
      )
    : '—';

  const handleStartUpdate = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    setNeedsPermission(false);
    setManualApkReady(false);
    setProgress({
      stage: 'downloading',
      percent: 5,
      receivedBytes: 0,
      totalBytes: latest?.assetSizeBytes || 0,
    });

    try {
      // Safely flush user DB/vault before launching any updater
      flushPendingSavesSync();
      await flushPendingSaves();

      const res = await downloadAndInstallPlatformUpdate({
        result,
        onProgress: (evt) => {
          setProgress(evt);
        },
      });

      if (!res.ok) {
        if (res.requiresInstallPermission) {
          setNeedsPermission(true);
        }
        setErrorMsg(res.error || 'Güncelleme başlatılamadı.');
        setBusy(false);
        return;
      }

      if (res.manualDownloadCompleted) {
        setManualApkReady(true);
      } else {
        setProgress((prev) => ({
          stage: 'installing',
          percent: 100,
          receivedBytes: prev?.receivedBytes || latest?.assetSizeBytes || 0,
          totalBytes: prev?.totalBytes || latest?.assetSizeBytes || 0,
          sha256: prev?.sha256 || latest?.sha256 || undefined,
        }));
      }
      setBusy(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Güncelleme sırasında beklenmeyen hata oluştu.');
      setBusy(false);
    }
  };

  const handleOpenPermissionSettings = async () => {
    const bridge = getAndroidBridge();
    if (bridge?.openInstallPermissionSettings) {
      await bridge.openInstallPermissionSettings();
    }
  };

  return (
    <div
      data-focus-scope="active"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ipflix-update-modal-title"
      className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
      onClick={() => {
        if (!isMandatory && !busy) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-[#12141B] border border-white/12 shadow-2xl shadow-black/90 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Bar */}
        <div className="px-6 py-5 border-b border-white/[0.08] flex items-start justify-between gap-4 bg-[#0B0C11]">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[#E50914]/15 border border-[#E50914]/35 flex items-center justify-center shrink-0">
              <Download className="w-5 h-5 text-[#E50914]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2
                  id="ipflix-update-modal-title"
                  className="font-display text-lg sm:text-xl font-bold text-white"
                >
                  {t('update.modalTitle')}
                </h2>
                {isMandatory && (
                  <span className="px-2 py-0.5 rounded bg-[#E50914] text-white text-[11px] font-bold uppercase tracking-wider">
                    {t('update.mandatoryBadge')}
                  </span>
                )}
              </div>
              <p className="text-xs text-[#9CA3B2] mt-1">
                {t(getChannelDisplayKey(result.channel))}
              </p>
            </div>
          </div>

          {!isMandatory && !busy && (
            <button
              type="button"
              data-focusable="true"
              onClick={onClose}
              aria-label={t('common.close')}
              className="w-11 h-11 rounded-lg text-[#9CA3B2] hover:text-white hover:bg-white/[0.07] flex items-center justify-center shrink-0 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Version Grid */}
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl bg-[#08090D] border border-white/[0.07] p-4">
            <div>
              <p className="text-[11px] text-[#7F8799]">{t('update.currentVersion')}</p>
              <p className="text-sm font-semibold text-white font-mono mt-0.5 tabular-nums">
                v{result.currentVersion}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-[#7F8799]">{t('update.newVersion')}</p>
              <p className="text-sm font-bold text-emerald-400 font-mono mt-0.5 tabular-nums">
                v{latest?.version || '—'}
              </p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-[11px] text-[#7F8799]">{t('update.releaseDate')}</p>
              <p className="text-sm font-medium text-[#D6DCE8] mt-0.5 tabular-nums">
                {formattedReleaseDate}
                {latest?.assetSizeBytes ? ` · ${formatBytesToMb(latest.assetSizeBytes)}` : ''}
              </p>
            </div>
          </div>

          {/* Changelog */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9CA3B2]">
              {t('update.changelogTitle')}
            </h3>
            <div className="max-h-44 overflow-y-auto rounded-xl bg-[#08090D] border border-white/[0.07] p-4 text-xs sm:text-sm text-[#D6DCE8] leading-relaxed whitespace-pre-line">
              {latest?.changelog || t('update.noChangelog')}
            </div>
          </div>

          {/* Progress & SHA-256 Verification Indicator */}
          {progress && (
            <div className="rounded-xl bg-[#08090D] border border-white/[0.08] p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-white flex items-center gap-2">
                  {progress.stage === 'verified' || progress.stage === 'installing' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : progress.stage === 'error' ? (
                    <AlertTriangle className="w-4 h-4 text-[#E50914] shrink-0" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-[#E50914] animate-spin shrink-0" />
                  )}
                  <span>
                    {progress.stage === 'verifying_sha256'
                      ? t('update.verifyingSha256')
                      : progress.stage === 'verified'
                      ? t('update.sha256Verified')
                      : progress.stage === 'installing'
                      ? t('update.installing')
                      : t('update.downloading', { percent: Math.round(progress.percent) })}
                  </span>
                </span>
                <span className="font-mono text-[#9CA3B2] tabular-nums">
                  {Math.round(progress.percent)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full bg-[#E50914] transition-all duration-200"
                  style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
                />
              </div>
              {(progress.sha256 || latest?.sha256) && (
                <p className="text-[11px] font-mono text-[#7F8799] truncate">
                  SHA-256: {(progress.sha256 || latest?.sha256 || '').slice(0, 24)}...
                </p>
              )}
            </div>
          )}

          {/* Manual Download Ready Banner (Mobile/LAN Browser APK) */}
          {manualApkReady && (
            <div className="p-3.5 rounded-xl bg-emerald-500/12 border border-emerald-500/35 text-xs text-emerald-200 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{t('update.downloadCompletedManual')}</span>
            </div>
          )}

          {/* Android REQUEST_INSTALL_PACKAGES Permission Flow */}
          {needsPermission && (
            <div className="p-4 rounded-xl bg-amber-500/12 border border-amber-500/35 space-y-3">
              <div className="flex items-start gap-2.5 text-xs text-amber-100">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-white">{t('update.androidPermissionTitle')}</p>
                  <p>{t('update.androidPermissionDesc')}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-6">
                <button
                  ref={permBtnRef}
                  type="button"
                  data-focusable="true"
                  onClick={() => void handleOpenPermissionSettings()}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold inline-flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>{t('update.openPermissionSettingsBtn')}</span>
                </button>
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => void handleStartUpdate()}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>{t('player.retry')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMsg && !needsPermission && (
            <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 text-xs text-red-200 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Data Safety Guarantee */}
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{t('update.dataSafetyNote')}</span>
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex flex-wrap items-center justify-end gap-3">
            {!isMandatory && (
              <button
                type="button"
                data-focusable="true"
                disabled={busy}
                onClick={() => onRemindLater(latest?.version)}
                className="min-h-[44px] px-5 py-2.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] disabled:opacity-45 text-sm font-semibold text-white transition-colors"
              >
                {t('update.remindLaterBtn')}
              </button>
            )}

            <button
              ref={primaryBtnRef}
              type="button"
              data-focusable="true"
              disabled={busy}
              onClick={() => void handleStartUpdate()}
              className="min-h-[44px] px-6 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] disabled:opacity-55 text-sm font-bold text-white inline-flex items-center justify-center gap-2 transition-colors"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span>{t('update.updateNowBtn')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
