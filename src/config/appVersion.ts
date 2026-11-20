export const APP_VERSION = '1.0.0';
export const APP_VERSION_CODE = 10000;
export const ANDROID_APPLICATION_ID = 'com.ipflix.app';
export const WINDOWS_APP_ID = 'com.ipflix.desktop';

export const GITHUB_OWNER = 'ipflixx';
export const GITHUB_REPO = 'ipflix';
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

export type DistributionChannel =
  | 'windows_electron'
  | 'android_apk'
  | 'google_play'
  | 'android_tv_apk'
  | 'android_tv_play'
  | 'web';

export function isPlayStoreChannel(channel: DistributionChannel): boolean {
  return channel === 'google_play' || channel === 'android_tv_play';
}

export function isAndroidChannel(channel: DistributionChannel): boolean {
  return (
    channel === 'android_apk' ||
    channel === 'google_play' ||
    channel === 'android_tv_apk' ||
    channel === 'android_tv_play'
  );
}

export function normalizeSemver(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '0.0.0';
  const cleaned = raw.trim().replace(/^v/i, '').split('+')[0];
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return '0.0.0';
  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  const patch = Number(match[3] || 0);
  const pre = match[4] ? `-${match[4]}` : '';
  return `${major}.${minor}.${patch}${pre}`;
}

/**
 * Compares two SemVer strings. Returns:
 *   1 if `a > b`
 *   0 if `a === b`
 *  -1 if `a < b`
 */
export function compareSemver(aRaw: string, bRaw: string): -1 | 0 | 1 {
  const a = normalizeSemver(aRaw);
  const b = normalizeSemver(bRaw);
  const [aCore, aPre] = a.split('-');
  const [bCore, bPre] = b.split('-');

  const aParts = aCore.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = bCore.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const av = aParts[i] || 0;
    const bv = bParts[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (aPre && bPre) {
    if (aPre > bPre) return 1;
    if (aPre < bPre) return -1;
  }
  return 0;
}

export function detectDistributionChannel(explicitOverride?: DistributionChannel): DistributionChannel {
  if (explicitOverride) return explicitOverride;

  if (typeof window !== 'undefined') {
    if (window.ipflixDesktop?.isDesktop) {
      return 'windows_electron';
    }

    const nativeChannel = window.ipflixAndroid?.getDistributionChannel?.();
    if (
      nativeChannel === 'google_play' ||
      nativeChannel === 'android_apk' ||
      nativeChannel === 'android_tv_apk' ||
      nativeChannel === 'android_tv_play'
    ) {
      return nativeChannel;
    }

    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isTv =
      /Android TV|GoogleTV|SMART-TV|BRAVIA|AFT|Shield Android TV|MiBox|MIBOX/i.test(ua);

    if (isAndroid && isTv) return 'android_tv_apk';
    if (isAndroid) return 'android_apk';
  }

  return 'web';
}
