import {
  APP_VERSION,
  APP_VERSION_CODE,
  detectDistributionChannel,
  isPlayStoreChannel,
  type DistributionChannel,
} from '../config/appVersion';
import type {
  UpdateCheckResult,
  UpdateDownloadProgressEvent,
} from '../types/iptv';
import { getAndroidBridge, parseBridgeJson, resolveApiUrl } from './androidBridge';
import { isAllowedGitHubUrl, isValidSha256Hex } from './releaseParser';

export function resolveActiveAppVersion(): string {
  const androidVer = getAndroidBridge()?.getVersionName?.();
  if (androidVer && androidVer.trim()) return androidVer.trim();
  return APP_VERSION;
}

export function resolveActiveVersionCode(): number {
  const androidCode = getAndroidBridge()?.getVersionCode?.();
  if (typeof androidCode === 'number' && androidCode > 0) return androidCode;
  return APP_VERSION_CODE;
}

export async function checkForPlatformUpdates(params?: {
  force?: boolean;
  channelOverride?: DistributionChannel;
}): Promise<UpdateCheckResult> {
  const force = Boolean(params?.force);
  const channel = detectDistributionChannel(params?.channelOverride);
  const currentVersion = resolveActiveAppVersion();
  const currentVersionCode = resolveActiveVersionCode();

  // 1. Windows Desktop (Electron IPC + SQLite update cache + DPAPI safe runtime)
  if (channel === 'windows_electron' && window.ipflixDesktop?.updates) {
    try {
      const res = (await window.ipflixDesktop.updates.check(force)) as UpdateCheckResult;
      return res;
    } catch (err) {
      return {
        status: 'error',
        channel,
        currentVersion,
        currentVersionCode,
        checkedAt: Date.now(),
        cached: false,
        updateAvailable: false,
        isExternalApkAllowed: true,
        error: err instanceof Error ? err.message : 'Güncelleme kontrolü başarısız oldu.',
      };
    }
  }

  // 2. Google Play Store / Android TV Play flavor -> STRICTLY Play Core In-App Updates (NEVER external APK)
  if (isPlayStoreChannel(channel)) {
    const androidBridge = getAndroidBridge();
    if (androidBridge?.checkPlayStoreUpdate) {
      try {
        const playRes = parseBridgeJson(await androidBridge.checkPlayStoreUpdate());
        return {
          status: playRes.available ? 'update_available' : 'play_store_managed',
          channel,
          currentVersion,
          currentVersionCode,
          checkedAt: Date.now(),
          cached: false,
          updateAvailable: Boolean(playRes.available),
          isExternalApkAllowed: false,
          playUpdateImmediateRequired: Boolean(
            playRes.isImmediateAllowed && !playRes.isFlexibleAllowed
          ),
          playUpdateFlexibleReady: Boolean(playRes.downloadedReadyToInstall),
          message: playRes.available
            ? 'Google Play Store üzerinden yeni bir güncelleme mevcut.'
            : 'Google Play Store üzerinden güncel sürümü kullanıyorsunuz.',
        };
      } catch (err) {
        return {
          status: 'error',
          channel,
          currentVersion,
          currentVersionCode,
          checkedAt: Date.now(),
          cached: false,
          updateAvailable: false,
          isExternalApkAllowed: false,
          error:
            err instanceof Error
              ? err.message
              : 'Google Play Store güncelleme kontrolü başarısız oldu.',
        };
      }
    }

    return {
      status: 'play_store_managed',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt: Date.now(),
      cached: false,
      updateAvailable: false,
      isExternalApkAllowed: false,
      message: 'Google Play Store kanalında güncellemeler Play Store / AppUpdateManager tarafından yönetilir.',
    };
  }

  // 3. Android APK / Android TV APK / Web browser -> Query IPFLIX Express /api/updates/check
  const qs = new URLSearchParams({
    channel,
    currentVersion,
    ...(force ? { force: '1' } : {}),
  });

  const resp = await fetch(resolveApiUrl(`/api/updates/check?${qs.toString()}`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const payload = (await resp.json()) as UpdateCheckResult;
  if (!resp.ok && payload.status !== 'error') {
    return {
      status: 'error',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt: Date.now(),
      cached: false,
      updateAvailable: false,
      isExternalApkAllowed: !isPlayStoreChannel(channel),
      error: payload.error || `Güncelleme sunucusu hatası (HTTP ${resp.status}).`,
    };
  }
  return payload;
}

export async function downloadAndInstallPlatformUpdate(params: {
  result: UpdateCheckResult;
  onProgress: (evt: UpdateDownloadProgressEvent) => void;
}): Promise<{ ok: boolean; requiresInstallPermission?: boolean; manualDownloadCompleted?: boolean; error?: string }> {
  const { result, onProgress } = params;
  const { channel, latest } = result;

  // Enforce strict Google Play channel rule: NEVER sideload external APK!
  if (isPlayStoreChannel(channel)) {
    const bridge = getAndroidBridge();
    if (!bridge?.startPlayStoreUpdate) {
      return {
        ok: false,
        error: 'Google Play In-App Updates bu sürümde Play Store uygulaması üzerinden çalışır.',
      };
    }
    const mode = latest?.mandatoryUpdate || result.playUpdateImmediateRequired ? 'immediate' : 'flexible';
    const playRes = parseBridgeJson(await bridge.startPlayStoreUpdate(mode));
    return playRes;
  }

  if (!latest?.downloadUrl || !latest.assetName) {
    return { ok: false, error: 'Bu platform için indirilebilir kurulum dosyası henüz yayınlanmamış.' };
  }

  if (!isAllowedGitHubUrl(latest.downloadUrl)) {
    return { ok: false, error: 'İndirme bağlantısı güvenilir GitHub sunucularına ait değil.' };
  }

  if (!isValidSha256Hex(latest.sha256)) {
    return {
      ok: false,
      error:
        'Güvenlik doğrulaması için SHA-256 özeti eksik. Doğrulanmamış kurulum paketi indirilmedi.',
    };
  }

  // Windows Electron Native Download + SHA-256 + NSIS Installer Launch
  if (channel === 'windows_electron' && window.ipflixDesktop?.updates) {
    const unsub = window.ipflixDesktop.updates.onProgress((raw) => {
      onProgress(raw as UpdateDownloadProgressEvent);
    });
    try {
      const dlRes = await window.ipflixDesktop.updates.downloadAndVerify({
        downloadUrl: latest.downloadUrl,
        expectedSha256: latest.sha256,
        assetName: latest.assetName,
      });
      if (!dlRes.ok || !dlRes.filePath) {
        return { ok: false, error: dlRes.error || 'Kurulum paketi doğrulanamadı.' };
      }
      const installRes = await window.ipflixDesktop.updates.install(dlRes.filePath);
      if (!installRes.ok) {
        return { ok: false, error: installRes.error || 'Kurulum başlatılamadı.' };
      }
      return { ok: true };
    } finally {
      unsub();
    }
  }

  // Android Native WebView/Capacitor APK Installer Bridge
  const androidBridge = getAndroidBridge();
  if (
    (channel === 'android_apk' || channel === 'android_tv_apk') &&
    androidBridge?.downloadAndInstallApk
  ) {
    if (androidBridge.canRequestPackageInstalls) {
      const permitted = await androidBridge.canRequestPackageInstalls();
      if (!permitted) {
        return {
          ok: false,
          requiresInstallPermission: true,
          error:
            'APK yükleyebilmek için Android "Bilinmeyen uygulamaları yükle" (REQUEST_INSTALL_PACKAGES) iznine ihtiyaç vardır.',
        };
      }
    }
    onProgress({
      stage: 'downloading',
      percent: 15,
      receivedBytes: 0,
      totalBytes: latest.assetSizeBytes || 0,
    });
    const nativeRes = parseBridgeJson(
      await androidBridge.downloadAndInstallApk(
        latest.downloadUrl,
        latest.sha256,
        latest.assetName
      )
    );
    if (nativeRes.ok) {
      onProgress({
        stage: 'verified',
        percent: 100,
        receivedBytes: latest.assetSizeBytes || 0,
        totalBytes: latest.assetSizeBytes || 0,
        sha256: nativeRes.sha256 || latest.sha256,
      });
    }
    return nativeRes;
  }

  // Android Phone / TV Browser (PWA/LAN) Verified APK Download via /api/updates/download
  onProgress({
    stage: 'downloading',
    percent: 25,
    receivedBytes: 0,
    totalBytes: latest.assetSizeBytes || 0,
  });

  const qs = new URLSearchParams({
    channel,
    url: latest.downloadUrl,
    sha256: latest.sha256,
    name: latest.assetName,
  });

  const resp = await fetch(resolveApiUrl(`/api/updates/download?${qs.toString()}`));
  if (!resp.ok) {
    let errText = `İndirme başarısız (HTTP ${resp.status}).`;
    try {
      const errBody = (await resp.json()) as { error?: string };
      if (errBody.error) errText = errBody.error;
    } catch {
      // ignore non-json body
    }
    onProgress({ stage: 'error', percent: 0, receivedBytes: 0, totalBytes: 0, error: errText });
    return { ok: false, error: errText };
  }

  onProgress({
    stage: 'verifying_sha256',
    percent: 90,
    receivedBytes: latest.assetSizeBytes || 0,
    totalBytes: latest.assetSizeBytes || 0,
  });

  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = latest.assetName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

  onProgress({
    stage: 'verified',
    percent: 100,
    receivedBytes: blob.size,
    totalBytes: blob.size,
    sha256: latest.sha256,
  });

  return { ok: true, manualDownloadCompleted: true };
}
