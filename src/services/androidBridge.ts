export type AndroidBridgeChannel =
  | 'android_apk'
  | 'google_play'
  | 'android_tv_apk'
  | 'android_tv_play';

export interface PlayStoreUpdateCheckResponse {
  available: boolean;
  updateAvailability?: number;
  availableVersionCode?: number;
  isImmediateAllowed?: boolean;
  isFlexibleAllowed?: boolean;
  installStatus?: number;
  downloadedReadyToInstall?: boolean;
  clientVersionStalenessDays?: number;
}

export interface AndroidApkInstallResult {
  ok: boolean;
  requiresInstallPermission?: boolean;
  sha256?: string;
  error?: string;
}

/**
 * Native JavaScript <-> Kotlin WebView/Capacitor bridge (`window.ipflixAndroid`).
 * Implemented natively inside `android-integration/IPFlixNativeBridge.kt` when compiled
 * as an Android APK, Android TV APK, or Google Play Store AAB.
 */
export interface IpflixAndroidBridge {
  getDistributionChannel?: () => AndroidBridgeChannel;
  getVersionName?: () => string;
  getVersionCode?: () => number;
  /** Optional local loopback proxy URL when running standalone inside Android WebView APK */
  getLocalApiBaseUrl?: () => string;

  // Android APK / Android TV APK (GitHub Releases sideload channel ONLY)
  canRequestPackageInstalls?: () => Promise<boolean> | boolean;
  openInstallPermissionSettings?: () => Promise<void> | void;
  downloadAndInstallApk?: (
    downloadUrl: string,
    expectedSha256: string,
    fileName: string
  ) => Promise<AndroidApkInstallResult | string> | AndroidApkInstallResult | string;

  // Google Play Store / Android TV Play Store (AppUpdateManager channel ONLY)
  checkPlayStoreUpdate?: () =>
    | Promise<PlayStoreUpdateCheckResponse | string>
    | PlayStoreUpdateCheckResponse
    | string;
  startPlayStoreUpdate?: (
    mode: 'flexible' | 'immediate'
  ) => Promise<{ ok: boolean; error?: string } | string> | { ok: boolean; error?: string } | string;
  completePlayStoreFlexibleUpdate?: () =>
    | Promise<{ ok: boolean; error?: string } | string>
    | { ok: boolean; error?: string }
    | string;
}

export function getAndroidBridge(): IpflixAndroidBridge | null {
  if (typeof window === 'undefined') return null;
  return window.ipflixAndroid || null;
}

/**
 * Resolves `/api/...` paths transparently across all runtimes:
 * - Web / LAN browser / Windows Electron: keeps relative `/api/...` (or current origin) unchanged.
 * - Standalone Android / Android TV APK: routes `/api/...` to the app's loopback 127.0.0.1 proxy
 *   while preserving the immutable `https://appassets.androidplatform.net` WebView origin so IndexedDB survives restarts/updates.
 */
export function resolveApiUrl(path: string): string {
  if (!path || /^https?:\/\//i.test(path)) return path;
  const bridge = getAndroidBridge();
  const base = bridge?.getLocalApiBaseUrl?.();
  if (base && path.startsWith('/api/')) {
    return `${base.replace(/\/+$/, '')}${path}`;
  }
  return path;
}

export function parseBridgeJson<T>(raw: T | string): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw;
}

export async function canAndroidInstallPackages(): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (!bridge?.canRequestPackageInstalls) return false;
  try {
    return Boolean(await bridge.canRequestPackageInstalls());
  } catch {
    return false;
  }
}

export async function openAndroidInstallPermissionSettings(): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (!bridge?.openInstallPermissionSettings) return false;
  try {
    await bridge.openInstallPermissionSettings();
    return true;
  } catch {
    return false;
  }
}
