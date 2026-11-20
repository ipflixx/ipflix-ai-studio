import { app } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  APP_VERSION,
  APP_VERSION_CODE,
  GITHUB_RELEASES_API,
  GITHUB_REPO,
  GITHUB_OWNER,
} from '../src/config/appVersion';
import {
  buildUpdateCheckResultFromRelease,
  findChecksumAssetUrls,
  isAllowedGitHubUrl,
  isValidSha256Hex,
  type GitHubReleaseRecord,
  type ParsedReleaseManifest,
} from '../src/services/releaseParser';
import type { UpdateCheckResult, UpdateDownloadProgressEvent } from '../src/types/iptv';
import type { ElectronStorageManager } from './storageManager';

const CACHE_TTL_MS = 30 * 60 * 1000;
const REPO_KEY = `${GITHUB_OWNER}/${GITHUB_REPO}`;

export interface ElectronUpdaterOptions {
  storageManager: ElectronStorageManager;
  currentVersion?: string;
  updatesTempDir?: string;
  releasesApiUrl?: string;
  allowLocalHttpForTests?: boolean;
  onProgress?: (event: UpdateDownloadProgressEvent) => void;
  onQuitForInstaller?: () => void;
}

interface HttpTextResponse {
  statusCode: number;
  etag: string | null;
  text: string;
}

function sanitizeSafeInstallerFileName(rawName: string): string | null {
  const base = path.basename(rawName || '').trim();
  if (!base || !/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  if (!/\.exe$/i.test(base)) return null;
  return base;
}

export class ElectronUpdaterService {
  private readonly storageManager: ElectronStorageManager;
  private readonly currentVersion: string;
  private readonly updatesDir: string;
  private readonly releasesApiUrl: string;
  private readonly allowLocalHttpForTests: boolean;
  private readonly onProgress?: (event: UpdateDownloadProgressEvent) => void;
  private readonly onQuitForInstaller?: () => void;
  private readonly verifiedInstallers = new Map<string, string>();
  private downloadInFlight = false;

  constructor(options: ElectronUpdaterOptions) {
    this.storageManager = options.storageManager;
    this.currentVersion = options.currentVersion || app?.getVersion?.() || APP_VERSION;
    this.updatesDir = path.resolve(
      options.updatesTempDir || path.join(app.getPath('temp'), 'ipflix-updates')
    );
    this.releasesApiUrl = options.releasesApiUrl || GITHUB_RELEASES_API;
    this.allowLocalHttpForTests = Boolean(options.allowLocalHttpForTests);
    this.onProgress = options.onProgress;
    this.onQuitForInstaller = options.onQuitForInstaller;
  }

  private emitProgress(evt: UpdateDownloadProgressEvent): void {
    try {
      this.onProgress?.(evt);
    } catch {
      // ignore listener errors
    }
  }

  private isAllowedUrl(rawUrl: string): boolean {
    if (this.allowLocalHttpForTests) {
      try {
        const u = new URL(rawUrl);
        if (
          (u.protocol === 'http:' || u.protocol === 'https:') &&
          (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
        ) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return isAllowedGitHubUrl(rawUrl);
  }

  private fetchHttpsText(
    rawUrl: string,
    etag?: string | null,
    redirectsLeft = 5
  ): Promise<HttpTextResponse> {
    if (!this.isAllowedUrl(rawUrl)) {
      return Promise.reject(new Error('Engellenmiş veya geçersiz güncelleme adresi.'));
    }

    return new Promise((resolve, reject) => {
      const parsed = new URL(rawUrl);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers: Record<string, string> = {
        'User-Agent': `IPFlix-Desktop/${this.currentVersion}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (etag) {
        headers['If-None-Match'] = etag;
      }

      const req = transport.get(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          headers,
          timeout: 15000,
          ...(isHttps ? { rejectUnauthorized: true } : {}),
        },
        (res) => {
          const status = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let nextUrl: string;
            try {
              nextUrl = new URL(res.headers.location, rawUrl).toString();
            } catch {
              reject(new Error('Geçersiz yönlendirme adresi.'));
              return;
            }
            this.fetchHttpsText(nextUrl, etag, redirectsLeft - 1).then(resolve).catch(reject);
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          const maxBytes = 4 * 1024 * 1024;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              req.destroy();
              reject(new Error('GitHub yanıt boyutu sınırı aşıldı.'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const respEtag =
              typeof res.headers.etag === 'string' ? res.headers.etag : null;
            resolve({
              statusCode: status,
              etag: respEtag,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('GitHub güncelleme kontrolü zaman aşımına uğradı.')));
      req.on('error', reject);
    });
  }

  private streamDownloadWithSha256(
    rawUrl: string,
    destPartPath: string,
    redirectsLeft = 6
  ): Promise<{ totalBytes: number; sha256: string }> {
    if (!this.isAllowedUrl(rawUrl)) {
      return Promise.reject(new Error('Engellenmiş indirme bağlantısı.'));
    }

    return new Promise((resolve, reject) => {
      const parsed = new URL(rawUrl);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.get(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            'User-Agent': `IPFlix-Desktop/${this.currentVersion}`,
            Accept: 'application/octet-stream',
          },
          timeout: 30000,
          ...(isHttps ? { rejectUnauthorized: true } : {}),
        },
        (res) => {
          const status = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let nextUrl: string;
            try {
              nextUrl = new URL(res.headers.location, rawUrl).toString();
            } catch {
              reject(new Error('Geçersiz indirme yönlendirmesi.'));
              return;
            }
            this.streamDownloadWithSha256(nextUrl, destPartPath, redirectsLeft - 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`Kurulum dosyası indirilemedi (HTTP ${status}).`));
            return;
          }

          const totalBytes = Number(res.headers['content-length'] || 0) || 0;
          const hash = crypto.createHash('sha256');
          const outStream = fs.createWriteStream(destPartPath, { mode: 0o600 });
          let receivedBytes = 0;
          let lastEmit = 0;

          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            hash.update(chunk);
            const now = Date.now();
            if (now - lastEmit >= 120 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
              lastEmit = now;
              const percent =
                totalBytes > 0
                  ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
                  : 0;
              this.emitProgress({
                stage: 'downloading',
                percent,
                receivedBytes,
                totalBytes,
              });
            }
          });

          res.on('error', (err) => {
            outStream.destroy();
            reject(err);
          });

          outStream.on('error', (err) => {
            req.destroy();
            reject(err);
          });

          outStream.on('finish', () => {
            resolve({
              totalBytes: receivedBytes,
              sha256: hash.digest('hex').toLowerCase(),
            });
          });

          res.pipe(outStream);
        }
      );

      req.on('timeout', () => req.destroy(new Error('Güncelleme indirme bağlantısı zaman aşımına uğradı.')));
      req.on('error', reject);
    });
  }

  async checkForUpdates(force = false): Promise<UpdateCheckResult> {
    const sqlite = this.storageManager.getSqliteStore();
    const cachedRow = sqlite.isAvailable() ? sqlite.getUpdateCache(REPO_KEY) : null;
    const now = Date.now();

    if (!force && cachedRow && now - cachedRow.checkedAt < CACHE_TTL_MS) {
      try {
        const cachedPayload = JSON.parse(cachedRow.payloadJson) as {
          releases: GitHubReleaseRecord[];
          manifest: ParsedReleaseManifest | null;
          checksumText: string | null;
        };
        return buildUpdateCheckResultFromRelease({
          releases: cachedPayload.releases,
          channel: 'windows_electron',
          currentVersion: this.currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          manifestOverride: cachedPayload.manifest,
          checksumTextOverride: cachedPayload.checksumText,
          cached: true,
          checkedAt: cachedRow.checkedAt,
        });
      } catch {
        // Re-fetch cleanly if cached JSON was corrupt
      }
    }

    try {
      const apiResp = await this.fetchHttpsText(
        this.releasesApiUrl,
        force ? null : cachedRow?.etag
      );

      if (apiResp.statusCode === 304 && cachedRow) {
        sqlite.saveUpdateCache(REPO_KEY, cachedRow.etag, cachedRow.payloadJson, now);
        const cachedPayload = JSON.parse(cachedRow.payloadJson) as {
          releases: GitHubReleaseRecord[];
          manifest: ParsedReleaseManifest | null;
          checksumText: string | null;
        };
        return buildUpdateCheckResultFromRelease({
          releases: cachedPayload.releases,
          channel: 'windows_electron',
          currentVersion: this.currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          manifestOverride: cachedPayload.manifest,
          checksumTextOverride: cachedPayload.checksumText,
          cached: true,
          checkedAt: now,
        });
      }

      if (apiResp.statusCode === 404) {
        return buildUpdateCheckResultFromRelease({
          releases: [],
          channel: 'windows_electron',
          currentVersion: this.currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
        });
      }

      if (apiResp.statusCode === 403 || apiResp.statusCode === 429) {
        if (cachedRow) {
          const cachedPayload = JSON.parse(cachedRow.payloadJson) as {
            releases: GitHubReleaseRecord[];
            manifest: ParsedReleaseManifest | null;
            checksumText: string | null;
          };
          return buildUpdateCheckResultFromRelease({
            releases: cachedPayload.releases,
            channel: 'windows_electron',
            currentVersion: this.currentVersion,
            currentVersionCode: APP_VERSION_CODE,
            manifestOverride: cachedPayload.manifest,
            checksumTextOverride: cachedPayload.checksumText,
            cached: true,
            checkedAt: cachedRow.checkedAt,
          });
        }
        return {
          status: 'error',
          channel: 'windows_electron',
          currentVersion: this.currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
          cached: false,
          updateAvailable: false,
          isExternalApkAllowed: true,
          error: 'GitHub API istek limiti doldu. Lütfen biraz sonra tekrar deneyin.',
        };
      }

      if (apiResp.statusCode < 200 || apiResp.statusCode >= 300) {
        return {
          status: 'error',
          channel: 'windows_electron',
          currentVersion: this.currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
          cached: false,
          updateAvailable: false,
          isExternalApkAllowed: true,
          error: `GitHub Releases yanıt hatası (HTTP ${apiResp.statusCode}).`,
        };
      }

      const rawParsed = JSON.parse(apiResp.text) as GitHubReleaseRecord | GitHubReleaseRecord[];
      const releases = Array.isArray(rawParsed) ? rawParsed : rawParsed ? [rawParsed] : [];

      const initialResult = buildUpdateCheckResultFromRelease({
        releases,
        channel: 'windows_electron',
        currentVersion: this.currentVersion,
        currentVersionCode: APP_VERSION_CODE,
        checkedAt: now,
      });

      let manifest: ParsedReleaseManifest | null = null;
      let checksumText: string | null = null;
      const latestRelease = releases.find((r) => r && !r.draft && !r.prerelease) || releases[0];

      if (latestRelease && Array.isArray(latestRelease.assets)) {
        const { manifestUrl, checksumUrls } = findChecksumAssetUrls(
          latestRelease.assets,
          initialResult.latest?.assetName || null
        );
        if (manifestUrl) {
          try {
            const mRes = await this.fetchHttpsText(manifestUrl);
            if (mRes.statusCode >= 200 && mRes.statusCode < 300) {
              manifest = JSON.parse(mRes.text) as ParsedReleaseManifest;
            }
          } catch {
            // Optional manifest fetch failure does not crash update check
          }
        }
        for (const cUrl of checksumUrls) {
          try {
            const cRes = await this.fetchHttpsText(cUrl);
            if (cRes.statusCode >= 200 && cRes.statusCode < 300 && cRes.text.trim()) {
              checksumText = (checksumText ? `${checksumText}\n` : '') + cRes.text.trim();
            }
          } catch {
            // Try next checksum asset
          }
        }
      }

      if (sqlite.isAvailable()) {
        sqlite.saveUpdateCache(
          REPO_KEY,
          apiResp.etag,
          JSON.stringify({ releases, manifest, checksumText }),
          now
        );
      }

      return buildUpdateCheckResultFromRelease({
        releases,
        channel: 'windows_electron',
        currentVersion: this.currentVersion,
        currentVersionCode: APP_VERSION_CODE,
        manifestOverride: manifest,
        checksumTextOverride: checksumText,
        cached: false,
        checkedAt: now,
      });
    } catch (err) {
      return {
        status: 'error',
        channel: 'windows_electron',
        currentVersion: this.currentVersion,
        currentVersionCode: APP_VERSION_CODE,
        checkedAt: now,
        cached: false,
        updateAvailable: false,
        isExternalApkAllowed: true,
        error: err instanceof Error ? err.message : 'Güncelleme kontrolü başarısız oldu.',
      };
    }
  }

  async downloadAndVerifyInstaller(params: {
    downloadUrl: string;
    expectedSha256: string;
    assetName: string;
  }): Promise<{ ok: boolean; filePath?: string; sha256?: string; error?: string }> {
    if (this.downloadInFlight) {
      return { ok: false, error: 'Halihazırda devam eden bir güncelleme indirmesi var.' };
    }

    if (!this.isAllowedUrl(params.downloadUrl)) {
      return { ok: false, error: 'İndirme bağlantısı güvenilir GitHub sunucularına ait değil.' };
    }

    if (!isValidSha256Hex(params.expectedSha256)) {
      return {
        ok: false,
        error:
          'Güvenlik gereği SHA-256 doğrulama özeti olmayan kurulum paketleri otomatik indirilip çalıştırılmaz.',
      };
    }

    const safeFileName = sanitizeSafeInstallerFileName(params.assetName);
    if (!safeFileName) {
      return { ok: false, error: 'Geçersiz Windows kurulum dosyası adı (.exe bekleniyor).' };
    }

    const resolvedBase = path.resolve(this.updatesDir);
    const destPath = path.resolve(resolvedBase, safeFileName);
    const partPath = path.resolve(resolvedBase, `${safeFileName}.part.${Date.now()}`);

    if (!destPath.startsWith(resolvedBase + path.sep) || !partPath.startsWith(resolvedBase + path.sep)) {
      return { ok: false, error: 'Güvenlik sınırı: Geçersiz hedef dosya yolu.' };
    }

    this.downloadInFlight = true;
    try {
      fs.mkdirSync(resolvedBase, { recursive: true });
      this.emitProgress({ stage: 'downloading', percent: 0, receivedBytes: 0, totalBytes: 0 });

      const downloaded = await this.streamDownloadWithSha256(params.downloadUrl, partPath);

      this.emitProgress({
        stage: 'verifying_sha256',
        percent: 100,
        receivedBytes: downloaded.totalBytes,
        totalBytes: downloaded.totalBytes,
      });

      const expectedLower = params.expectedSha256.trim().toLowerCase();
      if (downloaded.sha256 !== expectedLower) {
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
        } catch {
          // ignore cleanup error
        }
        const errMsg =
          'SHA-256 güvenlik doğrulaması başarısız! İndirilen kurulum dosyası bozulmuş veya değiştirilmiş olabilir; mevcut sürüm korundu.';
        this.emitProgress({
          stage: 'error',
          percent: 0,
          receivedBytes: 0,
          totalBytes: 0,
          error: errMsg,
        });
        return { ok: false, error: errMsg };
      }

      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.renameSync(partPath, destPath);
      this.verifiedInstallers.set(destPath, downloaded.sha256);

      this.emitProgress({
        stage: 'verified',
        percent: 100,
        receivedBytes: downloaded.totalBytes,
        totalBytes: downloaded.totalBytes,
        filePath: destPath,
        sha256: downloaded.sha256,
      });

      return { ok: true, filePath: destPath, sha256: downloaded.sha256 };
    } catch (err) {
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch {
        // ignore cleanup error
      }
      const msg = err instanceof Error ? err.message : 'Güncelleme indirilemedi.';
      this.emitProgress({ stage: 'error', percent: 0, receivedBytes: 0, totalBytes: 0, error: msg });
      return { ok: false, error: msg };
    } finally {
      this.downloadInFlight = false;
    }
  }

  async installVerifiedInstaller(filePath: string): Promise<{ ok: boolean; error?: string }> {
    const resolvedBase = path.resolve(this.updatesDir);
    const resolvedTarget = path.resolve(filePath || '');

    if (
      !resolvedTarget.startsWith(resolvedBase + path.sep) ||
      !/\.exe$/i.test(resolvedTarget) ||
      !fs.existsSync(resolvedTarget)
    ) {
      return { ok: false, error: 'Doğrulanmış kurulum dosyası bulunamadı.' };
    }

    const expectedSha256 = this.verifiedInstallers.get(resolvedTarget);
    if (!expectedSha256) {
      return { ok: false, error: 'Bu dosya SHA-256 doğrulamasından geçmemiş.' };
    }

    // Re-hash directly from disk immediately prior to spawning
    const actualSha256 = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(resolvedTarget);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    });

    if (actualSha256 !== expectedSha256) {
      try {
        fs.unlinkSync(resolvedTarget);
      } catch {
        // ignore
      }
      this.verifiedInstallers.delete(resolvedTarget);
      return { ok: false, error: 'Kurulum dosyası çalıştırılmadan önce bütünlüğünü kaybetti.' };
    }

    this.emitProgress({
      stage: 'installing',
      percent: 100,
      receivedBytes: 0,
      totalBytes: 0,
      filePath: resolvedTarget,
      sha256: actualSha256,
    });

    // Flush SQLite WAL + DPAPI vault before launching installer over current app
    await this.storageManager.flush();

    if (process.platform === 'win32') {
      const child = spawn(resolvedTarget, [], {
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => {
        this.onQuitForInstaller?.();
      }, 350);
    }

    return { ok: true };
  }
}
