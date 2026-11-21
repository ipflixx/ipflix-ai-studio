import {
  APP_VERSION,
  APP_VERSION_CODE,
  compareSemver,
  GITHUB_RELEASES_PAGE,
  isPlayStoreChannel,
  normalizeSemver,
  type DistributionChannel,
} from '../config/appVersion';
import type { PlatformUpdateMetadata, UpdateCheckResult } from '../types/iptv';

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  content_type?: string;
}

export interface GitHubReleaseRecord {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  created_at?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
}

export interface ParsedReleaseManifest {
  version?: string;
  versionCode?: number;
  releaseDate?: string;
  changelog?: string;
  minimumSupportedVersion?: string;
  mandatoryUpdate?: boolean;
  sha256?: string;
  windowsSha256?: string;
  androidApkSha256?: string;
  androidTvApkSha256?: string;
  checksums?: Record<string, string>;
}

const ALLOWED_GITHUB_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

export function isAllowedGitHubUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (ALLOWED_GITHUB_DOWNLOAD_HOSTS.has(host)) return true;
    return host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

export function isValidSha256Hex(raw?: string | null): raw is string {
  return typeof raw === 'string' && /^[a-f0-9]{64}$/i.test(raw.trim());
}

function normalizeSha256(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  return isValidSha256Hex(cleaned) ? cleaned : null;
}

export function parseChecksumTextForAsset(text: string, assetName: string): string | null {
  if (!text || !assetName) return null;
  const target = assetName.trim().toLowerCase();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Matches standard `sha256sum`: `<64hex>  IPFlix-Windows-Setup.exe` or `<64hex> *IPFlix-Android.apk`
    const stdMatch = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (stdMatch) {
      const hash = stdMatch[1].toLowerCase();
      const filePart = stdMatch[2].trim().replace(/^\.\//, '').toLowerCase();
      if (filePart === target || filePart.endsWith(`/${target}`)) {
        return hash;
      }
    }
    // Matches `IPFlix-Windows-Setup.exe: <64hex>`
    const namedMatch = trimmed.match(/^(.+?)\s*[:=]\s*([a-f0-9]{64})$/i);
    if (namedMatch) {
      const filePart = namedMatch[1].trim().toLowerCase();
      if (filePart === target || filePart.endsWith(`/${target}`)) {
        return namedMatch[2].toLowerCase();
      }
    }
  }

  // Dedicated single-file `<asset>.sha256` often contains only the 64-char hash on line 1
  if (lines.length <= 2) {
    const solo = trimmedSingleHash(text);
    if (solo) return solo;
  }
  return null;
}

function trimmedSingleHash(text: string): string | null {
  const m = text.trim().match(/^([a-f0-9]{64})(?:\s+\S+)?$/i);
  return m ? m[1].toLowerCase() : null;
}

export function parseManifestFromReleaseBody(body = ''): ParsedReleaseManifest {
  const out: ParsedReleaseManifest = {};
  if (!body) return out;

  const commentMatch = body.match(/<!--\s*ipflix-meta\s*:\s*(\{[\s\S]*?\})\s*-->/i);
  if (commentMatch) {
    try {
      const parsed = JSON.parse(commentMatch[1]) as ParsedReleaseManifest;
      Object.assign(out, parsed);
    } catch {
      // ignore malformed comment JSON and fall back to key-value lines
    }
  }

  const verCodeMatch = body.match(/versionCode\s*[:=]\s*(\d+)/i);
  if (verCodeMatch && out.versionCode === undefined) {
    out.versionCode = Number(verCodeMatch[1]);
  }

  const minVerMatch = body.match(/minimumSupportedVersion\s*[:=]\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
  if (minVerMatch && !out.minimumSupportedVersion) {
    out.minimumSupportedVersion = minVerMatch[1];
  }

  const mandatoryMatch = body.match(/mandatoryUpdate\s*[:=]\s*(true|false)/i);
  if (mandatoryMatch && out.mandatoryUpdate === undefined) {
    out.mandatoryUpdate = mandatoryMatch[1].toLowerCase() === 'true';
  }

  const shaMatch = body.match(/sha256\s*[:=]\s*([a-f0-9]{64})/i);
  if (shaMatch && !out.sha256) {
    out.sha256 = shaMatch[1].toLowerCase();
  }

  return out;
}

export function cleanChangelogText(body = ''): string {
  return body
    .replace(/<!--\s*ipflix-meta\s*:[\s\S]*?-->/gi, '')
    .trim();
}

export function pickAssetForChannel(
  assets: GitHubReleaseAsset[],
  channel: DistributionChannel
): GitHubReleaseAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  if (isPlayStoreChannel(channel)) return null;

  const validAssets = assets.filter(
    (a) => a && typeof a.name === 'string' && isAllowedGitHubUrl(a.browser_download_url)
  );

  if (channel === 'windows_electron') {
    return (
      validAssets.find((a) => /^ipflix[-_ ]?windows[-_ ]?setup.*\.exe$/i.test(a.name)) ||
      validAssets.find((a) => /setup.*\.exe$/i.test(a.name)) ||
      validAssets.find((a) => /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name)) ||
      null
    );
  }

  if (channel === 'android_tv_apk') {
    return (
      validAssets.find((a) => /android[-_ ]?tv.*\.apk$/i.test(a.name)) ||
      validAssets.find((a) => /tv.*\.apk$/i.test(a.name)) ||
      validAssets.find((a) => /ipflix[-_ ]?android.*\.apk$/i.test(a.name)) ||
      validAssets.find((a) => /\.apk$/i.test(a.name)) ||
      null
    );
  }

  if (channel === 'android_apk') {
    return (
      validAssets.find(
        (a) => /ipflix[-_ ]?android[-_ ]?phone.*\.apk$/i.test(a.name) && !/tv/i.test(a.name)
      ) ||
      validAssets.find(
        (a) => /ipflix[-_ ]?android.*\.apk$/i.test(a.name) && !/tv/i.test(a.name)
      ) ||
      validAssets.find((a) => /\.apk$/i.test(a.name) && !/tv/i.test(a.name)) ||
      validAssets.find((a) => /\.apk$/i.test(a.name)) ||
      null
    );
  }

  // Generic web view: prefer Windows installer or Android APK if inspected from desktop browser
  return (
    validAssets.find((a) => /\.exe$/i.test(a.name)) ||
    validAssets.find((a) => /\.apk$/i.test(a.name)) ||
    null
  );
}

export function findChecksumAssetUrls(
  assets: GitHubReleaseAsset[],
  targetAssetName: string | null
): { manifestUrl: string | null; checksumUrls: string[] } {
  const validAssets = (assets || []).filter(
    (a) => a && typeof a.name === 'string' && isAllowedGitHubUrl(a.browser_download_url)
  );
  const manifest =
    validAssets.find((a) => /^ipflix[-_ ]?release\.json$/i.test(a.name)) ||
    validAssets.find((a) => /^release\.json$/i.test(a.name)) ||
    null;

  const checksumUrls: string[] = [];
  if (targetAssetName) {
    const exact = validAssets.find(
      (a) => a.name.toLowerCase() === `${targetAssetName.toLowerCase()}.sha256`
    );
    if (exact) checksumUrls.push(exact.browser_download_url);
  }
  const sums = validAssets.find((a) => /^(sha256sums(\.txt)?|checksums(\.txt)?)$/i.test(a.name));
  if (sums) checksumUrls.push(sums.browser_download_url);

  return {
    manifestUrl: manifest ? manifest.browser_download_url : null,
    checksumUrls,
  };
}

export function deriveVersionCode(version: string, explicitCode?: number): number {
  if (typeof explicitCode === 'number' && Number.isInteger(explicitCode) && explicitCode > 0) {
    return explicitCode;
  }
  const parts = normalizeSemver(version)
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

export function buildUpdateCheckResultFromRelease(params: {
  releases: GitHubReleaseRecord[];
  channel: DistributionChannel;
  currentVersion?: string;
  currentVersionCode?: number;
  manifestOverride?: ParsedReleaseManifest | null;
  checksumTextOverride?: string | null;
  cached?: boolean;
  checkedAt?: number;
}): UpdateCheckResult {
  const currentVersion = normalizeSemver(params.currentVersion || APP_VERSION);
  const currentVersionCode = params.currentVersionCode || APP_VERSION_CODE;
  const checkedAt = params.checkedAt || Date.now();
  const channel = params.channel;
  const isExternalApkAllowed = !isPlayStoreChannel(channel);

  const nonDraftReleases = (params.releases || []).filter((r) => r && !r.draft);
  const latestRelease =
    nonDraftReleases.find((r) => !r.prerelease) || nonDraftReleases[0] || null;

  if (!latestRelease) {
    return {
      status: isPlayStoreChannel(channel) ? 'play_store_managed' : 'no_releases',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt,
      cached: Boolean(params.cached),
      updateAvailable: false,
      isExternalApkAllowed,
      message: isPlayStoreChannel(channel)
        ? 'Google Play Store kanalında güncellemeler Play In-App Updates üzerinden yönetilir.'
        : 'GitHub deposunda henüz yayınlanmış bir sürüm bulunamadı.',
    };
  }

  const bodyMeta = parseManifestFromReleaseBody(latestRelease.body || '');
  const meta: ParsedReleaseManifest = {
    ...bodyMeta,
    ...(params.manifestOverride || {}),
  };

  const version = normalizeSemver(meta.version || latestRelease.tag_name || latestRelease.name);
  const versionCode = deriveVersionCode(version, meta.versionCode);
  const minimumSupportedVersion = normalizeSemver(meta.minimumSupportedVersion || '0.0.0');
  const belowMinSupported =
    minimumSupportedVersion !== '0.0.0' &&
    compareSemver(currentVersion, minimumSupportedVersion) < 0;
  const mandatoryUpdate = Boolean(meta.mandatoryUpdate) || belowMinSupported;

  const isNewer =
    compareSemver(version, currentVersion) > 0 || versionCode > currentVersionCode;

  const assets = Array.isArray(latestRelease.assets) ? latestRelease.assets : [];
  const pickedAsset = pickAssetForChannel(assets, channel);

  let resolvedSha256: string | null = null;
  let sha256Source: PlatformUpdateMetadata['sha256Source'] = 'none';

  if (pickedAsset && params.checksumTextOverride) {
    const parsedFromFile = parseChecksumTextForAsset(params.checksumTextOverride, pickedAsset.name);
    if (parsedFromFile) {
      resolvedSha256 = parsedFromFile;
      sha256Source = 'asset';
    }
  }

  if (!resolvedSha256 && pickedAsset && meta.checksums?.[pickedAsset.name]) {
    const fromChecksums = normalizeSha256(meta.checksums[pickedAsset.name]);
    if (fromChecksums) {
      resolvedSha256 = fromChecksums;
      sha256Source = 'manifest';
    }
  }

  if (!resolvedSha256) {
    const channelHash =
      channel === 'windows_electron'
        ? meta.windowsSha256
        : channel === 'android_tv_apk'
        ? meta.androidTvApkSha256 || meta.androidApkSha256
        : channel === 'android_apk'
        ? meta.androidApkSha256
        : undefined;
    const normalized = normalizeSha256(channelHash || meta.sha256);
    if (normalized) {
      resolvedSha256 = normalized;
      sha256Source = params.manifestOverride ? 'manifest' : 'body';
    }
  }

  if (!resolvedSha256 && pickedAsset && latestRelease.body) {
    const fromBodyAsset = parseChecksumTextForAsset(latestRelease.body, pickedAsset.name);
    if (fromBodyAsset) {
      resolvedSha256 = fromBodyAsset;
      sha256Source = 'body';
    }
  }

  const metadata: PlatformUpdateMetadata = {
    version,
    versionCode,
    tagName: latestRelease.tag_name || `v${version}`,
    releaseName: latestRelease.name || `IPFLIX v${version}`,
    releaseDate:
      meta.releaseDate ||
      latestRelease.published_at ||
      latestRelease.created_at ||
      new Date(checkedAt).toISOString(),
    changelog: cleanChangelogText(meta.changelog || latestRelease.body || ''),
    downloadUrl: isExternalApkAllowed ? pickedAsset?.browser_download_url || null : null,
    assetName: isExternalApkAllowed ? pickedAsset?.name || null : null,
    assetSizeBytes: isExternalApkAllowed && pickedAsset?.size ? pickedAsset.size : null,
    sha256: resolvedSha256,
    sha256Source,
    minimumSupportedVersion,
    mandatoryUpdate,
    releaseHtmlUrl: latestRelease.html_url || GITHUB_RELEASES_PAGE,
  };

  if (isPlayStoreChannel(channel)) {
    return {
      status: 'play_store_managed',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt,
      cached: Boolean(params.cached),
      updateAvailable: false,
      isExternalApkAllowed: false,
      latest: metadata,
      message: 'Google Play Store kanalında güncellemeler Play In-App Updates üzerinden yönetilir.',
    };
  }

  if (!isNewer) {
    return {
      status: 'up_to_date',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt,
      cached: Boolean(params.cached),
      updateAvailable: false,
      isExternalApkAllowed,
      latest: metadata,
    };
  }

  // Update tag exists, check whether an installable binary asset was uploaded for this platform
  if (!pickedAsset) {
    return {
      status: 'asset_missing',
      channel,
      currentVersion,
      currentVersionCode,
      checkedAt,
      cached: Boolean(params.cached),
      updateAvailable: false,
      isExternalApkAllowed,
      latest: metadata,
      message: `Yeni sürüm (v${version}) yayınlandı ancak bu platform için kurulum dosyası henüz yüklenmemiş.`,
    };
  }

  return {
    status: 'update_available',
    channel,
    currentVersion,
    currentVersionCode,
    checkedAt,
    cached: Boolean(params.cached),
    updateAvailable: true,
    isExternalApkAllowed,
    latest: metadata,
  };
}
