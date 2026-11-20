import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  APP_VERSION_CODE,
  GITHUB_RELEASES_API,
  isPlayStoreChannel,
  type DistributionChannel,
} from './src/config/appVersion';
import {
  buildUpdateCheckResultFromRelease,
  findChecksumAssetUrls,
  isAllowedGitHubUrl,
  isValidSha256Hex,
  type GitHubReleaseRecord,
  type ParsedReleaseManifest,
} from './src/services/releaseParser';

const SERVER_DIR =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
let activePort = PORT;
const isProduction = process.env.NODE_ENV === 'production';

// Permissive TLS agent for IPTV providers using self-signed, expired, or legacy SSL certificates.
// keepAlive: false prevents stale-socket ECONNRESET errors from PHP/Nginx IPTV panels.
const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const freshHttpAgent = new http.Agent({
  keepAlive: false,
});

const FALLBACK_USER_AGENTS = [
  'IPTVSmartersPro',
  'VLC/3.0.20 LibVLC/3.0.20',
  'ExoPlayerLib/2.18.1',
  'TiviMate/4.7.0 (Linux; Android 13)',
  'Dalvik/2.1.0 (Linux; U; Android 13; Shield Android TV)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Lavf/58.76.100',
];

const isWindows = process.platform === 'win32';
const FFMPEG_BIN =
  process.env.IPFLIX_FFMPEG_PATH ||
  (!isWindows && fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
const FFPROBE_BIN =
  process.env.IPFLIX_FFPROBE_PATH ||
  (!isWindows && fs.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : 'ffprobe');
const CURL_BIN =
  process.env.IPFLIX_CURL_PATH ||
  (isWindows ? 'curl.exe' : fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl');
const activeFfmpegProcesses = new Set<ChildProcess>();
const activeCurlProcesses = new Set<ChildProcess>();

function checkBinaryAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 3000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

class BlockedUrlError extends Error {
  constructor(message = 'Blocked restricted URL or host') {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const BLOCKED_METADATA_HOSTNAMES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '0.0.0.0',
  '::',
  'fd00:ec2::254',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c, d] = parts;
  // 169.254.0.0/16 — link-local & AWS/GCP/Azure/Oracle/DO metadata
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — unspecified / "this network"
  if (a === 0) return true;
  // 100.100.100.200 — Alibaba Cloud metadata
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  return false;
}

function parseIpv6ToGroups(raw: string): number[] | null {
  const cleaned = raw.split('%')[0].toLowerCase();
  if (!cleaned.includes(':')) return null;

  let working = cleaned;
  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:169.254.169.254) into two 16-bit hex groups
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = tail.split('.').map((p) => Number(p));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleParts = working.split('::');
  if (doubleParts.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const segs = part.split(':');
    const out: number[] = [];
    for (const s of segs) {
      if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
      out.push(parseInt(s, 16));
    }
    return out;
  };

  if (doubleParts.length === 1) {
    const groups = parsePart(doubleParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parsePart(doubleParts[0]);
  const right = parsePart(doubleParts[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function isBlockedIpAddress(rawIp: string): boolean {
  const stripped = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!stripped) return true;

  if (net.isIPv4(stripped)) {
    return isBlockedIpv4(stripped);
  }

  const groups = parseIpv6ToGroups(stripped);
  if (!groups) return false;

  // :: unspecified
  if (groups.every((g) => g === 0)) return true;
  // fe80::/10 IPv6 link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // fd00:ec2::254 AWS IPv6 IMDS
  if (
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 0x0254
  ) {
    return true;
  }

  // Embedded IPv4 inside IPv6:
  // - ::ffff:0:0/96 (IPv4-mapped, incl. WHATWG normalized ::ffff:a9fe:a9fe)
  // - ::/96 (IPv4-compatible, excluding ::1)
  // - 64:ff9b::/96 (NAT64 well-known prefix)
  const isIpv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  const isIpv4Compat =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    !(groups[6] === 0 && groups[7] === 1);
  const isNat64 =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;

  if (isIpv4Mapped || isIpv4Compat || isNat64) {
    const hi = groups[6];
    const lo = groups[7];
    const embeddedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(embeddedV4);
  }

  return false;
}

function isBlockedMetadataHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Strict scheme allowlist — reject file://, ftp://, gopher://, dict://, data:, etc.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }
    const rawHost = parsed.hostname.toLowerCase();
    const cleanHost = rawHost.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!cleanHost) return true;

    if (
      BLOCKED_METADATA_HOSTNAMES.has(cleanHost) ||
      cleanHost.endsWith('.metadata.google.internal') ||
      cleanHost.endsWith('.metadata.goog')
    ) {
      return true;
    }

    if (isBlockedIpAddress(cleanHost)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

const dnsSafetyCache = new Map<string, { blocked: boolean; expiresAt: number }>();

async function assertSafeUpstreamUrl(rawUrl: string): Promise<URL> {
  if (!rawUrl || isBlockedMetadataHost(rawUrl)) {
    throw new BlockedUrlError('Blocked restricted URL, protocol, or metadata host');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('Invalid upstream URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError(`Unsupported protocol: ${parsed.protocol}`);
  }

  const cleanHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (cleanHost === 'localhost' || net.isIP(cleanHost) !== 0) {
    if (net.isIP(cleanHost) !== 0 && isBlockedIpAddress(cleanHost)) {
      throw new BlockedUrlError('Blocked restricted IP address');
    }
    return parsed;
  }

  const now = Date.now();
  const cached = dnsSafetyCache.get(cleanHost);
  if (cached && cached.expiresAt > now) {
    if (cached.blocked) {
      throw new BlockedUrlError('Hostname resolves to a blocked metadata or link-local IP');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(cleanHost, { all: true, verbatim: true });
    const blocked = records.some((rec) => isBlockedIpAddress(rec.address));
    dnsSafetyCache.set(cleanHost, { blocked, expiresAt: now + 60_000 });
    if (dnsSafetyCache.size > 500) {
      const oldest = dnsSafetyCache.keys().next().value;
      if (oldest) dnsSafetyCache.delete(oldest);
    }
    if (blocked) {
      throw new BlockedUrlError('Hostname resolves to a blocked metadata or link-local IP');
    }
  } catch (err) {
    if (err instanceof BlockedUrlError) throw err;
    // Allow normal upstream network error reporting if DNS lookup fails transiently
  }

  return parsed;
}

function isOwnLocalStreamProxyUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return false;
    const port = parsed.port ? Number(parsed.port) : 80;
    if (port !== activePort) return false;
    if (!parsed.pathname.startsWith('/api/proxy/stream')) return false;
    const innerUrl = parsed.searchParams.get('url') || '';
    if (!innerUrl || isBlockedMetadataHost(innerUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

interface RawResponseResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  body: Buffer;
}

interface StreamResponseResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  stream: Readable;
  req: { destroy: () => void };
  transport?: 'node' | 'curl';
}

interface HostTransportEntry {
  preferCurl: boolean;
  userAgent: string;
  preferNoXff?: boolean;
  updatedAt: number;
}

const hostTransportCache = new Map<string, HostTransportEntry>();

function getHostKey(urlStr: string): string {
  try {
    return new URL(urlStr).host.toLowerCase();
  } catch {
    return '';
  }
}

function rememberHostTransport(urlStr: string, entry: Omit<HostTransportEntry, 'updatedAt'>): void {
  const key = getHostKey(urlStr);
  if (!key) return;
  hostTransportCache.set(key, { ...entry, updatedAt: Date.now() });
  if (hostTransportCache.size > 200) {
    const oldest = hostTransportCache.keys().next().value;
    if (oldest) hostTransportCache.delete(oldest);
  }
}

function getHostTransport(urlStr: string): HostTransportEntry | undefined {
  const key = getHostKey(urlStr);
  if (!key) return undefined;
  const entry = hostTransportCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > 6 * 3600 * 1000) {
    hostTransportCache.delete(key);
    return undefined;
  }
  return entry;
}

function sanitizeTargetUrl(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/ /g, '%20');
}

function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/i, '').trim();
  if (!clean) return true;
  if (clean === '::1' || clean === 'localhost') return true;
  if (/^127\./.test(clean) || /^10\./.test(clean) || /^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
  if (/^(fc|fd|fe80)/i.test(clean)) return true;
  return false;
}

function extractClientIp(req: Request): string | undefined {
  const remoteRaw = req.socket?.remoteAddress || '';
  const isLoopbackCaller = isPrivateIp(remoteRaw);
  // Allow internal localhost FFmpeg/FFprobe proxy calls to pass original user IP via _cip
  if (isLoopbackCaller && typeof req.query._cip === 'string' && !isPrivateIp(req.query._cip)) {
    return req.query._cip.trim();
  }

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    for (const part of xff.split(',')) {
      const candidate = part.trim().replace(/^::ffff:/i, '');
      if (candidate && !isPrivateIp(candidate)) return candidate;
    }
  }
  for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'] as const) {
    const val = req.headers[h];
    if (typeof val === 'string') {
      const candidate = val.trim().replace(/^::ffff:/i, '');
      if (candidate && !isPrivateIp(candidate)) return candidate;
    }
  }
  const cleanRemote = remoteRaw.replace(/^::ffff:/i, '').trim();
  return cleanRemote && !isPrivateIp(cleanRemote) ? cleanRemote : undefined;
}

function extractAcceptLanguage(req: Request): string {
  const remoteRaw = req.socket?.remoteAddress || '';
  if (isPrivateIp(remoteRaw) && typeof req.query._lang === 'string' && req.query._lang.trim()) {
    return req.query._lang.trim();
  }
  const al = req.headers['accept-language'];
  return typeof al === 'string' && al.trim() ? al.trim() : 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';
}

function extractPlainSnippet(raw = ''): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function detectGeoRestriction(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  bodySnippet = ''
): {
  geoBlocked: boolean;
  errorKind: 'geo_blocked' | 'auth_or_limit' | 'upstream_blocked' | 'upstream_error';
  reason?: string;
  upstreamSnippet?: string;
} {
  const cleanSnippet = extractPlainSnippet(bodySnippet);
  const lowerBody = cleanSnippet.toLowerCase();
  const hasGeoText =
    /bölge\s*kısıt|bolge\s*kisit|coğrafi|cografi|ülke\s*kısıt|ulke\s*kisit|geo[\s-]*block|geo[\s-]*restrict|region[\s-]*restrict|country\s*not\s*allowed|not\s*available\s*in\s*your\s*(country|region|location)|unavailable\s*in\s*your\s*(country|region)|vpn\s*(detected|blocked)|proxy\s*(detected|blocked)|isp\s*lock/.test(
      lowerBody
    );

  if (statusCode === 451) {
    return {
      geoBlocked: true,
      errorKind: 'geo_blocked',
      reason: 'Region / Geo-restriction (HTTP 451): This channel blocks connections from the European cloud server.',
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  if (hasGeoText) {
    return {
      geoBlocked: true,
      errorKind: 'geo_blocked',
      reason: `Region / Geo-restriction from provider or broadcaster CDN (HTTP ${statusCode}).`,
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  const akamaiHeader = String(headers['akamai-request-bc'] || headers['akamai-grn'] || '');
  const cfRay = String(headers['cf-ray'] || '');
  const isCdnAccessDenied =
    statusCode === 403 &&
    (akamaiHeader.length > 0 ||
      cfRay.length > 0 ||
      lowerBody.includes('access denied') ||
      lowerBody.includes('edgesuite') ||
      lowerBody.includes('akamai') ||
      lowerBody.includes('cloudflare'));

  if (isCdnAccessDenied) {
    return {
      geoBlocked: true,
      errorKind: 'geo_blocked',
      reason: 'CDN / Provider IP Geo-Block (HTTP 403 Access Denied from Belgium cloud server IP).',
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  if (statusCode === 456) {
    return {
      geoBlocked: true,
      errorKind: 'auth_or_limit',
      reason:
        'Provider rejected stream (HTTP 456) — usually either Country/ISP IP lock or active connection limit (max_connections).',
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  if (statusCode === 403) {
    return {
      geoBlocked: true,
      errorKind: 'upstream_blocked',
      reason:
        'Provider blocked cloud server stream request (HTTP 403) — likely Country/ISP IP restriction or datacenter block.',
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  if (statusCode === 401) {
    return {
      geoBlocked: false,
      errorKind: 'auth_or_limit',
      reason:
        'Provider returned HTTP 401 Unauthorized — token expired, IP-locked session, or account connection limit reached.',
      upstreamSnippet: cleanSnippet || undefined,
    };
  }

  return {
    geoBlocked: false,
    errorKind: 'upstream_error',
    upstreamSnippet: cleanSnippet || undefined,
  };
}

function requestRawStream(
  rawTargetUrl: string,
  options: {
    method?: 'GET' | 'POST' | 'HEAD';
    userAgent?: string;
    referer?: string;
    range?: string;
    body?: string;
    contentType?: string;
    acceptEncoding?: string;
    timeoutMs?: number;
    maxRedirects?: number;
    cookies?: string[];
    clientIp?: string;
    acceptLanguage?: string;
  } = {}
): Promise<StreamResponseResult> {
  const {
    method = 'GET',
    userAgent = FALLBACK_USER_AGENTS[0],
    referer,
    range,
    body,
    contentType,
    acceptEncoding = 'identity',
    timeoutMs = 20000,
    maxRedirects = 10,
    cookies = [],
    clientIp,
    acceptLanguage,
  } = options;

  const targetUrl = sanitizeTargetUrl(rawTargetUrl);

  return assertSafeUpstreamUrl(targetUrl).then(
    (parsed) =>
      new Promise<StreamResponseResult>((resolve, reject) => {
        const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqHeaders: Record<string, string> = {
      'User-Agent': userAgent || FALLBACK_USER_AGENTS[0],
      Accept: '*/*',
      'Accept-Encoding': range ? 'identity' : acceptEncoding,
      Connection: 'close',
    };

    if (acceptLanguage) {
      reqHeaders['Accept-Language'] = acceptLanguage;
    }
    if (clientIp && !isPrivateIp(clientIp)) {
      reqHeaders['X-Forwarded-For'] = clientIp;
      reqHeaders['X-Real-IP'] = clientIp;
      reqHeaders['True-Client-IP'] = clientIp;
    }
    if (referer) {
      reqHeaders['Referer'] = referer;
    }
    if (range) {
      reqHeaders['Range'] = range;
    }
    if (cookies.length > 0) {
      reqHeaders['Cookie'] = cookies.join('; ');
    }
    if (body) {
      reqHeaders['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        agent: isHttps ? insecureHttpsAgent : freshHttpAgent,
        insecureHTTPParser: true,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;

        // Collect Set-Cookie for redirects (critical for load-balanced IPTV tokens)
        const nextCookies = [...cookies];
        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
          for (const rawCookie of setCookie) {
            const pair = rawCookie.split(';')[0]?.trim();
            if (pair) {
              const name = pair.split('=')[0];
              const existingIdx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
              if (existingIdx >= 0) nextCookies[existingIdx] = pair;
              else nextCookies.push(pair);
            }
          }
        }

        // Manual redirect following (supports HTTPS->HTTP, cross-port, relative paths, spaces)
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          let nextUrl: string;
          try {
            const cleanLoc = res.headers.location.trim().replace(/ /g, '%20');
            nextUrl = new URL(cleanLoc, targetUrl).toString();
          } catch {
            reject(new Error(`Invalid redirect location: ${res.headers.location}`));
            return;
          }
          const nextMethod = status === 303 ? 'GET' : method;
          requestRawStream(nextUrl, {
            method: nextMethod,
            userAgent,
            referer,
            range,
            body: nextMethod === 'GET' ? undefined : body,
            contentType,
            acceptEncoding,
            timeoutMs,
            maxRedirects: maxRedirects - 1,
            cookies: nextCookies,
            clientIp,
            acceptLanguage,
          })
            .then(resolve)
            .catch(reject);
          return;
        }

        // Clear initial connect/header timeout so paused VOD or slow live streams aren't killed mid-playback
        req.setTimeout(0);

        resolve({
          statusCode: status,
          headers: res.headers,
          finalUrl: targetUrl,
          stream: res,
          req,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(body);
    }
    req.end();
      })
  );
}

function decompressBuffer(buf: Buffer, encoding?: string): Buffer {
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip') || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
      return zlib.gunzipSync(buf);
    }
    if (enc.includes('br')) {
      return zlib.brotliDecompressSync(buf);
    }
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
  } catch {
    return buf;
  }
  return buf;
}

async function fetchBuffer(
  targetUrl: string,
  options: {
    method?: 'GET' | 'POST';
    userAgent?: string;
    referer?: string;
    body?: string;
    timeoutMs?: number;
    maxBytes?: number;
    clientIp?: string;
    acceptLanguage?: string;
  } = {}
): Promise<RawResponseResult> {
  const maxBytes = options.maxBytes ?? 85 * 1024 * 1024; // up to 85MB for large M3U/XMLTV
  const result = await requestRawStream(targetUrl, {
    method: options.method || 'GET',
    userAgent: options.userAgent,
    referer: options.referer,
    body: options.body,
    acceptEncoding: 'gzip, deflate',
    timeoutMs: options.timeoutMs ?? 25000,
    clientIp: options.clientIp,
    acceptLanguage: options.acceptLanguage,
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    result.stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        result.stream.destroy();
        result.req.destroy();
        reject(new Error(`Response exceeded ${Math.round(maxBytes / 1024 / 1024)}MB limit`));
        return;
      }
      chunks.push(chunk);
    });

    result.stream.on('end', () => {
      const rawBuf = Buffer.concat(chunks);
      const decompressed = decompressBuffer(rawBuf, result.headers['content-encoding']);
      resolve({
        statusCode: result.statusCode,
        headers: result.headers,
        finalUrl: result.finalUrl,
        body: decompressed,
      });
    });

    result.stream.on('error', reject);
  });
}

// Secondary HTTP transport via system curl (bypasses Node TLS/JA3 WAF blocks & quirky HTTP/1.0 panels)
// Enforces strict http/https protocol allowlist and validates every redirect hop against SSRF/metadata rules.
async function curlFetchText(
  rawUrl: string,
  options: {
    method?: 'GET' | 'POST';
    userAgent?: string;
    body?: string;
    timeoutSec?: number;
    maxBytes?: number;
    clientIp?: string;
    acceptLanguage?: string;
    maxRedirects?: number;
  } = {}
): Promise<{ statusCode: number; text: string; finalUrl: string }> {
  let currentUrl = sanitizeTargetUrl(rawUrl);
  let currentMethod: 'GET' | 'POST' = options.method || 'GET';
  let currentBody = options.body;
  const maxRedirects = options.maxRedirects ?? 8;
  const ua = options.userAgent || FALLBACK_USER_AGENTS[0];
  const timeoutSec = Math.max(5, Math.min(45, options.timeoutSec ?? 18));
  const maxBytes = options.maxBytes ?? 30 * 1024 * 1024;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUpstreamUrl(currentUrl);

    const args = [
      '-sS',
      '-k',
      '--proto', '=http,https',
      '--proto-redir', '=http,https',
      '--compressed',
      '--connect-timeout', '9',
      '--max-time', String(timeoutSec),
      '-A', ua,
      '-H', 'Accept: */*',
      '-w', '\n__IPFLIX_META__%{http_code}__%{redirect_url}__%{url_effective}',
    ];

    if (options.acceptLanguage) {
      args.push('-H', `Accept-Language: ${options.acceptLanguage}`);
    }
    if (options.clientIp && !isPrivateIp(options.clientIp)) {
      args.push('-H', `X-Forwarded-For: ${options.clientIp}`, '-H', `X-Real-IP: ${options.clientIp}`);
    }
    if (currentMethod === 'POST' && currentBody) {
      args.push('-X', 'POST', '-H', 'Content-Type: application/x-www-form-urlencoded', '--data-raw', currentBody);
    }

    args.push('--', currentUrl);

    const hopResult = await new Promise<{
      statusCode: number;
      text: string;
      redirectUrl: string;
      finalUrl: string;
    }>((resolve, reject) => {
      execFile(
        CURL_BIN,
        args,
        { maxBuffer: maxBytes, timeout: (timeoutSec + 3) * 1000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.trim() || err.message || 'curl request failed'));
            return;
          }
          const marker = '\n__IPFLIX_META__';
          const idx = stdout.lastIndexOf(marker);
          if (idx === -1) {
            resolve({ statusCode: 200, text: stdout, redirectUrl: '', finalUrl: currentUrl });
            return;
          }
          const bodyText = stdout.slice(0, idx);
          const meta = stdout.slice(idx + marker.length).trim();
          const parts = meta.split('__');
          const code = parseInt(parts[0] || '0', 10) || 0;
          const redirectUrl = parts[1] || '';
          const finalUrl = parts.slice(2).join('__') || currentUrl;
          resolve({ statusCode: code, text: bodyText, redirectUrl, finalUrl });
        }
      );
    });

    if (
      [301, 302, 303, 307, 308].includes(hopResult.statusCode) &&
      hopResult.redirectUrl &&
      hop < maxRedirects
    ) {
      let nextUrl: string;
      try {
        nextUrl = new URL(hopResult.redirectUrl.trim().replace(/ /g, '%20'), currentUrl).toString();
      } catch {
        throw new BlockedUrlError(`Invalid redirect location: ${hopResult.redirectUrl}`);
      }
      await assertSafeUpstreamUrl(nextUrl);
      currentUrl = nextUrl;
      if (hopResult.statusCode === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      continue;
    }

    return {
      statusCode: hopResult.statusCode,
      text: hopResult.text,
      finalUrl: hopResult.finalUrl,
    };
  }

  throw new Error('Too many redirects');
}

function parseRawHttpHeaderBlock(rawText: string): {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
} {
  const lines = rawText.split(/\r?\n/);
  const statusLine = lines[0] || '';
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const headers: http.IncomingHttpHeaders = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (key === 'set-cookie') {
      const existing = headers['set-cookie'];
      headers['set-cookie'] = Array.isArray(existing) ? [...existing, val] : [val];
    } else if (headers[key] === undefined) {
      headers[key] = val;
    } else {
      const prev = headers[key];
      headers[key] = Array.isArray(prev) ? [...prev, val] : `${prev}, ${val}`;
    }
  }
  return { statusCode, headers };
}

function findHeaderDelimiter(buf: Buffer): { index: number; sepLen: number } | null {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, sepLen: 4 };
  }
  if (lf !== -1) {
    return { index: lf, sepLen: 2 };
  }
  return null;
}

async function curlRequestRawStream(
  rawTargetUrl: string,
  options: {
    method?: 'GET' | 'HEAD';
    userAgent?: string;
    referer?: string;
    range?: string;
    timeoutMs?: number;
    clientIp?: string;
    acceptLanguage?: string;
    maxRedirects?: number;
    cookies?: string[];
  } = {}
): Promise<StreamResponseResult> {
  const targetUrl = sanitizeTargetUrl(rawTargetUrl);
  await assertSafeUpstreamUrl(targetUrl);

  const maxRedirects = options.maxRedirects ?? 10;
  const cookies = options.cookies ?? [];

  return new Promise((resolve, reject) => {
    const ua = options.userAgent || FALLBACK_USER_AGENTS[0];
    const connectSec = Math.max(4, Math.min(15, Math.ceil((options.timeoutMs || 15000) / 1000)));
    const args: string[] = [
      '-sS',
      '-k',
      '-i',
      '--proto', '=http,https',
      '--proto-redir', '=http,https',
      '--connect-timeout', String(connectSec),
      '-A', ua,
      '-H', 'Accept: */*',
    ];

    if (options.method === 'HEAD') {
      args.push('-I');
    }
    if (options.referer) {
      args.push('-H', `Referer: ${options.referer}`);
    }
    if (options.range) {
      args.push('-H', `Range: ${options.range}`);
    }
    if (options.acceptLanguage) {
      args.push('-H', `Accept-Language: ${options.acceptLanguage}`);
    }
    if (cookies.length > 0) {
      args.push('-H', `Cookie: ${cookies.join('; ')}`);
    }
    if (options.clientIp && !isPrivateIp(options.clientIp)) {
      args.push('-H', `X-Forwarded-For: ${options.clientIp}`, '-H', `X-Real-IP: ${options.clientIp}`);
    }

    args.push('--', targetUrl);

    const child = spawn(CURL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeCurlProcesses.add(child);
    const pass = new PassThrough();
    let settled = false;
    let headerPhase = true;
    let headerBuf = Buffer.alloc(0);
    let currentUrl = targetUrl;
    let stderrText = '';

    const killChild = () => {
      activeCurlProcesses.delete(child);
      if (!child.killed) {
        try {
          child.kill(isWindows ? undefined : 'SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    const headerTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killChild();
        reject(new Error(`curl stream timed out after ${options.timeoutMs || 15000}ms`));
      }
    }, options.timeoutMs || 15000);

    const finishReject = (err: Error) => {
      clearTimeout(headerTimer);
      if (!settled) {
        settled = true;
        killChild();
        reject(err);
      } else if (!pass.destroyed) {
        pass.destroy(err);
      }
    };

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length < 600) stderrText += chunk.toString('utf8');
    });

    pass.on('close', killChild);
    pass.on('drain', () => {
      if (!headerPhase) child.stdout.resume();
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (!headerPhase) {
        if (!pass.destroyed) {
          const ok = pass.write(chunk);
          if (!ok) child.stdout.pause();
        }
        return;
      }

      headerBuf = Buffer.concat([headerBuf, chunk]);

      if (headerBuf.length > 256 * 1024) {
        finishReject(new Error('Upstream HTTP headers exceeded limit'));
        return;
      }

      while (headerPhase) {
        const delim = findHeaderDelimiter(headerBuf);
        if (!delim) break;

        const blockStr = headerBuf.subarray(0, delim.index).toString('latin1');
        const remainder = headerBuf.subarray(delim.index + delim.sepLen);

        if (!/^HTTP\/\d/i.test(blockStr.trimStart())) {
          // Non-standard raw response without HTTP header line
          headerPhase = false;
          clearTimeout(headerTimer);
          if (!settled) {
            settled = true;
            resolve({
              statusCode: 200,
              headers: {},
              finalUrl: currentUrl,
              stream: pass,
              req: { destroy: killChild },
              transport: 'curl',
            });
          }
          if (!pass.destroyed && headerBuf.length > 0) {
            pass.write(headerBuf);
          }
          headerBuf = Buffer.alloc(0);
          return;
        }

        const parsed = parseRawHttpHeaderBlock(blockStr);
        headerBuf = remainder;

        // Skip 1xx interim responses (e.g. 100 Continue)
        if (parsed.statusCode >= 100 && parsed.statusCode < 200) {
          continue;
        }

        // Manually validate and follow redirects hop-by-hop (prevents curl -L SSRF/metadata/file bypass)
        const loc = typeof parsed.headers.location === 'string' ? parsed.headers.location.trim() : '';
        if ([301, 302, 303, 307, 308].includes(parsed.statusCode) && loc && maxRedirects > 0) {
          headerPhase = false;
          clearTimeout(headerTimer);
          settled = true;
          killChild();

          const nextCookies = [...cookies];
          const setCookie = parsed.headers['set-cookie'];
          if (Array.isArray(setCookie)) {
            for (const rawCookie of setCookie) {
              const pair = rawCookie.split(';')[0]?.trim();
              if (pair) {
                const name = pair.split('=')[0];
                const existingIdx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
                if (existingIdx >= 0) nextCookies[existingIdx] = pair;
                else nextCookies.push(pair);
              }
            }
          }

          let nextUrl: string;
          try {
            nextUrl = new URL(loc.replace(/ /g, '%20'), currentUrl).toString();
          } catch {
            reject(new BlockedUrlError(`Invalid redirect location: ${loc}`));
            return;
          }

          curlRequestRawStream(nextUrl, {
            ...options,
            method: parsed.statusCode === 303 ? 'GET' : options.method,
            maxRedirects: maxRedirects - 1,
            cookies: nextCookies,
          })
            .then(resolve)
            .catch(reject);
          return;
        }

        // Final HTTP response headers reached!
        headerPhase = false;
        clearTimeout(headerTimer);
        if (!settled) {
          settled = true;
          resolve({
            statusCode: parsed.statusCode || 200,
            headers: parsed.headers,
            finalUrl: currentUrl,
            stream: pass,
            req: { destroy: killChild },
            transport: 'curl',
          });
        }
        if (!pass.destroyed && headerBuf.length > 0) {
          const ok = pass.write(headerBuf);
          if (!ok) child.stdout.pause();
        }
        headerBuf = Buffer.alloc(0);
        return;
      }
    });

    child.stdout.on('end', () => {
      clearTimeout(headerTimer);
      if (!settled) {
        if (headerBuf.length > 0) {
          const parsed = parseRawHttpHeaderBlock(headerBuf.toString('latin1'));
          if (parsed.statusCode > 0) {
            settled = true;
            resolve({
              statusCode: parsed.statusCode,
              headers: parsed.headers,
              finalUrl: currentUrl,
              stream: pass,
              req: { destroy: killChild },
              transport: 'curl',
            });
            pass.end();
            return;
          }
        }
        settled = true;
        reject(new Error(stderrText.trim() || 'curl closed before returning HTTP headers'));
        return;
      }
      if (!pass.writableEnded) pass.end();
    });

    child.on('error', (err) => {
      finishReject(err);
    });

    child.on('close', (code) => {
      activeCurlProcesses.delete(child);
      clearTimeout(headerTimer);
      if (!settled) {
        settled = true;
        reject(new Error(stderrText.trim() || `curl exited with code ${code}`));
      } else if (!pass.writableEnded) {
        pass.end();
      }
    });
  });
}

function buildUserAgentCandidates(preferred?: string): string[] {
  const list: string[] = [];
  if (preferred && preferred.trim()) list.push(preferred.trim());
  for (const ua of FALLBACK_USER_AGENTS) {
    if (!list.includes(ua)) list.push(ua);
  }
  return list;
}

function isLikelyBlockedStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 405 ||
    status === 406 ||
    status === 429 ||
    status === 451 ||
    status === 456 ||
    status === 503 ||
    status === 520 ||
    status === 521 ||
    status === 522 ||
    status === 525
  );
}

function isUnreachableHostError(err: Error): boolean {
  const msg = `${err.message} ${(err as NodeJS.ErrnoException).code || ''}`.toUpperCase();
  return msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('ECONNREFUSED') || msg.includes('ENETUNREACH') || msg.includes('EHOSTUNREACH');
}

function isCloudflareOrWafPage(text: string): boolean {
  return (
    text.includes('cf-browser-verification') ||
    text.includes('Just a moment...') ||
    text.includes('Checking your browser') ||
    text.includes('Attention Required! | Cloudflare') ||
    text.includes('Access denied |')
  );
}

async function fetchTextSmart(
  targetUrl: string,
  preferredUserAgent?: string,
  timeoutMs = 20000,
  maxBytes = 85 * 1024 * 1024,
  clientContext?: { clientIp?: string; acceptLanguage?: string }
): Promise<{
  statusCode: number;
  text: string;
  finalUrl: string;
  workingUserAgent: string;
  headers: http.IncomingHttpHeaders;
}> {
  const cached = getHostTransport(targetUrl);
  const candidates = buildUserAgentCandidates(preferredUserAgent || cached?.userAgent);
  let lastError: Error | null = null;
  let lastResult: RawResponseResult | null = null;
  let lastUa = candidates[0];
  let hostUnreachable = false;

  // Fast path: if this host previously required curl (e.g. Cloudflare/WAF TLS JA3 filtering), try curl first!
  if (cached?.preferCurl) {
    try {
      const cres = await curlFetchText(targetUrl, {
        userAgent: cached.userAgent,
        timeoutSec: Math.ceil(timeoutMs / 1000),
        maxBytes: Math.min(maxBytes, 50 * 1024 * 1024),
        clientIp: cached.preferNoXff ? undefined : clientContext?.clientIp,
        acceptLanguage: clientContext?.acceptLanguage,
      });
      if (cres.statusCode >= 200 && cres.statusCode < 300 && !isCloudflareOrWafPage(cres.text) && cres.text.trim().length > 0) {
        rememberHostTransport(targetUrl, {
          preferCurl: true,
          userAgent: cached.userAgent,
          preferNoXff: cached.preferNoXff,
        });
        return {
          statusCode: cres.statusCode,
          text: cres.text,
          finalUrl: cres.finalUrl,
          workingUserAgent: cached.userAgent,
          headers: {},
        };
      }
    } catch {
      // fall through to normal cascade
    }
  }

  for (let idx = 0; idx < candidates.length; idx++) {
    const ua = candidates[idx];
    // Attempt 0: clean preferred UA WITHOUT spoofed XFF; Attempt 1: with user's IP; later attempts: clean alternate UAs
    const forwardIp = idx === 1 ? clientContext?.clientIp : undefined;
    try {
      const res = await fetchBuffer(targetUrl, {
        userAgent: ua,
        timeoutMs: Math.min(timeoutMs, 14000),
        maxBytes,
        clientIp: forwardIp,
        acceptLanguage: clientContext?.acceptLanguage,
      });
      lastResult = res;
      lastUa = ua;
      const text = res.body.toString('utf8');
      const isChallenge = isCloudflareOrWafPage(text);

      if (res.statusCode >= 200 && res.statusCode < 300 && !isChallenge && text.trim().length > 0) {
        rememberHostTransport(targetUrl, {
          preferCurl: false,
          userAgent: ua,
          preferNoXff: !forwardIp,
        });
        return {
          statusCode: res.statusCode,
          text,
          finalUrl: res.finalUrl,
          workingUserAgent: ua,
          headers: res.headers,
        };
      }

      if (!isLikelyBlockedStatus(res.statusCode) && !isChallenge && text.trim().length > 0) {
        return {
          statusCode: res.statusCode,
          text,
          finalUrl: res.finalUrl,
          workingUserAgent: ua,
          headers: res.headers,
        };
      }
    } catch (err) {
      if (err instanceof BlockedUrlError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isUnreachableHostError(lastError)) {
        hostUnreachable = true;
        break;
      }
      // IMPORTANT: Do NOT break on ECONNRESET / socket hang up!
      // Many Xtream/Nginx panels use `return 444;` (TCP reset) to block specific User-Agents.
    }
  }

  // Fallback to native curl transport (bypasses TLS JA3 WAF blocks, legacy HTTP/1.0, and chunked parser quirks)
  if (!hostUnreachable) {
    const curlAttempts: Array<{ ua: string; forwardIp?: string }> = [
      { ua: candidates[0], forwardIp: undefined },
      ...(clientContext?.clientIp ? [{ ua: candidates[0], forwardIp: clientContext.clientIp }] : []),
      { ua: 'VLC/3.0.20 LibVLC/3.0.20', forwardIp: undefined },
      { ua: FALLBACK_USER_AGENTS[5], forwardIp: undefined },
    ];
    for (const attempt of curlAttempts) {
      try {
        const cres = await curlFetchText(targetUrl, {
          userAgent: attempt.ua,
          timeoutSec: Math.ceil(timeoutMs / 1000),
          maxBytes: Math.min(maxBytes, 50 * 1024 * 1024),
          clientIp: attempt.forwardIp,
          acceptLanguage: clientContext?.acceptLanguage,
        });
        if (cres.statusCode >= 200 && cres.statusCode < 300 && !isCloudflareOrWafPage(cres.text) && cres.text.trim().length > 0) {
          rememberHostTransport(targetUrl, {
            preferCurl: true,
            userAgent: attempt.ua,
            preferNoXff: !attempt.forwardIp,
          });
          return {
            statusCode: cres.statusCode,
            text: cres.text,
            finalUrl: cres.finalUrl,
            workingUserAgent: attempt.ua,
            headers: {},
          };
        }
        if (!lastResult && cres.statusCode > 0) {
          lastResult = {
            statusCode: cres.statusCode,
            headers: {},
            finalUrl: cres.finalUrl,
            body: Buffer.from(cres.text, 'utf8'),
          };
          lastUa = attempt.ua;
        }
      } catch (err) {
        if (err instanceof BlockedUrlError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  if (lastResult) {
    return {
      statusCode: lastResult.statusCode,
      text: lastResult.body.toString('utf8'),
      finalUrl: lastResult.finalUrl,
      workingUserAgent: lastUa,
      headers: lastResult.headers,
    };
  }

  throw lastError || new Error('Failed to connect to server');
}

function stripInvisible(str: string): string {
  return (str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function normalizeXtreamInput(rawServerUrl: string, rawUsername: string, rawPassword: string): {
  baseUrl: string;
  username: string;
  password: string;
} {
  let server = stripInvisible(rawServerUrl).replace(/^["']|["']$/g, '');
  let username = stripInvisible(rawUsername);
  let password = stripInvisible(rawPassword);

  if (!server) {
    throw new Error('Server URL is required');
  }

  if (!/^https?:\/\//i.test(server)) {
    server = `http://${server}`;
  }

  const parsed = new URL(server);

  // If user pasted a full get.php or player_api.php URL, extract credentials automatically
  const qUser = parsed.searchParams.get('username');
  const qPass = parsed.searchParams.get('password');
  if (!username && qUser) username = stripInvisible(qUser);
  if (!password && qPass) password = stripInvisible(qPass);

  // Strip known Xtream/Stalker endpoint filenames or paths from pathname
  const cleanPath = parsed.pathname
    .replace(/\/(player_api\.php|get\.php|xmltv\.php|panel_api\.php|portal\.php|stalker_portal|c|live|movie|series)(\/.*)?$/i, '')
    .replace(/\/+$/, '');

  const baseUrl = `${parsed.protocol}//${parsed.host}${cleanPath}`;
  return { baseUrl, username, password };
}

function safeParseJson(rawText: string): unknown {
  const cleaned = rawText.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Some PHP Xtream panels emit warnings before the JSON payload
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
    let start = -1;
    let end = -1;

    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
      start = firstObj;
      end = cleaned.lastIndexOf('}');
    } else if (firstArr !== -1) {
      start = firstArr;
      end = cleaned.lastIndexOf(']');
    }

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildProtocolAlternatives(baseUrl: string): string[] {
  const list: string[] = [];
  const pushUnique = (u: string) => {
    const clean = u.includes('?') ? u : u.replace(/\/+$/, '');
    if (!list.includes(clean)) list.push(clean);
  };

  pushUnique(baseUrl);
  try {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const suffix = `${cleanPath}${parsed.search}`;
    if (parsed.protocol === 'https:') {
      pushUnique(`http://${parsed.host}${suffix}`);
      if (parsed.port) {
        pushUnique(`https://${parsed.hostname}${suffix}`);
        pushUnique(`http://${parsed.hostname}${suffix}`);
      } else {
        pushUnique(`http://${parsed.hostname}:8080${suffix}`);
      }
    } else {
      pushUnique(`https://${parsed.host}${suffix}`);
      if (parsed.port) {
        pushUnique(`https://${parsed.hostname}${suffix}`);
        pushUnique(`http://${parsed.hostname}${suffix}`);
      } else {
        pushUnique(`http://${parsed.hostname}:8080${suffix}`);
      }
    }
  } catch {
    if (baseUrl.startsWith('https://')) {
      pushUnique(baseUrl.replace(/^https:\/\//i, 'http://'));
    } else if (baseUrl.startsWith('http://')) {
      pushUnique(baseUrl.replace(/^http:\/\//i, 'https://'));
    }
  }
  return list;
}

// ============================================================================
// M3U / M3U8 SMART PARSER (handles huge playlists, multi-language categories,
// quoted attributes with commas, #EXTGRP, #EXTVLCOPT, and automatic Series grouping)
// ============================================================================

function normalizeLiveCategory(rawGroup: string): string {
  const g = (rawGroup || '').toLowerCase();
  if (/sport|futbol|soccer|nba|nfl|ufc|f1|racing|bein|espn|dazn|s sport|tivibu spor/.test(g)) return 'Sports';
  if (/news|haber|cnn|bbc|al jazeera|euronews|sky news|ntv|habert/.test(g)) return 'News';
  if (/movie|film|sinema|cinema|box office|hbo|showtime|vod/.test(g)) return 'Movies';
  if (/docu|belgesel|nat geo|national geographic|discovery|history|science|animal/.test(g)) return 'Documentary';
  if (/kid|çocuk|cocuk|cartoon|disney|nick|anime|baby|junior/.test(g)) return 'Kids';
  if (/music|müzik|muzik|mtv|vh1|radio|radyo|concert/.test(g)) return 'Music';
  if (/entertain|eğlence|eglence|general|ulusal|national|comedy|reality|lifestyle|show/.test(g)) return 'Entertainment';
  if (/usa|uk|de|fr|es|it|tr|ar|nl|ru|int|world|international|europe|asia|latino/.test(g)) return 'International';
  return 'Other';
}

function extractM3UAttributes(extinfLine: string): { attrs: Record<string, string>; displayTitle: string } {
  const attrs: Record<string, string> = {};

  // Find the comma separating attributes from the display title (outside quotes!)
  let inQuote = false;
  let quoteChar = '';
  let splitIdx = -1;

  for (let i = 0; i < extinfLine.length; i++) {
    const ch = extinfLine[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ',') {
      splitIdx = i;
      break;
    }
  }

  const headerPart = splitIdx >= 0 ? extinfLine.slice(0, splitIdx) : extinfLine;
  const displayTitle = splitIdx >= 0 ? extinfLine.slice(splitIdx + 1).trim() : '';

  // Parse key="value", key='value', or key=unquotedValue
  const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(headerPart)) !== null) {
    const key = match[1].toLowerCase();
    const val = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    attrs[key] = val;
  }

  return { attrs, displayTitle };
}

function detectSeriesPattern(title: string): { seriesName: string; season: number; episode: number } | null {
  const patterns: RegExp[] = [
    // Standard & punctuated S01E01, S01 E01, S01.E01, S01-E01, S01_E01, Turkish S01B01 / S01 B01
    /^(.+?)\s*[-–:|]?\s*S(\d{1,2})[\s._-]*[EB](\d{1,3})\b/i,
    // 1x01, 02x14
    /^(.+?)\s*[-–:|]?\s*(\d{1,2})x(\d{1,3})\b/i,
    // Season 1 Episode 2 / Sezon 1 - Bölüm 2 / Sezon 1 : Bolum 2
    /^(.+?)\s*[-–:|]?\s*(?:Season|Sezon)\s*(\d{1,2})\s*[-–:|.,\s]*\s*(?:Episode|Ep|Bölüm|Bolum|Bol)\.?\s*(\d{1,3})\b/i,
    // Turkish ordinal form: 1. Sezon 2. Bölüm / 1.Sezon 2.Bolum / 1. Season 2. Episode
    /^(.+?)\s*[-–:|]?\s*(\d{1,2})\.?\s*(?:Sezon|Season)\s*[-–:|.,\s]*\s*(\d{1,3})\.?\s*(?:Bölüm|Bolum|Bol|Episode|Ep)\b/i,
  ];

  for (const regex of patterns) {
    const m = title.match(regex);
    if (m) {
      const seriesName = m[1].replace(/[-–:|.\s]+$/, '').trim();
      const season = Math.max(1, parseInt(m[2], 10));
      const episode = Math.max(1, parseInt(m[3], 10));
      if (seriesName.length >= 2) {
        return { seriesName, season, episode };
      }
    }
  }
  return null;
}

function classifyM3UEntry(url: string, title: string, group: string): 'live' | 'movie' | 'series' {
  const lowerUrl = url.toLowerCase();
  const lowerGroup = group.toLowerCase();

  // Explicit URL patterns (Xtream M3U standard)
  if (/\/series\//i.test(lowerUrl)) return 'series';
  if (/\/movie\//i.test(lowerUrl)) return 'movie';

  // Explicit Series episode pattern in title
  if (detectSeriesPattern(title)) return 'series';

  // Direct video file extensions (non-live VOD)
  const pathPart = lowerUrl.split('?')[0];
  if (/\.(mp4|mkv|avi|mov|m4v|wmv|flv|webm|mpg|mpeg|divx)$/.test(pathPart)) {
    return 'movie';
  }

  // Group-title heuristics when URL has no extension
  if (/\b(series|dizi|diziler|tv shows|shows|seasons|sezon)\b/i.test(lowerGroup)) {
    return 'series';
  }
  if (/\b(vod|movies|movie|film|filmler|sinema|cinema|4k movies|boxset)\b/i.test(lowerGroup) && !/live|tv|channel|kanal/.test(lowerGroup)) {
    return 'movie';
  }

  return 'live';
}

function extractYearFromTitle(title: string): { cleanName: string; year?: string } {
  const m = title.match(/[\(\[\s]((?:19|20)\d{2})[\)\]]?\s*$/);
  if (m) {
    return {
      cleanName: title.slice(0, m.index).replace(/[-–:\s]+$/, '').trim() || title,
      year: m[1],
    };
  }
  return { cleanName: title };
}

function deriveXtreamAltLiveUrl(streamUrl: string): string | undefined {
  try {
    const parsed = new URL(streamUrl);
    const pathname = parsed.pathname;
    // Standard Xtream M3U live URL formats:
    // 1. /live/user/pass/12345.ts -> /live/user/pass/12345.m3u8
    // 2. /live/user/pass/12345.m3u8 -> /live/user/pass/12345.ts
    // 3. /user/pass/12345 (extensionless TS) -> /live/user/pass/12345.m3u8
    if (/^\/live\/[^/]+\/[^/]+\/\d+\.ts$/i.test(pathname)) {
      return `${parsed.origin}${pathname.replace(/\.ts$/i, '.m3u8')}${parsed.search}`;
    }
    if (/^\/live\/[^/]+\/[^/]+\/\d+\.m3u8$/i.test(pathname)) {
      return `${parsed.origin}${pathname.replace(/\.m3u8$/i, '.ts')}${parsed.search}`;
    }
    if (/^\/live\/[^/]+\/[^/]+\/\d+$/i.test(pathname)) {
      return `${parsed.origin}${pathname}.m3u8${parsed.search}`;
    }
    const bareXtream = pathname.match(/^\/([^/]+)\/([^/]+)\/(\d+)$/);
    if (bareXtream && bareXtream[1] !== 'movie' && bareXtream[1] !== 'series' && bareXtream[1] !== 'live') {
      return `${parsed.origin}/live/${bareXtream[1]}/${bareXtream[2]}/${bareXtream[3]}.m3u8${parsed.search}`;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function parseM3UContent(content: string, playlistId: string) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  let detectedEpgUrl: string | undefined;
  const channels: Array<Record<string, unknown>> = [];
  const movies: Array<Record<string, unknown>> = [];
  const seriesMap = new Map<
    string,
    {
      id: string;
      name: string;
      poster?: string;
      backdrop?: string;
      category: string;
      year?: string;
      seasonsMap: Map<number, Array<Record<string, unknown>>>;
    }
  >();

  let currentAttrs: Record<string, string> | null = null;
  let currentTitle = '';
  let currentGroupOverride = '';
  let currentUserAgent = '';
  let currentReferer = '';
  let channelNum = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const { attrs } = extractM3UAttributes(line);
      const tvgUrl = attrs['url-tvg'] || attrs['x-tvg-url'] || attrs['tvg-url'];
      if (tvgUrl) {
        detectedEpgUrl = tvgUrl.split(',')[0]?.trim();
      }
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const { attrs, displayTitle } = extractM3UAttributes(line);
      currentAttrs = attrs;
      currentTitle = displayTitle || attrs['tvg-name'] || 'Untitled Stream';
      currentGroupOverride = '';
      currentUserAgent = '';
      currentReferer = '';
      continue;
    }

    if (line.startsWith('#EXTGRP:')) {
      currentGroupOverride = line.slice('#EXTGRP:'.length).trim();
      continue;
    }

    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      if (opt.toLowerCase().startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice('http-user-agent='.length).trim();
      } else if (opt.toLowerCase().startsWith('http-referrer=')) {
        currentReferer = opt.slice('http-referrer='.length).trim();
      }
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    // Stream URL line
    if (!/^https?:\/\//i.test(line)) {
      currentAttrs = null;
      continue;
    }

    const streamUrl = line;
    const attrs = currentAttrs || {};
    const group = currentGroupOverride || attrs['group-title'] || 'General';
    const logo = attrs['tvg-logo'] || undefined;
    const epgId = attrs['tvg-id'] || attrs['tvg-name'] || undefined;
    const country = attrs['tvg-country'] || undefined;
    const language = attrs['tvg-language'] || undefined;
    const title = currentTitle || attrs['tvg-name'] || 'Untitled Stream';

    const kind = classifyM3UEntry(streamUrl, title, group);

    if (kind === 'series') {
      const parsedEp = detectSeriesPattern(title);
      const rawSeriesName = parsedEp ? parsedEp.seriesName : title;
      const { cleanName, year } = extractYearFromTitle(rawSeriesName);
      const seasonNumber = parsedEp ? parsedEp.season : 1;
      const episodeNumber = parsedEp ? parsedEp.episode : 1;
      const seriesKey = `${cleanName.toLowerCase()}::${group.toLowerCase()}`;

      let sEntry = seriesMap.get(seriesKey);
      if (!sEntry) {
        sEntry = {
          id: `${playlistId}_ser_${seriesMap.size + 1}`,
          name: cleanName,
          poster: logo,
          backdrop: logo,
          category: group,
          year,
          seasonsMap: new Map(),
        };
        seriesMap.set(seriesKey, sEntry);
      }

      if (!sEntry.poster && logo) sEntry.poster = logo;
      const epList = sEntry.seasonsMap.get(seasonNumber) || [];
      epList.push({
        id: `${sEntry.id}_s${seasonNumber}_e${episodeNumber}_${epList.length + 1}`,
        seriesId: sEntry.id,
        seasonNumber,
        episodeNumber,
        title,
        streamUrl,
        thumbnail: logo,
        customUserAgent: currentUserAgent || undefined,
        customReferer: currentReferer || undefined,
      });
      sEntry.seasonsMap.set(seasonNumber, epList);
    } else if (kind === 'movie') {
      const { cleanName, year } = extractYearFromTitle(title);
      const extMatch = streamUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
      movies.push({
        id: `${playlistId}_mov_${movies.length + 1}`,
        name: cleanName,
        streamUrl,
        containerExtension: extMatch ? extMatch[1].toLowerCase() : undefined,
        poster: logo,
        backdrop: logo,
        category: group,
        genre: group,
        year,
        language,
        country,
        customUserAgent: currentUserAgent || undefined,
        customReferer: currentReferer || undefined,
      });
    } else {
      const parsedNum = attrs['tvg-chno'] ? parseInt(attrs['tvg-chno'], 10) : NaN;
      const num = !Number.isNaN(parsedNum) && parsedNum > 0 ? parsedNum : channelNum++;
      const altStreamUrl = deriveXtreamAltLiveUrl(streamUrl);
      const catchupDays = attrs['catchup-days'] ? parseInt(attrs['catchup-days'], 10) : undefined;

      channels.push({
        id: `${playlistId}_ch_${channels.length + 1}`,
        num,
        name: title,
        streamUrl,
        altStreamUrl,
        logo,
        category: group,
        normalizedCategory: normalizeLiveCategory(group),
        epgId,
        country,
        language,
        catchup: Boolean(attrs['catchup'] || attrs['catchup-source']),
        catchupSource: attrs['catchup-source'] || undefined,
        catchupDays: catchupDays && !Number.isNaN(catchupDays) ? catchupDays : undefined,
        customUserAgent: currentUserAgent || undefined,
        customReferer: currentReferer || undefined,
      });
    }

    currentAttrs = null;
    currentTitle = '';
    currentGroupOverride = '';
    currentUserAgent = '';
    currentReferer = '';
  }

  const series = Array.from(seriesMap.values()).map((s) => {
    const seasons = Array.from(s.seasonsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, eps]) => ({
        seasonNumber,
        name: `Season ${seasonNumber}`,
        episodes: eps.sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber)),
      }));

    return {
      id: s.id,
      name: s.name,
      poster: s.poster,
      backdrop: s.backdrop,
      category: s.category,
      genre: s.category,
      year: s.year,
      seasons,
      seasonsLoaded: true,
    };
  });

  return {
    detectedEpgUrl,
    channels,
    movies,
    series,
  };
}

// ============================================================================
// XMLTV EPG PARSER (lightweight streaming regex parser for fast response)
// ============================================================================

function parseXmltvDate(dateStr: string): number {
  // Format: YYYYMMDDHHMMSS +0000 or YYYYMMDDHHMMSS
  const m = dateStr.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
  if (!m) return 0;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = parseInt(m[6], 10);

  let utcMs = Date.UTC(year, month, day, hour, min, sec);
  if (m[7]) {
    const sign = m[7] === '+' ? 1 : -1;
    const offH = parseInt(m[8], 10);
    const offM = parseInt(m[9], 10);
    utcMs -= sign * (offH * 60 + offM) * 60 * 1000;
  }
  return utcMs;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseXmltvPrograms(xml: string): Record<string, Array<Record<string, unknown>>> {
  const programs: Record<string, Array<Record<string, unknown>>> = {};
  const now = Date.now();
  const minWindow = now - 6 * 3600 * 1000;
  const maxWindow = now + 30 * 3600 * 1000;

  const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = progRegex.exec(xml)) !== null && count < 60000) {
    const attrStr = match[1];
    const inner = match[2];

    const startM = attrStr.match(/start="([^"]+)"/i);
    const stopM = attrStr.match(/stop="([^"]+)"/i);
    const chanM = attrStr.match(/channel="([^"]+)"/i);
    if (!startM || !stopM || !chanM) continue;

    const start = parseXmltvDate(startM[1]);
    const end = parseXmltvDate(stopM[1]);
    if (!start || !end || end < minWindow || start > maxWindow) continue;

    const titleM = inner.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleM) continue;
    const descM = inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);
    const catM = inner.match(/<category[^>]*>([\s\S]*?)<\/category>/i);

    const channelId = decodeXmlEntities(chanM[1]).toLowerCase().trim();
    if (!programs[channelId]) programs[channelId] = [];

    programs[channelId].push({
      id: `${channelId}_${start}`,
      channelId,
      title: decodeXmlEntities(titleM[1].trim()),
      description: descM ? decodeXmlEntities(descM[1].trim()) : undefined,
      category: catM ? decodeXmlEntities(catM[1].trim()) : undefined,
      start,
      end,
    });
    count++;
  }

  for (const key of Object.keys(programs)) {
    programs[key].sort((a, b) => Number(a.start) - Number(b.start));
  }

  return programs;
}

// ============================================================================
// HLS & DASH MANIFEST REWRITER (Solves Mixed Content, CORS & Relative Segments)
// ============================================================================

function makeProxyUrl(
  targetUrl: string,
  ua?: string,
  ref?: string,
  extra?: { manifestOnly?: boolean; clientIp?: string; acceptLanguage?: string; pathHint?: string }
): string {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  if (ua) params.set('ua', ua);
  if (ref) params.set('ref', ref);
  if (extra?.manifestOnly) params.set('manifestOnly', '1');
  if (extra?.clientIp) params.set('_cip', extra.clientIp);
  if (extra?.acceptLanguage) params.set('_lang', extra.acceptLanguage);
  const basePath = extra?.pathHint ? `/api/proxy/stream/${extra.pathHint}` : '/api/proxy/stream';
  return `${basePath}?${params.toString()}`;
}

function guessHlsHintFilename(absUrl: string, kind: 'playlist' | 'segment' | 'key' | 'auto'): string {
  if (kind === 'playlist') return 'playlist.m3u8';
  if (kind === 'key') return 'enc.key';
  const clean = absUrl.split('?')[0].toLowerCase();
  if (clean.endsWith('.m3u8') || clean.endsWith('.m3u')) return 'playlist.m3u8';
  if (clean.endsWith('.m4s')) return 'segment.m4s';
  if (clean.endsWith('.mp4')) return 'segment.mp4';
  if (clean.endsWith('.aac')) return 'segment.aac';
  if (clean.endsWith('.vtt')) return 'subtitle.vtt';
  if (clean.endsWith('.key')) return 'enc.key';
  return 'segment.ts';
}

function rewriteHlsManifest(
  manifest: string,
  baseUrl: string,
  ua?: string,
  ref?: string,
  manifestOnly = false
): { text: string; hasExternalHttps: boolean } {
  let hasExternalHttps = false;
  let baseHost = '';
  try {
    baseHost = new URL(baseUrl).host.toLowerCase();
  } catch {
    // ignore
  }

  const maybeKeepDirect = (absUrl: string, kind: 'playlist' | 'segment' | 'key' | 'auto' = 'auto'): string => {
    const isHttps = absUrl.toLowerCase().startsWith('https://');
    if (isHttps) {
      try {
        if (new URL(absUrl).host.toLowerCase() !== baseHost) {
          hasExternalHttps = true;
        }
      } catch {
        // ignore
      }
      if (manifestOnly) {
        return absUrl;
      }
    }
    return makeProxyUrl(absUrl, ua, ref, {
      manifestOnly: manifestOnly || undefined,
      pathHint: guessHlsHintFilename(absUrl, kind),
    });
  };

  const lines = manifest.split(/\r?\n/);
  let nextLineIsVariantPlaylist = false;
  const rewritten = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        nextLineIsVariantPlaylist = true;
      }
      // Rewrite URI="..." inside #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, #EXT-X-PART
      if (line.includes('URI=')) {
        const uriKind: 'playlist' | 'segment' | 'key' | 'auto' = line.startsWith('#EXT-X-KEY')
          ? 'key'
          : line.startsWith('#EXT-X-MEDIA') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')
          ? 'playlist'
          : 'auto';
        return line.replace(/URI=(["'])([^"']+)\1/gi, (_m, quote: string, uriVal: string) => {
          try {
            const abs = new URL(uriVal, baseUrl).toString();
            return `URI=${quote}${maybeKeepDirect(abs, uriKind)}${quote}`;
          } catch {
            return `URI=${quote}${uriVal}${quote}`;
          }
        });
      }
      return rawLine;
    }

    // Media segment or variant sub-playlist line
    const lineKind: 'playlist' | 'segment' = nextLineIsVariantPlaylist ? 'playlist' : 'segment';
    nextLineIsVariantPlaylist = false;
    try {
      const abs = new URL(line, baseUrl).toString();
      return maybeKeepDirect(abs, lineKind);
    } catch {
      return rawLine;
    }
  });

  return { text: rewritten.join('\n'), hasExternalHttps };
}

function rewriteDashManifest(manifest: string, baseUrl: string, _ua?: string, _ref?: string): string {
  const baseDir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  const b64Dir = Buffer.from(baseDir, 'utf8').toString('base64url');
  const proxyPrefix = `/api/proxy/dash/${b64Dir}/`;

  if (/<BaseURL>/i.test(manifest)) {
    return manifest.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_m, urlVal: string) => {
      try {
        const abs = new URL(urlVal.trim(), baseUrl).toString();
        const absDir = abs.endsWith('/') ? abs : `${abs}/`;
        const b64 = Buffer.from(absDir, 'utf8').toString('base64url');
        return `<BaseURL>/api/proxy/dash/${b64}/</BaseURL>`;
      } catch {
        return _m;
      }
    });
  }

  return manifest.replace(/(<MPD\b[^>]*>)/i, `$1\n  <BaseURL>${proxyPrefix}</BaseURL>`);
}

function guessVideoContentType(urlStr: string, upstreamContentType?: string): string {
  const lowerCt = (upstreamContentType || '').toLowerCase();
  const cleanPath = urlStr.split('?')[0].toLowerCase();

  if (lowerCt && !lowerCt.includes('octet-stream') && !lowerCt.includes('text/plain')) {
    return upstreamContentType!;
  }

  if (cleanPath.endsWith('.m3u8') || cleanPath.endsWith('.m3u')) return 'application/vnd.apple.mpegurl';
  if (cleanPath.endsWith('.mpd')) return 'application/dash+xml';
  if (cleanPath.endsWith('.mp4') || cleanPath.endsWith('.m4v')) return 'video/mp4';
  if (cleanPath.endsWith('.mkv')) return 'video/x-matroska';
  if (cleanPath.endsWith('.webm')) return 'video/webm';
  if (cleanPath.endsWith('.ts') || cleanPath.endsWith('.m2ts')) return 'video/mp2t';
  if (cleanPath.endsWith('.mp3')) return 'audio/mpeg';
  if (cleanPath.endsWith('.aac')) return 'audio/aac';
  if (cleanPath.endsWith('.vtt')) return 'text/vtt';

  return upstreamContentType || 'application/octet-stream';
}

function isHlsCandidate(urlStr: string, contentType?: string, headText?: string): boolean {
  const ct = (contentType || '').toLowerCase();
  const cleanPath = urlStr.split('?')[0].toLowerCase();
  if (headText && headText.trimStart().startsWith('#EXTM3U')) return true;
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return true;
  if (cleanPath.endsWith('.m3u8')) return true;
  return false;
}

function isDashCandidate(urlStr: string, contentType?: string, headText?: string): boolean {
  const ct = (contentType || '').toLowerCase();
  const cleanPath = urlStr.split('?')[0].toLowerCase();
  if (ct.includes('dash+xml') || ct.includes('dash.mpd') || cleanPath.endsWith('.mpd')) return true;
  if (headText && headText.includes('<MPD')) return true;
  return false;
}

// ============================================================================
// EXPRESS SERVER BOOTSTRAP
// ============================================================================

async function startServer() {
  const app = express();
  const ffmpegAvailable = await checkBinaryAvailable(FFMPEG_BIN);
  const ffprobeAvailable = await checkBinaryAvailable(FFPROBE_BIN);

  app.use(express.json({ limit: '80mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Health & capability endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      ffmpegAvailable,
      ffprobeAvailable,
      activeTranscodes: activeFfmpegProcesses.size,
    });
  });

  // ==========================================================================
  // 1. XTREAM CODES AUTHENTICATION (Fixes HTTP/CORS/SSL/UA/444/WAF/Redirects
  //    + Automatic panel_api.php & get.php M3U Bridge Fallback!)
  // ==========================================================================
  app.post('/api/xtream/auth', async (req: Request, res: Response) => {
    try {
      const { serverUrl, username, password, userAgent } = req.body as {
        serverUrl?: string;
        username?: string;
        password?: string;
        userAgent?: string;
      };

      const normalized = normalizeXtreamInput(serverUrl || '', username || '', password || '');
      if (!normalized.username || !normalized.password) {
        res.status(400).json({
          ok: false,
          error: 'Username and password are required for Xtream Codes login.',
        });
        return;
      }

      const clientContext = {
        clientIp: extractClientIp(req),
        acceptLanguage: extractAcceptLanguage(req),
      };

      const baseCandidates = buildProtocolAlternatives(normalized.baseUrl);
      const diagnostics: string[] = [];
      let explicitAuthRejection: { reason: string; base: string } | null = null;
      const encUser = encodeURIComponent(normalized.username);
      const encPass = encodeURIComponent(normalized.password);

      for (const candidateBase of baseCandidates) {
        const apiUrl = `${candidateBase}/player_api.php?username=${encUser}&password=${encPass}`;

        try {
          let result = await fetchTextSmart(apiUrl, userAgent, 15000, 10 * 1024 * 1024, clientContext);
          let parsed = safeParseJson(result.text) as Record<string, unknown> | null;

          // Fallback 1: Try POST to player_api.php (both Node & curl) if GET didn't yield valid JSON
          if (!parsed) {
            const postBody = new URLSearchParams({
              username: normalized.username,
              password: normalized.password,
            }).toString();

            try {
              const postRes = await fetchBuffer(`${candidateBase}/player_api.php`, {
                method: 'POST',
                userAgent: result.workingUserAgent,
                body: postBody,
                timeoutMs: 12000,
                clientIp: clientContext.clientIp,
                acceptLanguage: clientContext.acceptLanguage,
              });
              const postText = postRes.body.toString('utf8');
              const postParsed = safeParseJson(postText) as Record<string, unknown> | null;
              if (postParsed) {
                parsed = postParsed;
                result = {
                  statusCode: postRes.statusCode,
                  text: postText,
                  finalUrl: postRes.finalUrl,
                  workingUserAgent: result.workingUserAgent,
                  headers: postRes.headers,
                };
              }
            } catch {
              try {
                const curlPost = await curlFetchText(`${candidateBase}/player_api.php`, {
                  method: 'POST',
                  userAgent: result.workingUserAgent,
                  body: postBody,
                  timeoutSec: 12,
                  clientIp: clientContext.clientIp,
                  acceptLanguage: clientContext.acceptLanguage,
                });
                const postParsed = safeParseJson(curlPost.text) as Record<string, unknown> | null;
                if (postParsed) {
                  parsed = postParsed;
                  result = {
                    statusCode: curlPost.statusCode,
                    text: curlPost.text,
                    finalUrl: curlPost.finalUrl,
                    workingUserAgent: result.workingUserAgent,
                    headers: {},
                  };
                }
              } catch {
                // ignore
              }
            }
          }

          // Fallback 2: Some legacy Xtream / XUI panels use panel_api.php
          if (!parsed) {
            try {
              const panelUrl = `${candidateBase}/panel_api.php?username=${encUser}&password=${encPass}`;
              const panelRes = await fetchTextSmart(panelUrl, userAgent, 12000, 10 * 1024 * 1024, clientContext);
              const panelParsed = safeParseJson(panelRes.text) as Record<string, unknown> | null;
              if (panelParsed && typeof panelParsed === 'object' && ('user_info' in panelParsed || 'server_info' in panelParsed)) {
                parsed = panelParsed;
                result = panelRes;
                diagnostics.push(`Connected via panel_api.php on ${candidateBase}`);
              }
            } catch {
              // ignore
            }
          }

          if (!parsed || typeof parsed !== 'object') {
            const snippet = result.text.replace(/\s+/g, ' ').trim().slice(0, 80);
            diagnostics.push(
              `${candidateBase}/player_api.php -> HTTP ${result.statusCode}${snippet ? ` (${snippet})` : ' (empty body)'}`
            );
            continue;
          }

          const userInfo = (parsed.user_info || {}) as Record<string, unknown>;
          const serverInfo = (parsed.server_info || {}) as Record<string, unknown>;

          const authRaw = userInfo.auth;
          const statusStr = String(userInfo.status || '').toLowerCase();
          const hasExplicitDeny = statusStr === 'expired' || statusStr === 'banned' || statusStr === 'disabled';
          const isAuthenticated =
            !hasExplicitDeny &&
            (authRaw === 1 ||
              authRaw === '1' ||
              authRaw === true ||
              Number(authRaw) === 1 ||
              (authRaw === undefined && (statusStr === 'active' || Boolean(userInfo.username))));

          if (!isAuthenticated) {
            let reason = 'Invalid Xtream Codes username or password.';
            if (statusStr === 'expired') reason = 'Your IPTV subscription has expired.';
            else if (statusStr === 'banned' || statusStr === 'disabled') {
              reason = `Account status is "${userInfo.status}". Please contact your provider.`;
            } else if (userInfo.message) {
              reason = String(userInfo.message);
            }

            if (hasExplicitDeny) {
              res.status(401).json({
                ok: false,
                error: reason,
                resolvedServerUrl: candidateBase,
                diagnostics,
              });
              return;
            }

            explicitAuthRejection = { reason, base: candidateBase };
            diagnostics.push(`${candidateBase}/player_api.php returned auth=${String(authRaw)} (${reason})`);
            continue;
          }

          // Derive final effective server URL (preserving redirected origin if panel redirected)
          let effectiveServerUrl = candidateBase;
          let httpsPort: string | undefined;
          let httpsBaseUrl: string | undefined;
          try {
            const finalParsed = new URL(result.finalUrl);
            const cleanFinalPath = finalParsed.pathname
              .replace(/\/(player_api|panel_api)\.php.*$/i, '')
              .replace(/\/+$/, '');
            effectiveServerUrl = `${finalParsed.protocol}//${finalParsed.host}${cleanFinalPath}`;

            const rawHttpsPort = serverInfo.https_port ? String(serverInfo.https_port).trim() : '';
            const numericHttpsPort = Number(rawHttpsPort);
            const rawServerHost =
              typeof serverInfo.url === 'string' && serverInfo.url.trim()
                ? serverInfo.url.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
                : finalParsed.hostname;
            const serverProto = String(serverInfo.server_protocol || '').toLowerCase();

            if (finalParsed.protocol === 'https:') {
              httpsBaseUrl = effectiveServerUrl;
              httpsPort = finalParsed.port || '443';
            } else if (
              rawHttpsPort &&
              !Number.isNaN(numericHttpsPort) &&
              numericHttpsPort > 0 &&
              numericHttpsPort <= 65535
            ) {
              httpsPort = rawHttpsPort;
              const hostPart =
                numericHttpsPort === 443 ? rawServerHost : `${rawServerHost}:${numericHttpsPort}`;
              httpsBaseUrl = `https://${hostPart}${cleanFinalPath}`;
            } else if (serverProto === 'https' && rawServerHost) {
              httpsPort = '443';
              httpsBaseUrl = `https://${rawServerHost}${cleanFinalPath}`;
            }
          } catch {
            // keep candidateBase
          }

          res.json({
            ok: true,
            mode: 'xtream',
            resolvedServerUrl: effectiveServerUrl,
            workingUserAgent: result.workingUserAgent,
            username: normalized.username,
            userInfo: {
              username: String(userInfo.username || normalized.username),
              status: String(userInfo.status || 'Active'),
              expDate: userInfo.exp_date ? String(userInfo.exp_date) : undefined,
              isTrial: userInfo.is_trial !== undefined ? String(userInfo.is_trial) : undefined,
              activeCons: userInfo.active_cons !== undefined ? String(userInfo.active_cons) : undefined,
              maxConnections: userInfo.max_connections !== undefined ? String(userInfo.max_connections) : undefined,
              createdAt: userInfo.created_at ? String(userInfo.created_at) : undefined,
              allowedOutputFormats: Array.isArray(userInfo.allowed_output_formats)
                ? userInfo.allowed_output_formats.map(String)
                : ['m3u8', 'ts'],
              serverTimezone: serverInfo.timezone ? String(serverInfo.timezone) : undefined,
              serverProtocol: serverInfo.server_protocol ? String(serverInfo.server_protocol) : undefined,
              httpsPort,
              httpsBaseUrl,
            },
            serverInfo,
            diagnostics,
          });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          diagnostics.push(`${candidateBase}: ${msg}`);
        }
      }

      // ======================================================================
      // AUTOMATIC M3U BRIDGE FALLBACK (get.php)
      // If provider restricts player_api.php (403/404/WAF/auth:0) while get.php
      // works with the same Xtream credentials, bridge seamlessly via M3U!
      // ======================================================================
      for (const candidateBase of baseCandidates.slice(0, 2)) {
        const getPhpVariants = [
          `${candidateBase}/get.php?username=${encUser}&password=${encPass}&type=m3u_plus&output=m3u8`,
          `${candidateBase}/get.php?username=${encUser}&password=${encPass}&type=m3u_plus&output=ts`,
          `${candidateBase}/get.php?username=${encUser}&password=${encPass}&type=m3u`,
        ];

        for (const m3uCandidateUrl of getPhpVariants) {
          try {
            // Probe first 256KB to verify valid M3U quickly without waiting for a 50MB download twice
            const probeUas = buildUserAgentCandidates(userAgent).slice(0, 4);
            let verifiedUa: string | null = null;
            let verifiedFinalUrl = m3uCandidateUrl;

            for (const ua of probeUas) {
              try {
                const streamRes = await requestRawStream(m3uCandidateUrl, {
                  method: 'GET',
                  userAgent: ua,
                  acceptEncoding: 'identity',
                  timeoutMs: 12000,
                });

                if (streamRes.statusCode >= 200 && streamRes.statusCode < 300) {
                  const headText = await new Promise<string>((resolveHead) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    const finish = () => {
                      streamRes.stream.destroy();
                      streamRes.req.destroy();
                      resolveHead(Buffer.concat(chunks).toString('utf8'));
                    };
                    streamRes.stream.on('data', (c: Buffer) => {
                      chunks.push(c);
                      size += c.length;
                      if (size >= 4096) finish();
                    });
                    streamRes.stream.on('end', finish);
                    streamRes.stream.on('error', finish);
                  });

                  if (headText.includes('#EXTM3U') || headText.includes('#EXTINF')) {
                    verifiedUa = ua;
                    verifiedFinalUrl = streamRes.finalUrl;
                    break;
                  }
                } else {
                  streamRes.stream.resume();
                }
              } catch (e) {
                if (e instanceof Error && isUnreachableHostError(e)) break;
              }
            }

            if (!verifiedUa) {
              // Also try validated curl probe (stops after 4KB) in case panel WAF blocks Node TLS fingerprint
              for (const ua of [probeUas[0], FALLBACK_USER_AGENTS[5]]) {
                try {
                  const streamRes = await curlRequestRawStream(m3uCandidateUrl, {
                    method: 'GET',
                    userAgent: ua,
                    timeoutMs: 12000,
                  });
                  const headText = await new Promise<string>((resolveCurl) => {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    const done = () => {
                      streamRes.stream.destroy();
                      streamRes.req.destroy();
                      resolveCurl(Buffer.concat(chunks).toString('utf8'));
                    };
                    streamRes.stream.on('data', (c: Buffer) => {
                      chunks.push(c);
                      bytes += c.length;
                      if (bytes >= 4096) done();
                    });
                    streamRes.stream.on('end', done);
                    streamRes.stream.on('error', done);
                  });
                  if (headText.includes('#EXTM3U') || headText.includes('#EXTINF')) {
                    verifiedUa = ua;
                    verifiedFinalUrl = streamRes.finalUrl;
                    rememberHostTransport(m3uCandidateUrl, {
                      preferCurl: true,
                      userAgent: ua,
                      preferNoXff: true,
                    });
                    break;
                  }
                } catch {
                  // ignore
                }
              }
            }

            if (verifiedUa) {
              diagnostics.push(`player_api.php unavailable — bridged automatically via get.php M3U endpoint`);
              res.json({
                ok: true,
                mode: 'm3u_fallback',
                m3uUrl: verifiedFinalUrl,
                resolvedServerUrl: candidateBase,
                workingUserAgent: verifiedUa,
                username: normalized.username,
                userInfo: {
                  username: normalized.username,
                  status: 'Active (M3U Bridge)',
                  allowedOutputFormats: ['m3u8', 'ts'],
                },
                diagnostics,
              });
              return;
            }
          } catch {
            // try next variant
          }
        }
      }

      if (explicitAuthRejection) {
        res.status(401).json({
          ok: false,
          error: explicitAuthRejection.reason,
          resolvedServerUrl: explicitAuthRejection.base,
          diagnostics,
        });
        return;
      }

      res.status(502).json({
        ok: false,
        error:
          'Unable to connect to the Xtream Codes server. Check Server URL/port, credentials, or whether the provider blocks cloud server IPs.',
        diagnostics,
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid Xtream request parameters',
      });
    }
  });

  // ==========================================================================
  // 2. XTREAM CODES CATALOG & METADATA ACTION PROXY
  // ==========================================================================
  app.post('/api/xtream/action', async (req: Request, res: Response) => {
    try {
      const { serverUrl, username, password, action, params, userAgent } = req.body as {
        serverUrl: string;
        username: string;
        password: string;
        action: string;
        params?: Record<string, string>;
        userAgent?: string;
      };

      const normalized = normalizeXtreamInput(serverUrl, username, password);
      const query = new URLSearchParams({
        username: normalized.username,
        password: normalized.password,
        action,
        ...(params || {}),
      });

      const baseCandidates = buildProtocolAlternatives(normalized.baseUrl);
      const clientContext = {
        clientIp: extractClientIp(req),
        acceptLanguage: extractAcceptLanguage(req),
      };
      const isDetailAction = action === 'get_series_info' || action === 'get_vod_info';

      let lastStatus = 502;
      let lastError = `Failed to fetch Xtream action ${action}`;
      let gotNonJson = false;

      for (const candidateBase of baseCandidates) {
        const apiUrl = `${candidateBase}/player_api.php?${query.toString()}`;
        try {
          const result = await fetchTextSmart(apiUrl, userAgent, 30000, 80 * 1024 * 1024, clientContext);

          if (result.statusCode >= 400) {
            lastStatus = result.statusCode;
            lastError = `Provider returned HTTP ${result.statusCode} for ${action}`;
            continue;
          }

          const data = safeParseJson(result.text);
          if (data !== null) {
            res.json({ ok: true, data });
            return;
          }

          gotNonJson = true;
          lastStatus = 502;
          lastError = `Provider returned non-JSON response for ${action}`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (gotNonJson && !isDetailAction) {
        res.json({ ok: true, data: [] });
        return;
      }

      res.status(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502).json({
        ok: false,
        error: lastError,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch Xtream data',
      });
    }
  });

  // ==========================================================================
  // 3. M3U / M3U8 URL FETCH & SERVER-SIDE PARSER (Fixes CORS, Mixed-Content,
  //    User-Agent blocks, redirects, and 50MB+ M3U memory issues!)
  // ==========================================================================
  app.post('/api/m3u/fetch', async (req: Request, res: Response) => {
    try {
      const { url, content, playlistId, userAgent } = req.body as {
        url?: string;
        content?: string;
        playlistId?: string;
        userAgent?: string;
      };

      const id = playlistId || `pl_${Date.now()}`;
      let rawText = content || '';
      let workingUserAgent = userAgent || FALLBACK_USER_AGENTS[0];
      let finalUrl = url || '';

      if (!rawText) {
        if (!url || !url.trim()) {
          res.status(400).json({ ok: false, error: 'Please provide an M3U / M3U8 URL or upload a file.' });
          return;
        }

        let target = url.trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:\/\//i.test(target)) {
          res.status(400).json({ ok: false, error: 'Only http:// and https:// URLs are allowed.' });
          return;
        }
        if (!/^https?:\/\//i.test(target)) {
          target = `http://${target}`;
        }
        try {
          await assertSafeUpstreamUrl(target);
        } catch (err) {
          res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Blocked URL' });
          return;
        }

        const alternatives = buildProtocolAlternatives(target);
        let fetched: Awaited<ReturnType<typeof fetchTextSmart>> | null = null;
        let lastErr = '';

        const clientContext = {
          clientIp: extractClientIp(req),
          acceptLanguage: extractAcceptLanguage(req),
        };
        for (const alt of alternatives) {
          try {
            const r = await fetchTextSmart(alt, userAgent, 35000, 85 * 1024 * 1024, clientContext);
            if (r.statusCode >= 200 && r.statusCode < 300) {
              fetched = r;
              break;
            }
            lastErr = `Provider returned HTTP ${r.statusCode}`;
          } catch (err) {
            if (err instanceof BlockedUrlError) {
              res.status(400).json({ ok: false, error: err.message });
              return;
            }
            lastErr = err instanceof Error ? err.message : String(err);
          }
        }

        if (!fetched) {
          res.status(502).json({
            ok: false,
            error: `Could not download M3U playlist (${lastErr || 'connection failed'}). Verify the URL and provider status.`,
          });
          return;
        }

        rawText = fetched.text;
        workingUserAgent = fetched.workingUserAgent;
        finalUrl = fetched.finalUrl;
      }

      if (!rawText.includes('#EXTINF') && !rawText.includes('#EXTM3U') && !/^https?:\/\//m.test(rawText)) {
        res.status(422).json({
          ok: false,
          error:
            'The URL did not return a valid M3U/M3U8 playlist (the provider may have returned an error page or expired link).',
        });
        return;
      }

      const parsed = parseM3UContent(rawText, id);
      if (parsed.channels.length === 0 && parsed.movies.length === 0 && parsed.series.length === 0) {
        res.status(422).json({
          ok: false,
          error: 'The playlist was downloaded, but no playable streams were found inside it.',
        });
        return;
      }

      res.json({
        ok: true,
        finalUrl,
        workingUserAgent,
        detectedEpgUrl: parsed.detectedEpgUrl,
        channels: parsed.channels,
        movies: parsed.movies,
        series: parsed.series,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to parse M3U playlist',
      });
    }
  });

  // ==========================================================================
  // 4. XMLTV EPG FETCHER & PARSER (Supports .xml and .xml.gz!)
  // ==========================================================================
  app.post('/api/epg/fetch', async (req: Request, res: Response) => {
    try {
      const { url, userAgent } = req.body as { url?: string; userAgent?: string };
      if (!url || !url.trim()) {
        res.status(400).json({ ok: false, error: 'EPG URL is required' });
        return;
      }

      const rawTarget = url.trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) && !/^https?:\/\//i.test(rawTarget)) {
        res.status(400).json({ ok: false, error: 'Only http:// and https:// URLs are allowed.' });
        return;
      }
      const target = /^https?:\/\//i.test(rawTarget) ? rawTarget : `http://${rawTarget}`;
      await assertSafeUpstreamUrl(target);
      const result = await fetchTextSmart(target, userAgent, 30000, 90 * 1024 * 1024);

      if (result.statusCode >= 400) {
        res.status(result.statusCode).json({
          ok: false,
          error: `EPG server returned HTTP ${result.statusCode}`,
        });
        return;
      }

      const programs = parseXmltvPrograms(result.text);
      const channelCount = Object.keys(programs).length;
      res.json({ ok: true, channelCount, programs });
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch XMLTV EPG',
      });
    }
  });

  // ==========================================================================
  // 5a. DIRECT-HTTPS & REDIRECT RESOLVER (Geo-Lock Bypass Helper)
  //     Discovers 302 -> https:// CDN targets & HTTPS panel ports WITHOUT
  //     fetching geo-blocked HTTPS CDNs from the European cloud server!
  // ==========================================================================
  app.get('/api/proxy/resolve', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    const altUrl = String(req.query.altUrl || '');
    const httpsHint = String(req.query.httpsUrl || '');
    const ua = String(req.query.ua || FALLBACK_USER_AGENTS[0]);
    const ref = String(req.query.ref || '');
    const clientIp = extractClientIp(req);
    const acceptLanguage = extractAcceptLanguage(req);

    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Invalid URL' });
      return;
    }

    const directHttpsUrls: string[] = [];
    const pushHttps = (u?: string) => {
      if (!u) return;
      const clean = sanitizeTargetUrl(u);
      if (clean.toLowerCase().startsWith('https://') && !directHttpsUrls.includes(clean)) {
        directHttpsUrls.push(clean);
      }
    };

    let redirectedUrl: string | undefined;
    let corsAllowed = false;
    let geoBlockedOnProxy = false;
    let upstreamStatus = 0;
    let upstreamMessage: string | undefined;

    if (targetUrl.toLowerCase().startsWith('https://')) pushHttps(targetUrl);
    if (altUrl.toLowerCase().startsWith('https://')) pushHttps(altUrl);
    if (httpsHint.toLowerCase().startsWith('https://')) pushHttps(httpsHint);

    // Step 1: Single-hop non-following probe on targetUrl (and altUrl if .m3u8) to catch
    // 301/302/307 -> https:// broadcaster CDNs before Belgium IP touches the CDN!
    const hopTargets = [targetUrl];
    if (altUrl && altUrl.toLowerCase().includes('.m3u8') && !hopTargets.includes(altUrl)) {
      hopTargets.push(altUrl);
    }

    for (const urlToInspect of hopTargets) {
      if (isBlockedMetadataHost(urlToInspect)) continue;
      const isM3u8 = urlToInspect.toLowerCase().split('?')[0].endsWith('.m3u8');
      // Use HEAD first so we never open an active TS streaming connection slot on max_connections: 1 accounts
      const methods: Array<'HEAD' | 'GET'> = isM3u8 ? ['HEAD', 'GET'] : ['HEAD'];

      for (const method of methods) {
        try {
          const hop = await requestRawStream(urlToInspect, {
            method,
            userAgent: ua,
            referer: ref,
            maxRedirects: 0,
            timeoutMs: 3200,
            clientIp,
            acceptLanguage,
          });
          upstreamStatus = hop.statusCode;

          if (hop.headers['access-control-allow-origin']) {
            corsAllowed = true;
          }

          if ([301, 302, 303, 307, 308].includes(hop.statusCode) && hop.headers.location) {
            hop.stream.resume();
            try {
              const resolvedLoc = new URL(hop.headers.location.trim().replace(/ /g, '%20'), urlToInspect).toString();
              redirectedUrl = resolvedLoc;
              if (resolvedLoc.toLowerCase().startsWith('https://')) {
                pushHttps(resolvedLoc);
              }
            } catch {
              // ignore
            }
            break;
          }

          // If small text/error body on GET or 4xx, check for geo-restriction clues
          if (method === 'GET' || hop.statusCode >= 400) {
            const snippet = await new Promise<string>((resolveSnippet) => {
              const chunks: Buffer[] = [];
              let len = 0;
              const done = () => {
                hop.stream.destroy();
                hop.req.destroy();
                resolveSnippet(Buffer.concat(chunks).toString('utf8'));
              };
              hop.stream.on('data', (c: Buffer) => {
                chunks.push(c);
                len += c.length;
                if (len >= 2048) done();
              });
              hop.stream.on('end', done);
              hop.stream.on('error', done);
            });

            const geoCheck = detectGeoRestriction(hop.statusCode, hop.headers, snippet);
            if (geoCheck.geoBlocked) {
              geoBlockedOnProxy = true;
              upstreamMessage = geoCheck.reason;
            }
          } else {
            hop.stream.resume();
            const geoCheck = detectGeoRestriction(hop.statusCode, hop.headers, '');
            if (geoCheck.geoBlocked) {
              geoBlockedOnProxy = true;
              upstreamMessage = geoCheck.reason;
            }
          }

          if (hop.statusCode !== 405 && hop.statusCode !== 501) {
            break;
          }
        } catch {
          // continue
        }
      }
    }

    // Step 2: If target is http://, quickly test if the same host responds on https:// (port 443)
    if (targetUrl.toLowerCase().startsWith('http://') && directHttpsUrls.length === 0) {
      const httpsProbes: string[] = [];
      try {
        const u = new URL(targetUrl);
        httpsProbes.push(`https://${u.hostname}${u.pathname}${u.search}`);
        if (altUrl && altUrl.toLowerCase().startsWith('http://')) {
          const au = new URL(altUrl);
          const altHttps = `https://${au.hostname}${au.pathname}${au.search}`;
          if (!httpsProbes.includes(altHttps)) httpsProbes.push(altHttps);
        }
      } catch {
        // ignore
      }

      await Promise.all(
        httpsProbes.slice(0, 2).map(async (candidate) => {
          try {
            const probe = await requestRawStream(candidate, {
              method: 'HEAD',
              userAgent: ua,
              referer: ref,
              maxRedirects: 0,
              timeoutMs: 2200,
              clientIp,
              acceptLanguage,
            });
            probe.stream.resume();
            if (probe.statusCode >= 200 && probe.statusCode < 400) {
              if (probe.headers['access-control-allow-origin']) corsAllowed = true;
              if ([301, 302, 303, 307, 308].includes(probe.statusCode) && probe.headers.location) {
                try {
                  const loc = new URL(probe.headers.location.trim().replace(/ /g, '%20'), candidate).toString();
                  if (loc.toLowerCase().startsWith('https://')) pushHttps(loc);
                } catch {
                  // ignore
                }
              }
              pushHttps(candidate);
            }
          } catch {
            // host does not serve HTTPS on 443
          }
        })
      );
    }

    res.json({
      ok: true,
      directHttpsUrls,
      redirectedUrl,
      corsAllowed,
      geoBlockedOnProxy,
      upstreamStatus,
      upstreamMessage,
      clientIpDetected: Boolean(clientIp),
    });
  });

  // ==========================================================================
  // 5b. STREAM PROBE HELPER & ENDPOINT (Detects exact codecs, 10-bit H.264,
  //     HEVC, AC-3/DTS/MP2, resolution & duration for optimal playback!)
  // ==========================================================================
  interface ProbedMediaInfo {
    formatName: string;
    videoCodec?: string;
    videoPixFmt?: string;
    videoProfile?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    duration?: number;
    bitrate?: number;
    browserVideoOk: boolean;
    browserAudioOk: boolean;
    needsAudioFix: boolean;
    needsTranscode: boolean;
    recommendedMode: 'direct' | 'hls' | 'mpegts' | 'audiofix' | 'transcode';
  }

  function runFfprobeOnStream(probeInput: string, timeoutMs = 7000): Promise<ProbedMediaInfo | null> {
    if (!ffprobeAvailable) return Promise.resolve(null);
    return new Promise((resolve) => {
      const rwMicros = String(Math.max(4000, timeoutMs - 1000) * 1000);
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-rw_timeout', rwMicros,
        '-analyzeduration', '2500000',
        '-probesize', '2500000',
        probeInput,
      ];

      execFile(FFPROBE_BIN, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const info = JSON.parse(stdout) as {
            format?: { format_name?: string; duration?: string; bit_rate?: string };
            streams?: Array<{
              codec_type?: string;
              codec_name?: string;
              profile?: string;
              pix_fmt?: string;
              disposition?: { attached_pic?: number };
              width?: number;
              height?: number;
              channels?: number;
            }>;
          };

          const videoStream = info.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const audioStream = info.streams?.find((s) => s.codec_type === 'audio');
          const vCodec = (videoStream?.codec_name || '').toLowerCase();
          const vPixFmt = (videoStream?.pix_fmt || '').toLowerCase();
          const vProfile = (videoStream?.profile || '').toLowerCase();
          const aCodec = (audioStream?.codec_name || '').toLowerCase();
          const formatName = (info.format?.format_name || '').toLowerCase();

          // Browsers reject HEVC/MPEG-2/VC-1/MPEG-4 AND 10-bit H.264 (High 10 / yuv420p10le)
          const isHighBitDepth = /10le|10be|12le|12be|p010|high 10|4:2:2|4:4:4/i.test(`${vPixFmt} ${vProfile}`);
          const browserVideoOk = !vCodec || (['h264', 'vp8', 'vp9', 'av1'].includes(vCodec) && !isHighBitDepth);
          const browserAudioOk = !aCodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(aCodec);

          let recommendedMode: 'direct' | 'hls' | 'mpegts' | 'audiofix' | 'transcode' = 'direct';
          if (formatName.includes('hls')) {
            recommendedMode = browserVideoOk && browserAudioOk ? 'hls' : browserVideoOk ? 'audiofix' : 'transcode';
          } else if (formatName.includes('mpegts')) {
            recommendedMode = browserVideoOk && browserAudioOk ? 'mpegts' : browserVideoOk ? 'audiofix' : 'transcode';
          } else if (!browserVideoOk) {
            recommendedMode = 'transcode';
          } else if (!browserAudioOk || formatName.includes('avi') || formatName.includes('asf')) {
            recommendedMode = 'audiofix';
          }

          const rawDur = info.format?.duration ? parseFloat(info.format.duration) : undefined;
          const duration = rawDur !== undefined && Number.isFinite(rawDur) && rawDur > 0 ? rawDur : undefined;

          resolve({
            formatName,
            videoCodec: vCodec || undefined,
            videoPixFmt: vPixFmt || undefined,
            videoProfile: vProfile || undefined,
            audioCodec: aCodec || undefined,
            width: videoStream?.width,
            height: videoStream?.height,
            duration,
            bitrate: info.format?.bit_rate ? parseInt(info.format.bit_rate, 10) : undefined,
            browserVideoOk,
            browserAudioOk,
            needsAudioFix: browserVideoOk && !browserAudioOk,
            needsTranscode: !browserVideoOk,
            recommendedMode,
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  app.get('/api/proxy/probe', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    const ua = String(req.query.ua || FALLBACK_USER_AGENTS[0]);
    const ref = String(req.query.ref || '');
    const clientIp = extractClientIp(req);
    const acceptLanguage = extractAcceptLanguage(req);

    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Invalid URL' });
      return;
    }

    if (!ffprobeAvailable) {
      res.json({ ok: true, probed: false, ffmpegAvailable });
      return;
    }

    const alreadyProxied = isOwnLocalStreamProxyUrl(targetUrl);
    const probeInput = alreadyProxied
      ? targetUrl
      : `http://127.0.0.1:${activePort}${makeProxyUrl(targetUrl, ua, ref, { clientIp, acceptLanguage })}`;

    const probed = await runFfprobeOnStream(probeInput, 8000);
    if (!probed) {
      res.json({ ok: true, probed: false, ffmpegAvailable });
      return;
    }

    res.json({
      ok: true,
      probed: true,
      ffmpegAvailable,
      formatName: probed.formatName,
      videoCodec: probed.videoCodec,
      videoPixFmt: probed.videoPixFmt,
      audioCodec: probed.audioCodec,
      width: probed.width,
      height: probed.height,
      duration: probed.duration,
      bitrate: probed.bitrate,
      needsAudioFix: probed.needsAudioFix,
      needsTranscode: probed.needsTranscode,
      recommendedMode: probed.recommendedMode,
    });
  });

  // ==========================================================================
  // 6. UNIVERSAL STREAM PROXY (HLS rewriting, DASH rewriting, MPEG-TS live,
  //    and HTTP Byte-Range VOD streaming with auto UA retry & zero buffering!)
  // ==========================================================================
  app.options(['/api/proxy/stream', '/api/proxy/stream/:hint'], (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.sendStatus(204);
  });

  app.head(['/api/proxy/stream', '/api/proxy/stream/:hint'], async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    const preferredUa = req.query.ua ? String(req.query.ua) : undefined;
    const referer = req.query.ref ? String(req.query.ref) : undefined;
    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch {
      res.sendStatus(400);
      return;
    }
    try {
      const attempt = await requestRawStream(targetUrl, {
        method: 'HEAD',
        userAgent: preferredUa || FALLBACK_USER_AGENTS[0],
        referer,
        acceptEncoding: 'identity',
        timeoutMs: 12000,
      });
      attempt.stream.resume();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', guessVideoContentType(attempt.finalUrl, String(attempt.headers['content-type'] || '')));
      if (attempt.headers['content-length']) res.setHeader('Content-Length', attempt.headers['content-length']);
      res.setHeader('Accept-Ranges', attempt.headers['accept-ranges'] || 'bytes');
      res.status(attempt.statusCode).end();
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.sendStatus(400);
        return;
      }
      res.sendStatus(502);
    }
  });

  // Helpers for stream content sniffing, MPEG-TS 188-byte sync alignment, M2TS -> TS conversion,
  // and HTTP-200 disguised HTML/error page detection so browsers & mpegts.js never receive corrupt streams.
  function findMpegTsSyncOffset(buf: Buffer): number {
    if (buf.length < 189) return -1;
    const limit = Math.min(buf.length - 189, 2048);
    for (let i = 0; i <= limit; i++) {
      if (buf[i] === 0x47 && buf[i + 188] === 0x47) {
        if (i + 376 < buf.length) {
          if (buf[i + 376] === 0x47) return i;
        } else {
          return i;
        }
      }
    }
    return -1;
  }

  function findM2tsSyncOffset(buf: Buffer): number {
    if (buf.length < 197) return -1;
    const limit = Math.min(buf.length - 197, 2048);
    for (let i = 0; i <= limit; i++) {
      if (buf[i + 4] === 0x47 && buf[i + 196] === 0x47) {
        if (i + 388 < buf.length) {
          if (buf[i + 388] === 0x47) return i;
        } else {
          return i;
        }
      }
    }
    return -1;
  }

  function createM2tsToTsTransform(initialSkip = 0): Transform {
    let skipped = initialSkip;
    let carry: Buffer = Buffer.alloc(0);
    return new Transform({
      transform(chunk: Buffer, _enc, cb) {
        let data = chunk;
        if (skipped > 0) {
          if (data.length <= skipped) {
            skipped -= data.length;
            cb();
            return;
          }
          data = data.subarray(skipped);
          skipped = 0;
        }
        const combined = carry.length > 0 ? Buffer.concat([carry, data]) : data;
        const packetCount = Math.floor(combined.length / 192);
        if (packetCount > 0) {
          const out = Buffer.allocUnsafe(packetCount * 188);
          for (let p = 0; p < packetCount; p++) {
            combined.copy(out, p * 188, p * 192 + 4, p * 192 + 192);
          }
          this.push(out);
        }
        const rem = combined.length % 192;
        carry = rem > 0 ? Buffer.from(combined.subarray(combined.length - rem)) : Buffer.alloc(0);
        cb();
      },
      flush(cb) {
        carry = Buffer.alloc(0);
        cb();
      },
    });
  }

  function looksLikeBlockedHtmlOrText(buf: Buffer, contentType: string): boolean {
    if (buf.length === 0) return true;
    // Fast-pass known binary containers
    if (findMpegTsSyncOffset(buf) >= 0 || findM2tsSyncOffset(buf) >= 0) return false;
    if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return false;
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return false;
    if (buf.length >= 4 && buf.subarray(0, 3).toString('ascii') === 'FLV') return false;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return false; // gzip (could be gzipped m3u8)

    const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').trimStart();
    if (head.startsWith('#EXTM3U') || head.startsWith('<MPD') || head.startsWith('<?xml')) return false;
    const lower = head.toLowerCase();
    const ctLower = contentType.toLowerCase();
    if (
      ctLower.includes('text/html') ||
      lower.startsWith('<!doctype html') ||
      lower.startsWith('<html') ||
      lower.startsWith('<head') ||
      lower.startsWith('<body') ||
      lower.startsWith('<title') ||
      lower.includes('cloudflare') ||
      lower.includes('just a moment') ||
      lower.includes('access denied') ||
      lower.includes('403 forbidden') ||
      lower.includes('not allowed') ||
      lower.startsWith('{"error"') ||
      lower.startsWith('{"status":false') ||
      lower.startsWith('{"user_info"')
    ) {
      return true;
    }
    return false;
  }

  function peekInitialChunk(
    stream: Readable,
    targetBytes = 4096,
    timeoutMs = 5000
  ): Promise<{ sample: Buffer; ended: boolean }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;

      const cleanup = () => {
        clearTimeout(timer);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onErr);
      };

      const finish = (ended: boolean) => {
        if (done) return;
        done = true;
        cleanup();
        if (!ended) stream.pause();
        resolve({ sample: Buffer.concat(chunks), ended });
      };

      const onData = (c: Buffer) => {
        chunks.push(c);
        total += c.length;
        // Stop peeking as soon as we have enough bytes to sniff container / align TS packets
        if (total >= targetBytes) {
          finish(false);
        }
      };

      const onEnd = () => finish(true);
      const onErr = (err: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onErr);
    });
  }

  app.get(['/api/proxy/stream', '/api/proxy/stream/:hint'], async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    const preferredUa = req.query.ua ? String(req.query.ua) : undefined;
    const referer = req.query.ref ? String(req.query.ref) : undefined;
    const manifestOnly = req.query.manifestOnly === '1';
    const rawRangeHeader = req.headers.range;
    // Never forward Range requests for HLS/DASH manifests so FFmpeg's default Range: bytes=0-
    // never bypasses manifest rewriting!
    const rangeHeader =
      isHlsCandidate(targetUrl) || isDashCandidate(targetUrl) ? undefined : rawRangeHeader;
    const clientIp = extractClientIp(req);
    const acceptLanguage = extractAcceptLanguage(req);

    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid stream URL' });
      return;
    }

    const cachedTransport = getHostTransport(targetUrl);
    const uaCandidates = buildUserAgentCandidates(preferredUa || cachedTransport?.userAgent);
    let upstream: StreamResponseResult | null = null;
    let peekedSample: Buffer | null = null;
    let peekedEnded = false;
    let usedUa = uaCandidates[0];
    let usedTransport: 'node' | 'curl' = 'node';
    let lastErr: Error | null = null;
    let hostUnreachable = false;

    interface StreamAttemptSpec {
      transport: 'node' | 'curl';
      ua: string;
      forwardIp?: string;
    }

    const attemptPlan: StreamAttemptSpec[] = [];
    const pushAttempt = (spec: StreamAttemptSpec) => {
      if (
        !attemptPlan.some(
          (a) =>
            a.transport === spec.transport &&
            a.ua === spec.ua &&
            (a.forwardIp || '') === (spec.forwardIp || '')
        )
      ) {
        attemptPlan.push(spec);
      }
    };

    if (cachedTransport?.preferCurl) {
      pushAttempt({
        transport: 'curl',
        ua: cachedTransport.userAgent,
        forwardIp: cachedTransport.preferNoXff ? undefined : clientIp,
      });
      if (clientIp) {
        pushAttempt({
          transport: 'curl',
          ua: cachedTransport.userAgent,
          forwardIp: cachedTransport.preferNoXff ? clientIp : undefined,
        });
      }
      pushAttempt({ transport: 'node', ua: cachedTransport.userAgent, forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: 'VLC/3.0.20 LibVLC/3.0.20', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: 'ExoPlayerLib/2.18.1', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: 'TiviMate/4.7.0 (Linux; Android 13)', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: FALLBACK_USER_AGENTS[5], forwardIp: undefined });
    } else {
      pushAttempt({ transport: 'node', ua: uaCandidates[0], forwardIp: undefined });
      if (clientIp) {
        pushAttempt({ transport: 'node', ua: uaCandidates[0], forwardIp: clientIp });
      }
      if (uaCandidates[1]) {
        pushAttempt({ transport: 'node', ua: uaCandidates[1], forwardIp: undefined });
      }
      pushAttempt({ transport: 'curl', ua: uaCandidates[0], forwardIp: undefined });
      if (clientIp) {
        pushAttempt({ transport: 'curl', ua: uaCandidates[0], forwardIp: clientIp });
      }
      pushAttempt({ transport: 'curl', ua: 'VLC/3.0.20 LibVLC/3.0.20', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: 'ExoPlayerLib/2.18.1', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: 'TiviMate/4.7.0 (Linux; Android 13)', forwardIp: undefined });
      pushAttempt({ transport: 'curl', ua: FALLBACK_USER_AGENTS[5], forwardIp: undefined });
    }

    for (let i = 0; i < attemptPlan.length; i++) {
      const spec = attemptPlan[i];
      if (hostUnreachable && spec.transport === 'node') continue;
      try {
        const attempt =
          spec.transport === 'curl'
            ? await curlRequestRawStream(targetUrl, {
                method: 'GET',
                userAgent: spec.ua,
                referer,
                range: rangeHeader,
                timeoutMs: 14000,
                clientIp: spec.forwardIp,
                acceptLanguage,
              })
            : await requestRawStream(targetUrl, {
                method: 'GET',
                userAgent: spec.ua,
                referer,
                range: rangeHeader,
                acceptEncoding: 'identity',
                timeoutMs: 14000,
                clientIp: spec.forwardIp,
                acceptLanguage,
              });

        if (isLikelyBlockedStatus(attempt.statusCode) && i < attemptPlan.length - 1) {
          attempt.stream.destroy();
          attempt.req.destroy();
          continue;
        }

        const ctStr = String(attempt.headers['content-type'] || '');
        if (ctStr.toLowerCase().includes('text/html') && i < attemptPlan.length - 1) {
          attempt.stream.destroy();
          attempt.req.destroy();
          continue;
        }

        const clNum = Number(attempt.headers['content-length'] || 0);
        const upstreamLooksLikeManifest =
          isHlsCandidate(attempt.finalUrl, ctStr) || isDashCandidate(attempt.finalUrl, ctStr);
        const shouldPeekRangeResponse =
          Boolean(rangeHeader) &&
          (upstreamLooksLikeManifest || (attempt.statusCode === 200 && clNum > 0 && clNum < 65536));

        // For non-Range 2xx responses (and suspicious tiny HTTP 200 replies to Range requests),
        // peek initial bytes before committing so we catch empty/HTML-disguised WAF blocks AND
        // align MPEG-TS packets cleanly!
        if ((!rangeHeader || shouldPeekRangeResponse) && attempt.statusCode >= 200 && attempt.statusCode < 300) {
          const { sample, ended } = await peekInitialChunk(attempt.stream, 4096, 6000);
          const decSample =
            sample.length >= 2 && sample[0] === 0x1f && sample[1] === 0x8b
              ? decompressBuffer(sample, 'gzip')
              : sample;
          const isDisguisedBlock =
            (ended && decSample.length === 0) || looksLikeBlockedHtmlOrText(decSample, ctStr);

          if (isDisguisedBlock && i < attemptPlan.length - 1) {
            attempt.stream.destroy();
            attempt.req.destroy();
            continue;
          }

          upstream = attempt;
          peekedSample = sample;
          peekedEnded = ended;
          usedUa = spec.ua;
          usedTransport = spec.transport;
          if (!isDisguisedBlock) {
            rememberHostTransport(targetUrl, {
              preferCurl: spec.transport === 'curl',
              userAgent: spec.ua,
              preferNoXff: !spec.forwardIp,
            });
          }
          break;
        }

        upstream = attempt;
        usedUa = spec.ua;
        usedTransport = spec.transport;
        if (attempt.statusCode >= 200 && attempt.statusCode < 300) {
          rememberHostTransport(targetUrl, {
            preferCurl: spec.transport === 'curl',
            userAgent: spec.ua,
            preferNoXff: !spec.forwardIp,
          });
        }
        break;
      } catch (err) {
        if (err instanceof BlockedUrlError) {
          res.status(400).json({ error: err.message });
          return;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (isUnreachableHostError(lastErr)) {
          hostUnreachable = true;
          break;
        }
      }
    }

    if (!upstream) {
      res.status(502).json({
        error: lastErr ? lastErr.message : 'Unable to reach upstream media stream',
      });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, X-IPFLIX-Final-Url, X-IPFLIX-Stream-Kind, X-IPFLIX-Error-Kind, X-IPFLIX-Has-Https-Segments, X-IPFLIX-Transport'
    );
    res.setHeader('X-IPFLIX-Final-Url', upstream.finalUrl);
    res.setHeader('X-IPFLIX-Transport', usedTransport);
    res.setHeader('X-Accel-Buffering', 'no');

    if (upstream.statusCode >= 400) {
      const errBody = await new Promise<string>((resolveBody) => {
        const chunks: Buffer[] = [];
        let len = 0;
        const finish = () => {
          upstream?.stream.destroy();
          upstream?.req.destroy();
          resolveBody(Buffer.concat(chunks).toString('utf8'));
        };
        upstream!.stream.on('data', (c: Buffer) => {
          chunks.push(c);
          len += c.length;
          if (len >= 4096) finish();
        });
        upstream!.stream.on('end', finish);
        upstream!.stream.on('error', finish);
      });

      const geoCheck = detectGeoRestriction(upstream.statusCode, upstream.headers, errBody);
      res.setHeader('X-IPFLIX-Error-Kind', geoCheck.errorKind);

      res.status(upstream.statusCode).json({
        error: geoCheck.reason || `Upstream stream returned HTTP ${upstream.statusCode}`,
        code: geoCheck.geoBlocked ? 'GEO_BLOCKED' : geoCheck.errorKind.toUpperCase(),
        errorKind: geoCheck.errorKind,
        upstreamStatus: upstream.statusCode,
        upstreamSnippet: geoCheck.upstreamSnippet,
        transport: usedTransport,
        finalUrl: upstream.finalUrl,
      });
      return;
    }

    const rawCt = String(upstream.headers['content-type'] || '');
    const contentEncoding = String(upstream.headers['content-encoding'] || '');

    // Peeked 2xx responses: use peeked sample for exact container detection, manifest rewriting,
    // MPEG-TS 188-byte packet alignment, M2TS->TS conversion, and disguised HTML error rejection!
    if (peekedSample !== null) {
      let cleanedUp = false;
      const cleanup = () => {
        if (!cleanedUp) {
          cleanedUp = true;
          upstream?.stream.destroy();
          upstream?.req.destroy();
        }
      };
      res.on('close', cleanup);

      const sampleRaw = peekedSample;
      const isGzipped =
        contentEncoding.toLowerCase().includes('gzip') ||
        (sampleRaw.length >= 2 && sampleRaw[0] === 0x1f && sampleRaw[1] === 0x8b);

      const maybeTextSample = isGzipped ? null : sampleRaw;
      const headStr = maybeTextSample
        ? maybeTextSample.subarray(0, Math.min(maybeTextSample.length, 256)).toString('utf8').trimStart()
        : '';

      const tsOffset = maybeTextSample ? findMpegTsSyncOffset(maybeTextSample) : -1;
      const m2tsOffset = tsOffset < 0 && maybeTextSample ? findM2tsSyncOffset(maybeTextSample) : -1;
      const isMp4 = Boolean(maybeTextSample && maybeTextSample.length >= 8 && maybeTextSample.subarray(4, 8).toString('ascii') === 'ftyp');
      const isMkv = Boolean(
        maybeTextSample &&
          maybeTextSample.length >= 4 &&
          maybeTextSample[0] === 0x1a &&
          maybeTextSample[1] === 0x45 &&
          maybeTextSample[2] === 0xdf &&
          maybeTextSample[3] === 0xa3
      );
      const isFlv = Boolean(maybeTextSample && maybeTextSample.length >= 4 && maybeTextSample.subarray(0, 3).toString('ascii') === 'FLV');

      const looksLikeManifest =
        headStr.startsWith('#EXTM3U') ||
        headStr.startsWith('<MPD') ||
        headStr.startsWith('<?xml') ||
        (isGzipped && (isHlsCandidate(upstream.finalUrl, rawCt) || isDashCandidate(upstream.finalUrl, rawCt)));

      // 1. HLS or DASH Manifest (even if provider served #EXTM3U on a .ts URL!)
      if (looksLikeManifest) {
        const chunks: Buffer[] = [sampleRaw];
        let total = sampleRaw.length;
        const collectAll = peekedEnded
          ? Promise.resolve(sampleRaw)
          : new Promise<Buffer>((resolveAll, rejectAll) => {
              upstream!.stream.on('data', (c: Buffer) => {
                total += c.length;
                if (total <= 4 * 1024 * 1024) chunks.push(c);
              });
              upstream!.stream.on('end', () => resolveAll(Buffer.concat(chunks)));
              upstream!.stream.on('error', rejectAll);
              upstream!.stream.resume();
            });

        try {
          const fullBuf = await collectAll;
          const decoded = decompressBuffer(fullBuf, contentEncoding);
          const text = decoded.toString('utf8');

          if (isHlsCandidate(upstream.finalUrl, rawCt, text)) {
            const rewritten = rewriteHlsManifest(text, upstream.finalUrl, usedUa, referer, manifestOnly);
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('X-IPFLIX-Stream-Kind', manifestOnly ? 'hls-direct-segments' : 'hls');
            if (rewritten.hasExternalHttps) {
              res.setHeader('X-IPFLIX-Has-Https-Segments', '1');
            }
            res.setHeader('Cache-Control', 'no-cache, no-store');
            res.send(rewritten.text);
            return;
          }

          if (isDashCandidate(upstream.finalUrl, rawCt, text)) {
            const rewritten = rewriteDashManifest(text, upstream.finalUrl, usedUa, referer);
            res.status(200);
            res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
            res.setHeader('X-IPFLIX-Stream-Kind', 'dash');
            res.setHeader('Cache-Control', 'no-cache, no-store');
            res.send(rewritten);
            return;
          }
        } catch {
          if (!res.headersSent) res.status(502).json({ error: 'Stream manifest interrupted' });
          return;
        }
      }

      // 2. Reject empty or HTML/JSON disguised error pages returned with HTTP 200
      if (sampleRaw.length === 0 || (maybeTextSample && looksLikeBlockedHtmlOrText(maybeTextSample, rawCt))) {
        cleanup();
        const textSnip = maybeTextSample ? maybeTextSample.toString('utf8') : '';
        const geoCheck = detectGeoRestriction(upstream.statusCode, upstream.headers, textSnip);
        res.status(geoCheck.geoBlocked ? 451 : 502).json({
          error: geoCheck.reason || 'Stream source returned an invalid response instead of video data',
          code: geoCheck.geoBlocked ? 'GEO_BLOCKED' : 'INVALID_MEDIA_RESPONSE',
          finalUrl: upstream.finalUrl,
        });
        return;
      }

      // 3. MPEG-TS with automatic 188-byte 0x47 packet sync alignment!
      if (tsOffset >= 0) {
        const alignedHead = tsOffset > 0 ? sampleRaw.subarray(tsOffset) : sampleRaw;
        res.status(upstream.statusCode);
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('X-IPFLIX-Stream-Kind', 'mpegts');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders();
        if (alignedHead.length > 0) res.write(alignedHead);
        if (peekedEnded) {
          res.end();
        } else {
          upstream.stream.on('error', () => {
            if (!res.writableEnded) res.end();
          });
          upstream.stream.pipe(res);
          upstream.stream.resume();
        }
        return;
      }

      // 4. 192-byte BDAV/M2TS -> transparent 188-byte MPEG-TS conversion!
      if (m2tsOffset >= 0) {
        res.status(upstream.statusCode);
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('X-IPFLIX-Stream-Kind', 'mpegts');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders();
        const m2tsTransform = createM2tsToTsTransform(m2tsOffset);
        m2tsTransform.pipe(res);
        m2tsTransform.write(sampleRaw);
        if (peekedEnded) {
          m2tsTransform.end();
        } else {
          upstream.stream.on('error', () => {
            m2tsTransform.end();
          });
          upstream.stream.pipe(m2tsTransform);
          upstream.stream.resume();
        }
        return;
      }

      // 5. Binary video containers (MP4 / MKV / FLV / other)
      const detectedCt = isMp4
        ? 'video/mp4'
        : isMkv
        ? 'video/webm'
        : isFlv
        ? 'video/x-flv'
        : guessVideoContentType(upstream.finalUrl, rawCt);
      const streamKind = isMp4 ? 'mp4' : isMkv ? 'mkv' : isFlv ? 'flv' : 'binary';

      res.status(upstream.statusCode);
      res.setHeader('Content-Type', detectedCt);
      res.setHeader('X-IPFLIX-Stream-Kind', streamKind);
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', upstream.headers['content-range']);
      }
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      if (sampleRaw.length > 0) res.write(sampleRaw);
      if (peekedEnded) {
        res.end();
      } else {
        upstream.stream.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        upstream.stream.pipe(res);
        upstream.stream.resume();
      }
      return;
    }

    // Direct zero-latency streaming pass-through (VOD Range seeking & HLS segments)
    const fixedCt = guessVideoContentType(upstream.finalUrl, rawCt);
    res.status(upstream.statusCode);
    res.setHeader('Content-Type', fixedCt === 'video/x-matroska' ? 'video/webm' : fixedCt);
    res.setHeader('X-IPFLIX-Stream-Kind', 'binary');
    res.setHeader('X-Accel-Buffering', 'no');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }
    res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    res.on('close', () => {
      upstream?.stream.destroy();
      upstream?.req.destroy();
    });

    upstream.stream.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });

    upstream.stream.pipe(res);
  });

  // ==========================================================================
  // 6b. MPEG-DASH PATH-PREFIX SEGMENT PROXY (/api/proxy/dash/:b64dir/*)
  // ==========================================================================
  app.use('/api/proxy/dash/:b64dir', async (req: Request, res: Response) => {
    try {
      const baseDir = Buffer.from(String(req.params.b64dir || ''), 'base64url').toString('utf8');
      const relPath = req.url.replace(/^\/+/, '');
      const resolvedUrl = new URL(relPath, baseDir).toString();
      await assertSafeUpstreamUrl(resolvedUrl);
      const upstream = await requestRawStream(resolvedUrl, {
        method: 'GET',
        userAgent: FALLBACK_USER_AGENTS[5],
        range: req.headers.range,
        acceptEncoding: 'identity',
        timeoutMs: 18000,
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(upstream.statusCode);
      res.setHeader('Content-Type', guessVideoContentType(upstream.finalUrl, String(upstream.headers['content-type'] || '')));
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
      res.flushHeaders();

      res.on('close', () => {
        upstream.stream.destroy();
        upstream.req.destroy();
      });
      upstream.stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.sendStatus(err instanceof BlockedUrlError ? 400 : 502);
      }
    }
  });

  // ==========================================================================
  // 7. FFMPEG REAL-TIME COMPATIBILITY ENGINE (Fixes MKV/AVI/HEVC/10-bit/1080i/AC3/DTS/MP2
  //    & Broken IPTV Live Streams in ALL Browsers with Auto HEVC/Interlaced -> H.264 Upgrade
  //    plus clean Live MPEG-TS H.264/AAC output for continuous MSE playback!)
  // ==========================================================================
  function inspectVideoLogCompatibility(log: string): { incompatible: boolean; interlaced: boolean } {
    const inputSection = log.split(/Output #0/i)[0] || log;
    const videoLineMatches = inputSection.match(/Stream #\d+:\d+[^\n]*Video:\s*([^\n]+)/gi);
    if (!videoLineMatches || videoLineMatches.length === 0) {
      return { incompatible: false, interlaced: false };
    }
    for (const line of videoLineMatches) {
      if (/attached pic|mjpeg|png|webp/i.test(line)) continue;
      const m = line.match(/Video:\s*([a-z0-9_]+)/i);
      const codec = (m?.[1] || '').toLowerCase();
      if (!codec) continue;
      const interlaced = /top first|bottom first|top coded first|bottom coded first|interlaced/i.test(line);
      if (codec !== 'h264') {
        return { incompatible: true, interlaced };
      }
      if (/high 10|main 10|yuv420p10|yuv422p|yuv444p|10le|10be|12le|12be/i.test(line)) {
        return { incompatible: true, interlaced };
      }
      if (interlaced) {
        return { incompatible: true, interlaced: true };
      }
      return { incompatible: false, interlaced: false };
    }
    return { incompatible: false, interlaced: false };
  }

  app.get('/api/proxy/remux', async (req: Request, res: Response) => {
    if (!ffmpegAvailable) {
      res.status(501).json({ error: 'Server compatibility engine (FFmpeg) is not available.' });
      return;
    }

    const targetUrl = String(req.query.url || '');
    const ua = String(req.query.ua || FALLBACK_USER_AGENTS[0]);
    const ref = String(req.query.ref || '');
    const initialMode = String(req.query.mode || 'audiofix') === 'transcode' ? 'transcode' : 'audiofix';
    const outFormat = String(req.query.format || 'mp4').toLowerCase() === 'ts' ? 'ts' : 'mp4';
    const startSec = Math.max(0, Number(req.query.start || 0) || 0);
    const isLive = req.query.live === '1';
    const clientIp = extractClientIp(req);
    const acceptLanguage = extractAcceptLanguage(req);

    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL' });
      return;
    }

    if (activeFfmpegProcesses.size >= 6) {
      const oldest = activeFfmpegProcesses.values().next().value;
      if (oldest) {
        try {
          oldest.kill('SIGKILL');
        } catch {
          // ignore
        }
        activeFfmpegProcesses.delete(oldest);
      }
    }

    const alreadyProxied = isOwnLocalStreamProxyUrl(targetUrl);
    const ffInputUrl = alreadyProxied
      ? targetUrl
      : `http://127.0.0.1:${activePort}${makeProxyUrl(targetUrl, ua, ref, { clientIp, acceptLanguage })}`;
    const looksLikeHlsInput = /\.m3u8(\?|$)/i.test(targetUrl);

    let activeChild: ChildProcess | null = null;
    let clientClosed = false;
    let started = false;

    const killActive = () => {
      clientClosed = true;
      if (activeChild) {
        activeFfmpegProcesses.delete(activeChild);
        if (!activeChild.killed) {
          try {
            activeChild.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        activeChild = null;
      }
    };

    res.on('close', killActive);

    const spawnRemux = (mode: 'audiofix' | 'transcode', deinterlace = false) => {
      if (clientClosed) return;

      const args: string[] = [
        '-hide_banner',
        '-loglevel', mode === 'audiofix' ? 'info' : 'error',
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-rw_timeout', '15000000',
      ];

      if (looksLikeHlsInput) {
        args.push('-allowed_extensions', 'ALL');
      }

      if (isLive && !looksLikeHlsInput) {
        args.push(
          '-reconnect', '1',
          '-reconnect_on_network_error', '1',
          '-reconnect_delay_max', '3'
        );
      }

      args.push(
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-analyzeduration', isLive ? '2500000' : '3500000',
        '-probesize', isLive ? '2500000' : '3500000'
      );

      if (!isLive && startSec > 0) {
        args.push('-ss', String(startSec));
      }

      args.push('-i', ffInputUrl);
      args.push('-map', '0:V:0?', '-map', '0:a:0?', '-sn', '-dn');

      if (mode === 'transcode') {
        const vf =
          deinterlace || isLive
            ? 'yadif=0:-1:0,scale=trunc(iw/2)*2:trunc(ih/2)*2'
            : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        args.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-profile:v', 'main',
          '-level', '4.1',
          '-crf', '24',
          '-maxrate', '4500k',
          '-bufsize', '9000k',
          '-pix_fmt', 'yuv420p',
          '-g', '48',
          '-keyint_min', '48',
          '-sc_threshold', '0',
          '-vf', vf
        );
      } else {
        args.push('-c:v', 'copy');
      }

      args.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-ar', '48000',
        '-b:a', mode === 'transcode' ? '160k' : '192k',
        '-avoid_negative_ts', 'make_zero',
        '-max_interleave_delta', '0',
        '-max_muxing_queue_size', '2048',
        '-flush_packets', '1'
      );

      if (outFormat === 'ts') {
        args.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1');
      } else {
        args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
      }

      const ff = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      activeChild = ff;
      activeFfmpegProcesses.add(ff);

      let stderrLog = '';
      let upgradedToTranscode = false;
      let codecChecked = mode === 'transcode';
      let stdoutPausedForCheck = false;
      const pendingChunks: Buffer[] = [];
      let pendingBytes = 0;

      const clearCheckTimer = () => {
        if (codecCheckTimer) {
          clearTimeout(codecCheckTimer);
          codecCheckTimer = null;
        }
      };

      const writeChunkWithBackpressure = (buf: Buffer) => {
        if (clientClosed || res.writableEnded) return;
        if (!started) {
          started = true;
          res.status(200);
          res.setHeader('Content-Type', outFormat === 'ts' ? 'video/mp2t' : 'video/mp4');
          res.setHeader('Cache-Control', 'no-cache, no-store');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Expose-Headers', 'X-IPFLIX-Remux-Mode, X-IPFLIX-Remux-Format');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-IPFLIX-Remux-Mode', mode);
          res.setHeader('X-IPFLIX-Remux-Format', outFormat);
          res.flushHeaders();
        }
        const ok = res.write(buf);
        if (!ok && !ff.killed) {
          ff.stdout.pause();
          res.once('drain', () => {
            if (!clientClosed && !ff.killed) {
              ff.stdout.resume();
            }
          });
        }
      };

      const flushPending = () => {
        clearCheckTimer();
        if (pendingChunks.length > 0) {
          const combined = Buffer.concat(pendingChunks);
          pendingChunks.length = 0;
          pendingBytes = 0;
          writeChunkWithBackpressure(combined);
        }
        if (stdoutPausedForCheck && !clientClosed && !ff.killed) {
          stdoutPausedForCheck = false;
          ff.stdout.resume();
        }
      };

      const triggerUpgradeToTranscode = (interlaced: boolean) => {
        if (upgradedToTranscode || started || clientClosed) return;
        clearCheckTimer();
        upgradedToTranscode = true;
        pendingChunks.length = 0;
        pendingBytes = 0;
        activeFfmpegProcesses.delete(ff);
        if (activeChild === ff) activeChild = null;
        try {
          ff.kill('SIGKILL');
        } catch {
          // ignore
        }
        spawnRemux('transcode', interlaced);
      };

      let codecCheckTimer: ReturnType<typeof setTimeout> | null =
        mode === 'audiofix'
          ? setTimeout(() => {
              if (!codecChecked && !upgradedToTranscode && !clientClosed) {
                const check = inspectVideoLogCompatibility(stderrLog);
                if (check.incompatible) {
                  triggerUpgradeToTranscode(check.interlaced);
                  return;
                }
                codecChecked = true;
                flushPending();
              }
            }, 3000)
          : null;

      ff.stderr.on('data', (d: Buffer) => {
        if (stderrLog.length < 8192) {
          stderrLog += d.toString('utf8');
        }
        if (mode === 'audiofix' && !codecChecked && !started && !upgradedToTranscode) {
          if (/Output #0/i.test(stderrLog) || /Stream #\d+:\d+[^\n]*Video:/i.test(stderrLog)) {
            const check = inspectVideoLogCompatibility(stderrLog);
            if (check.incompatible) {
              triggerUpgradeToTranscode(check.interlaced);
              return;
            }
            if (/Output #0/i.test(stderrLog)) {
              codecChecked = true;
              flushPending();
            }
          }
        }
      });

      ff.stdout.on('data', (chunk: Buffer) => {
        if (clientClosed || res.writableEnded || upgradedToTranscode) return;
        if (!codecChecked) {
          const check = inspectVideoLogCompatibility(stderrLog);
          if (check.incompatible) {
            triggerUpgradeToTranscode(check.interlaced);
            return;
          }
          pendingChunks.push(chunk);
          pendingBytes += chunk.length;
          if (/Output #0/i.test(stderrLog)) {
            codecChecked = true;
            flushPending();
          } else if (pendingBytes >= 131072 && !stdoutPausedForCheck) {
            // Pause stdout briefly so stderr finishes printing the input Video stream header
            stdoutPausedForCheck = true;
            ff.stdout.pause();
          }
          return;
        }
        writeChunkWithBackpressure(chunk);
      });

      ff.on('close', (code) => {
        clearCheckTimer();
        activeFfmpegProcesses.delete(ff);
        if (activeChild === ff) activeChild = null;
        if (clientClosed || upgradedToTranscode) return;

        if (!started && mode === 'audiofix') {
          const check = inspectVideoLogCompatibility(stderrLog);
          if (check.incompatible) {
            spawnRemux('transcode', check.interlaced);
            return;
          }
          if (code !== 0) {
            spawnRemux('transcode', isLive);
            return;
          }
        }

        if (!started && pendingChunks.length > 0 && code === 0) {
          codecChecked = true;
          flushPending();
        }

        if (!started && !res.headersSent) {
          res.status(502).json({
            error: `Compatibility engine exited (code ${code}): ${stderrLog.slice(-300)}`,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      });

      ff.on('error', () => {
        clearCheckTimer();
        activeFfmpegProcesses.delete(ff);
        if (activeChild === ff) activeChild = null;
        if (!started && !res.headersSent && !upgradedToTranscode) {
          res.status(502).json({ error: 'Compatibility engine failed to start' });
        }
      });
    };

    spawnRemux(initialMode, isLive);
  });

  // ==========================================================================
  // 7b. DEEP STREAM DIAGNOSTICS (HTTP status, transport, FFprobe codecs,
  //     resolution, duration & Xtream 10-second GeoIP Ban-Video detection!)
  // ==========================================================================
  app.get('/api/proxy/diagnose', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    const preferredUa = req.query.ua ? String(req.query.ua) : undefined;
    const referer = req.query.ref ? String(req.query.ref) : undefined;
    const mediaType = String(req.query.type || '').toLowerCase(); // 'live' | 'movie' | 'episode'
    const clientIp = extractClientIp(req);
    const acceptLanguage = extractAcceptLanguage(req);

    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Invalid URL' });
      return;
    }

    const cached = getHostTransport(targetUrl);
    const ua = preferredUa || cached?.userAgent || FALLBACK_USER_AGENTS[0];
    let upstream: StreamResponseResult | null = null;
    let usedTransport: 'node' | 'curl' = cached?.preferCurl ? 'curl' : 'node';
    let lastError = '';

    const tryOnce = async (transport: 'node' | 'curl', forwardIp?: string) => {
      return transport === 'curl'
        ? curlRequestRawStream(targetUrl, {
            method: 'GET',
            userAgent: ua,
            referer,
            timeoutMs: 8000,
            clientIp: forwardIp,
            acceptLanguage,
          })
        : requestRawStream(targetUrl, {
            method: 'GET',
            userAgent: ua,
            referer,
            acceptEncoding: 'identity',
            timeoutMs: 8000,
            clientIp: forwardIp,
            acceptLanguage,
          });
    };

    try {
      upstream = await tryOnce(usedTransport, undefined);
      if (isLikelyBlockedStatus(upstream.statusCode)) {
        upstream.stream.destroy();
        upstream.req.destroy();
        const altTransport: 'node' | 'curl' = usedTransport === 'curl' ? 'node' : 'curl';
        try {
          const second = await tryOnce(altTransport, clientIp);
          upstream = second;
          usedTransport = altTransport;
        } catch {
          // keep first status if alt fails
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const altTransport: 'node' | 'curl' = usedTransport === 'curl' ? 'node' : 'curl';
      try {
        upstream = await tryOnce(altTransport, undefined);
        usedTransport = altTransport;
      } catch (err2) {
        lastError = err2 instanceof Error ? err2.message : lastError;
      }
    }

    if (!upstream) {
      res.json({
        ok: true,
        reachable: false,
        statusCode: 0,
        transport: usedTransport,
        finalUrl: targetUrl,
        geoBlocked: false,
        reason: lastError || 'Stream host unreachable from cloud server',
        serverRegion: 'europe-west1 (Belgium)',
        clientIpDetected: Boolean(clientIp),
      });
      return;
    }

    // Read up to 2KB sample and immediately close socket so single-connection IPTV accounts are freed right away
    const sampleBuf = await new Promise<Buffer>((resolveBuf) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const timer = setTimeout(() => {
        upstream?.stream.destroy();
        upstream?.req.destroy();
        resolveBuf(Buffer.concat(chunks));
      }, 2500);
      const finish = () => {
        clearTimeout(timer);
        upstream?.stream.destroy();
        upstream?.req.destroy();
        resolveBuf(Buffer.concat(chunks));
      };
      upstream!.stream.on('data', (c: Buffer) => {
        chunks.push(c);
        total += c.length;
        if (total >= 2048) finish();
      });
      upstream!.stream.on('end', finish);
      upstream!.stream.on('error', finish);
    });

    const ct = String(upstream.headers['content-type'] || '');
    const isBinarySample =
      sampleBuf.length >= 4 &&
      (sampleBuf[0] === 0x47 ||
        (sampleBuf[0] === 0x1a && sampleBuf[1] === 0x45) ||
        sampleBuf.subarray(4, 8).toString('ascii') === 'ftyp');
    const textSample = isBinarySample ? '' : sampleBuf.toString('utf8');
    const isMediaBytes = isBinarySample || textSample.includes('#EXTM3U');

    const geoCheck =
      upstream.statusCode >= 400 || (!isBinarySample && textSample.length > 0 && !textSample.includes('#EXTM3U'))
        ? detectGeoRestriction(upstream.statusCode, upstream.headers, textSample)
        : { geoBlocked: false, errorKind: 'upstream_error' as const, reason: undefined, upstreamSnippet: undefined };

    let httpsDirectCandidate: string | undefined;
    if (upstream.finalUrl.toLowerCase().startsWith('https://')) {
      httpsDirectCandidate = upstream.finalUrl;
    }

    // Deep inspection with ffprobe on HTTP 200 media streams:
    // Reveals exact video/audio codecs (HEVC, 10-bit H.264, AC-3, DTS, MP2) AND catches Xtream's
    // notorious HTTP 200 10-second "Region / ISP / Cloud IP Blocked" warning video!
    let probed: ProbedMediaInfo | null = null;
    if (upstream.statusCode >= 200 && upstream.statusCode < 300 && isMediaBytes && ffprobeAvailable) {
      // Brief pause so max_connections: 1 Xtream panels release the 2KB sample socket cleanly
      await new Promise((r) => setTimeout(r, 250));
      const probeInput = `http://127.0.0.1:${activePort}${makeProxyUrl(targetUrl, ua, referer, {
        clientIp,
        acceptLanguage,
      })}`;
      probed = await runFfprobeOnStream(probeInput, 6500);
    }

    const dur = probed?.duration;
    const isVodType = mediaType === 'movie' || mediaType === 'episode';
    const isFiniteShortClipOnVod = isVodType && typeof dur === 'number' && dur >= 2 && dur <= 35;
    const isFiniteShortMp4OnLive =
      mediaType === 'live' &&
      typeof dur === 'number' &&
      dur >= 2 &&
      dur <= 35 &&
      Boolean(probed?.formatName && /mp4|mov|matroska|webm/i.test(probed.formatName) && !probed.formatName.includes('hls'));
    const suspectedBanVideo = isFiniteShortClipOnVod || isFiniteShortMp4OnLive;

    const finalGeoBlocked = geoCheck.geoBlocked || suspectedBanVideo;

    let reason: string;
    if (suspectedBanVideo) {
      const dimsText = probed?.width && probed?.height ? ` (${probed.width}×${probed.height})` : '';
      reason = `Provider returned HTTP 200 with a short ${Math.round(dur!)}s video clip${dimsText} instead of the real stream — classic Xtream Region/GeoIP or Cloud-IP warning video! Use Local IP Bridge to stream directly from your own home IP.`;
    } else if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      if (probed?.needsTranscode) {
        const vLabel = `${(probed.videoCodec || 'UNKNOWN').toUpperCase()}${
          probed.videoPixFmt && /10/i.test(probed.videoPixFmt) ? ' 10-bit' : ''
        }`;
        const aLabel = probed.audioCodec ? ` + ${probed.audioCodec.toUpperCase()}` : '';
        reason = `Stream uses ${vLabel}${aLabel} codec, which browsers cannot decode natively. Click Compatibility Mode (H.264 + AAC) to play immediately.`;
      } else if (probed?.needsAudioFix) {
        reason = `Stream uses ${(probed.audioCodec || 'surround').toUpperCase()} audio (${(
          probed.videoCodec || 'H264'
        ).toUpperCase()} video). Click Compatibility Mode to convert audio to browser-safe AAC.`;
      } else if (isMediaBytes) {
        reason = 'Stream reachable and delivering valid media data.';
      } else if (geoCheck.geoBlocked && geoCheck.reason) {
        reason = geoCheck.reason;
      } else {
        reason = 'Stream responded HTTP 200.';
      }
    } else {
      reason = geoCheck.reason || `Provider returned HTTP ${upstream.statusCode}`;
    }

    res.json({
      ok: true,
      reachable: true,
      statusCode: upstream.statusCode,
      transport: usedTransport,
      finalUrl: upstream.finalUrl,
      contentType: ct || (isBinarySample ? 'video/mp2t' : 'unknown'),
      isMediaBytes,
      geoBlocked: finalGeoBlocked,
      suspectedBanVideo,
      errorKind: suspectedBanVideo
        ? 'geo_ban_video'
        : upstream.statusCode >= 400
        ? geoCheck.errorKind
        : 'ok',
      reason,
      snippet: geoCheck.upstreamSnippet,
      httpsDirectCandidate,
      videoCodec: probed?.videoCodec,
      videoPixFmt: probed?.videoPixFmt,
      audioCodec: probed?.audioCodec,
      width: probed?.width,
      height: probed?.height,
      duration: probed?.duration,
      formatName: probed?.formatName,
      needsAudioFix: probed?.needsAudioFix,
      needsTranscode: probed?.needsTranscode,
      recommendedMode: probed?.recommendedMode,
      serverRegion: 'europe-west1 (Belgium)',
      clientIpDetected: Boolean(clientIp),
    });
  });

  // ==========================================================================
  // 7c. IPFLIX LOCAL TURKISH IP BRIDGE DOWNLOAD (Runs on user's PC/Mac at
  //     http://127.0.0.1:8787 -> 100% User's Own Home IP, Zero Geo-Blocks,
  //     Zero Mixed Content, Full CORS + Private Network Access!)
  // ==========================================================================
  function buildLocalBridgeNodeScript(): string {
    return `#!/usr/bin/env node
// IPFLIX Local IP Bridge v2.0 (http://127.0.0.1:8787)
// Routes IPTV streams directly through YOUR own home internet IP with full CORS,
// Chrome Private Network Access support, User-Agent retry, HLS manifest rewriting,
// and optional local FFmpeg H.264/AAC Compatibility Mode!
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const DEFAULT_UA = 'IPTVSmartersPro';
const FALLBACK_UAS = [
  'IPTVSmartersPro',
  'VLC/3.0.20 LibVLC/3.0.20',
  'ExoPlayerLib/2.18.1',
  'TiviMate/4.7.0 (Linux; Android 13)',
];

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const httpAgent = new http.Agent({ keepAlive: false });

let ffmpegReady = false;
function detectLocalFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 2500 }, (err) => {
      ffmpegReady = !err;
      resolve(ffmpegReady);
    });
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-IPFLIX-Bridge, X-IPFLIX-Final-Url, X-IPFLIX-Remux-Mode'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('X-IPFLIX-Bridge', '2.0');
}

function guessCt(urlStr, rawCt) {
  const clean = String(rawCt || '').trim();
  if (clean && !clean.toLowerCase().includes('octet-stream') && !clean.toLowerCase().includes('text/plain')) {
    return clean;
  }
  const lower = String(urlStr || '').toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'application/vnd.apple.mpegurl';
  if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'video/mp2t';
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.webm')) return 'video/webm';
  return clean || 'application/octet-stream';
}

function makeBridgeUrl(targetUrl, ua, ref) {
  const qs = new URLSearchParams({ url: targetUrl });
  if (ua) qs.set('ua', ua);
  if (ref) qs.set('ref', ref);
  return 'http://' + HOST + ':' + PORT + '/stream?' + qs.toString();
}

function rewriteM3u8(text, baseUrl, ua, ref) {
  const lines = text.split(/\\r?\\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
          try {
            const abs = new URL(uri.trim(), baseUrl).toString();
            return 'URI="' + makeBridgeUrl(abs, ua, ref) + '"';
          } catch {
            return _m;
          }
        });
      }
      try {
        const abs = new URL(trimmed, baseUrl).toString();
        return makeBridgeUrl(abs, ua, ref);
      } catch {
        return line;
      }
    })
    .join('\\n');
}

function fetchUpstreamOnce(targetUrl, opts, redirectsLeft = 10, cookies = []) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Unsupported protocol'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = {
      'User-Agent': opts.ua || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': opts.range ? 'identity' : 'gzip, deflate, identity',
      Connection: 'close',
    };
    if (opts.ref) headers.Referer = opts.ref;
    if (opts.range) headers.Range = opts.range;
    if (cookies.length > 0) headers.Cookie = cookies.join('; ');

    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
        insecureHTTPParser: true,
        timeout: 16000,
      },
      (res) => {
        const status = res.statusCode || 0;
        const nextCookies = [...cookies];
        const sc = res.headers['set-cookie'];
        if (Array.isArray(sc)) {
          for (const raw of sc) {
            const pair = raw.split(';')[0]?.trim();
            if (pair) {
              const name = pair.split('=')[0];
              const idx = nextCookies.findIndex((c) => c.startsWith(name + '='));
              if (idx >= 0) nextCookies[idx] = pair;
              else nextCookies.push(pair);
            }
          }
        }
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          try {
            const nextUrl = new URL(res.headers.location.trim().replace(/ /g, '%20'), targetUrl).toString();
            fetchUpstreamOnce(nextUrl, opts, redirectsLeft - 1, nextCookies).then(resolve).catch(reject);
          } catch (e) {
            reject(e);
          }
          return;
        }
        req.setTimeout(0);
        resolve({ statusCode: status, headers: res.headers, finalUrl: targetUrl, stream: res, req, usedUa: opts.ua || DEFAULT_UA });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchUpstreamSmart(targetUrl, opts) {
  const candidates = [opts.ua || DEFAULT_UA, ...FALLBACK_UAS.filter((u) => u !== (opts.ua || DEFAULT_UA))];
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await fetchUpstreamOnce(targetUrl, { ...opts, ua: candidates[i] });
      if ([401, 403, 405, 406].includes(res.statusCode) && i < candidates.length - 1) {
        res.stream.destroy();
        res.req.destroy();
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Upstream request failed');
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip') || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
      return zlib.gunzipSync(buf);
    }
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch {
    // ignore
  }
  return buf;
}

function isBadVideoLog(log) {
  const inp = log.split(/Output #0/i)[0] || log;
  const lines = inp.match(/Stream #\\d+:\\d+[^\\n]*Video:\\s*([^\\n]+)/gi) || [];
  for (const line of lines) {
    if (/attached pic|mjpeg|png|webp/i.test(line)) continue;
    const m = line.match(/Video:\\s*([a-z0-9_]+)/i);
    const codec = (m?.[1] || '').toLowerCase();
    if (!codec) continue;
    if (codec !== 'h264') return true;
    if (/high 10|yuv420p10|yuv422p|yuv444p|10le|10be/i.test(line)) return true;
    return false;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);

  if (reqUrl.pathname === '/health' || reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        bridge: 'ipflix-local-tr-bridge',
        version: '2.0',
        port: PORT,
        ffmpeg: ffmpegReady,
      })
    );
    return;
  }

  if (reqUrl.pathname === '/remux') {
    if (!ffmpegReady) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local FFmpeg not installed' }));
      return;
    }
    const targetUrl = reqUrl.searchParams.get('url') || '';
    const ua = reqUrl.searchParams.get('ua') || DEFAULT_UA;
    const ref = reqUrl.searchParams.get('ref') || '';
    const initMode = reqUrl.searchParams.get('mode') === 'transcode' ? 'transcode' : 'audiofix';
    const isLive = reqUrl.searchParams.get('live') === '1';
    const startSec = Math.max(0, Number(reqUrl.searchParams.get('start') || 0) || 0);
    if (!targetUrl) {
      res.writeHead(400);
      res.end('Missing url');
      return;
    }
    const localInput = makeBridgeUrl(targetUrl, ua, ref);
    let activeChild = null;
    let closed = false;
    let started = false;
    res.on('close', () => {
      closed = true;
      if (activeChild && !activeChild.killed) {
        try { activeChild.kill('SIGKILL'); } catch {}
      }
    });
    const runMode = (mode) => {
      if (closed) return;
      const args = [
        '-hide_banner',
        '-loglevel', mode === 'audiofix' ? 'info' : 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-analyzeduration', isLive ? '2000000' : '3500000',
        '-probesize', isLive ? '2000000' : '3500000',
      ];
      if (!isLive && startSec > 0) args.push('-ss', String(startSec));
      args.push('-i', localInput, '-map', '0:V:0?', '-map', '0:a:0?', '-sn', '-dn');
      if (mode === 'transcode') {
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', '48', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      } else {
        args.push('-c:v', 'copy');
      }
      args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '2048', '-flush_packets', '1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      activeChild = ff;
      let errLog = '';
      let upgraded = false;
      let checked = mode === 'transcode';
      const pending = [];
      let pendingLen = 0;
      const emit = (buf) => {
        if (closed || res.writableEnded) return;
        if (!started) {
          started = true;
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-IPFLIX-Remux-Mode': mode });
        }
        if (!res.write(buf) && !ff.killed) {
          ff.stdout.pause();
          res.once('drain', () => { if (!closed && !ff.killed) ff.stdout.resume(); });
        }
      };
      const upgrade = () => {
        if (upgraded || started || closed) return;
        upgraded = true;
        try { ff.kill('SIGKILL'); } catch {}
        runMode('transcode');
      };
      ff.stderr.on('data', (d) => {
        if (errLog.length < 8192) errLog += d.toString('utf8');
        if (mode === 'audiofix' && !checked && !started && !upgraded) {
          if (isBadVideoLog(errLog)) { upgrade(); return; }
          if (/Output #0/i.test(errLog)) { checked = true; if (pending.length) emit(Buffer.concat(pending)); pending.length = 0; }
        }
      });
      ff.stdout.on('data', (chunk) => {
        if (closed || upgraded) return;
        if (!checked) {
          if (isBadVideoLog(errLog)) { upgrade(); return; }
          pending.push(chunk);
          pendingLen += chunk.length;
          if (/Output #0/i.test(errLog) || pendingLen >= 32768) {
            checked = true;
            emit(Buffer.concat(pending));
            pending.length = 0;
          }
          return;
        }
        emit(chunk);
      });
      ff.on('close', (code) => {
        if (closed || upgraded) return;
        if (!started && mode === 'audiofix' && code !== 0) { runMode('transcode'); return; }
        if (!started && pending.length && code === 0) emit(Buffer.concat(pending));
        if (!started && !res.headersSent) { res.writeHead(502); res.end('Remux failed'); }
        else if (!res.writableEnded) res.end();
      });
    };
    runMode(initMode);
    return;
  }

  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url') || '';
    const ua = reqUrl.searchParams.get('ua') || DEFAULT_UA;
    const ref = reqUrl.searchParams.get('ref') || '';
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const upstream = await fetchUpstreamSmart(targetUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        ua,
        ref,
        range: req.headers.range,
      });

      res.setHeader('X-IPFLIX-Final-Url', upstream.finalUrl);

      if (req.method === 'HEAD') {
        upstream.stream.resume();
        res.writeHead(upstream.statusCode, {
          'Content-Type': guessCt(upstream.finalUrl, upstream.headers['content-type']),
          ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
          'Accept-Ranges': upstream.headers['accept-ranges'] || 'bytes',
        });
        res.end();
        return;
      }

      const rawCt = String(upstream.headers['content-type'] || '');
      const lowerCt = rawCt.toLowerCase();
      const lowerFinal = upstream.finalUrl.toLowerCase().split('?')[0];
      const looksLikeM3u8 =
        lowerFinal.endsWith('.m3u8') ||
        lowerFinal.endsWith('.m3u') ||
        lowerCt.includes('mpegurl');

      if (upstream.statusCode >= 200 && upstream.statusCode < 300 && !req.headers.range && looksLikeM3u8) {
        const chunks = [];
        let total = 0;
        upstream.stream.on('data', (c) => {
          total += c.length;
          if (total <= 4 * 1024 * 1024) chunks.push(c);
        });
        upstream.stream.on('end', () => {
          const decoded = decompress(Buffer.concat(chunks), upstream.headers['content-encoding']);
          const text = decoded.toString('utf8');
          if (text.trimStart().startsWith('#EXTM3U')) {
            const rewritten = rewriteM3u8(text, upstream.finalUrl, upstream.usedUa || ua, ref);
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
              'Cache-Control': 'no-cache, no-store',
            });
            res.end(rewritten);
          } else {
            res.writeHead(200, { 'Content-Type': guessCt(upstream.finalUrl, rawCt) });
            res.end(decoded);
          }
        });
        upstream.stream.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        res.on('close', () => {
          upstream.stream.destroy();
          upstream.req.destroy();
        });
        return;
      }

      const outHeaders = {
        'Content-Type': guessCt(upstream.finalUrl, rawCt),
        'Accept-Ranges': upstream.headers['accept-ranges'] || 'bytes',
        'Cache-Control': 'no-store',
      };
      if (upstream.headers['content-length']) outHeaders['Content-Length'] = upstream.headers['content-length'];
      if (upstream.headers['content-range']) outHeaders['Content-Range'] = upstream.headers['content-range'];

      res.writeHead(upstream.statusCode, outHeaders);
      res.on('close', () => {
        upstream.stream.destroy();
        upstream.req.destroy();
      });
      upstream.stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      upstream.stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Bridge error' }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

detectLocalFfmpeg().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('==============================================================');
    console.log('  IPFLIX Local IP Bridge v2.0 AKTIF / ACTIVE (Node.js)');
    console.log('  Adres / Address : http://' + HOST + ':' + PORT);
    console.log('  Local FFmpeg    : ' + (ffmpegReady ? 'HAZIR / READY' : 'Yok (Standart Mod)'));
    console.log('  Kendi internet IP adresinizle bolge kisitlamasiz yayin!');
    console.log('  Bu pencereyi IPFLIX izlerken acik tutun (Kapatmak: Ctrl+C)');
    console.log('==============================================================');
    console.log('');
  });
});
`;
  }

  function buildLocalBridgePythonScript(): string {
    return `#!/usr/bin/env python3
import gzip
import json
import os
import re
import shutil
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8787"))
HOST = "127.0.0.1"
DEFAULT_UA = "IPTVSmartersPro"
FALLBACK_UAS = ["IPTVSmartersPro", "VLC/3.0.20 LibVLC/3.0.20", "ExoPlayerLib/2.18.1"]
SSL_CTX = ssl._create_unverified_context()
HAS_FFMPEG = bool(shutil.which("ffmpeg"))

def guess_ct(url_str, raw_ct):
    clean = (raw_ct or "").strip()
    if clean and "octet-stream" not in clean.lower() and "text/plain" not in clean.lower():
        return clean
    lower = (url_str or "").lower().split("?")[0]
    if lower.endswith((".m3u8", ".m3u")):
        return "application/vnd.apple.mpegurl"
    if lower.endswith((".ts", ".m2ts")):
        return "video/mp2t"
    if lower.endswith((".mp4", ".m4v")):
        return "video/mp4"
    if lower.endswith(".mkv"):
        return "video/x-matroska"
    if lower.endswith(".webm"):
        return "video/webm"
    return clean or "application/octet-stream"

def make_bridge_url(target_url, ua, ref):
    q = {"url": target_url}
    if ua:
        q["ua"] = ua
    if ref:
        q["ref"] = ref
    return f"http://{HOST}:{PORT}/stream?{urllib.parse.urlencode(q)}"

def rewrite_m3u8(text, base_url, ua, ref):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith("#"):
            def repl(m):
                abs_u = urllib.parse.urljoin(base_url, m.group(1).strip())
                return f'URI="{make_bridge_url(abs_u, ua, ref)}"'
            out.append(re.sub(r'URI="([^"]+)"', repl, line, flags=re.I))
        else:
            abs_u = urllib.parse.urljoin(base_url, s)
            out.append(make_bridge_url(abs_u, ua, ref))
    return "\\n".join(out)

class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type, Accept, Origin")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-IPFLIX-Bridge, X-IPFLIX-Final-Url",
        )
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("X-IPFLIX-Bridge", "2.0")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._handle_stream(head_only=True)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/health"):
            body = json.dumps({
                "ok": True,
                "bridge": "ipflix-local-tr-bridge",
                "version": "2.0",
                "port": PORT,
                "ffmpeg": False,
            }).encode()
            self.send_response(200)
            self.send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._handle_stream(head_only=False)

    def _handle_stream(self, head_only=False):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/stream":
            self.send_response(404)
            self.send_cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        qs = urllib.parse.parse_qs(parsed.query)
        target_url = (qs.get("url") or [""])[0]
        ua = (qs.get("ua") or [DEFAULT_UA])[0]
        ref = (qs.get("ref") or [""])[0]
        if not target_url.startswith(("http://", "https://")):
            self.send_response(400)
            self.send_cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        uas = [ua] + [u for u in FALLBACK_UAS if u != ua]
        last_err = None
        for idx, try_ua in enumerate(uas):
            headers = {"User-Agent": try_ua, "Accept": "*/*"}
            if ref:
                headers["Referer"] = ref
            if self.headers.get("Range"):
                headers["Range"] = self.headers.get("Range")
            req = urllib.request.Request(target_url, headers=headers, method="HEAD" if head_only else "GET")
            try:
                with urllib.request.urlopen(req, timeout=16, context=SSL_CTX) as up:
                    final_url = up.geturl()
                    ct = up.headers.get("Content-Type", "")
                    lower_final = final_url.lower().split("?")[0]
                    if head_only:
                        self.send_response(up.status)
                        self.send_cors()
                        self.send_header("X-IPFLIX-Final-Url", final_url)
                        self.send_header("Content-Type", guess_ct(final_url, ct))
                        if up.headers.get("Content-Length"):
                            self.send_header("Content-Length", up.headers.get("Content-Length"))
                        self.send_header("Accept-Ranges", up.headers.get("Accept-Ranges", "bytes"))
                        self.end_headers()
                        return

                    if not self.headers.get("Range") and (lower_final.endswith(".m3u8") or lower_final.endswith(".m3u") or "mpegurl" in ct.lower()):
                        raw = up.read(4 * 1024 * 1024)
                        if up.headers.get("Content-Encoding", "").lower() == "gzip" or raw[:2] == b"\\x1f\\x8b":
                            try:
                                raw = gzip.decompress(raw)
                            except Exception:
                                pass
                        text = raw.decode("utf-8", errors="replace")
                        if text.lstrip().startswith("#EXTM3U"):
                            out = rewrite_m3u8(text, final_url, try_ua, ref).encode("utf-8")
                            self.send_response(200)
                            self.send_cors()
                            self.send_header("X-IPFLIX-Final-Url", final_url)
                            self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                            self.send_header("Cache-Control", "no-cache, no-store")
                            self.send_header("Content-Length", str(len(out)))
                            self.end_headers()
                            self.wfile.write(out)
                            return

                    self.send_response(up.status)
                    self.send_cors()
                    self.send_header("X-IPFLIX-Final-Url", final_url)
                    self.send_header("Content-Type", guess_ct(final_url, ct))
                    if up.headers.get("Content-Length"):
                        self.send_header("Content-Length", up.headers.get("Content-Length"))
                    if up.headers.get("Content-Range"):
                        self.send_header("Content-Range", up.headers.get("Content-Range"))
                    self.send_header("Accept-Ranges", up.headers.get("Accept-Ranges", "bytes"))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    while True:
                        chunk = up.read(32768)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                    return
            except urllib.error.HTTPError as he:
                last_err = he
                if he.code in (401, 403, 405, 406) and idx < len(uas) - 1:
                    continue
                body = json.dumps({"error": f"HTTP {he.code}"}).encode()
                self.send_response(he.code)
                self.send_cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)
                return
            except Exception as e:
                last_err = e

        body = json.dumps({"error": str(last_err or "Bridge error")}).encode()
        try:
            self.send_response(502)
            self.send_cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
        except Exception:
            pass

if __name__ == "__main__":
    print("")
    print("==============================================================")
    print("  IPFLIX Local IP Bridge v2.0 AKTIF / ACTIVE (Python)")
    print(f"  Adres / Address : http://{HOST}:{PORT}")
    print("  Kendi internet IP adresinizle bolge kisitlamasiz yayin!")
    print("  Bu pencereyi IPFLIX izlerken acik tutun (Kapatmak: Ctrl+C)")
    print("==============================================================")
    print("")
    ThreadingHTTPServer((HOST, PORT), BridgeHandler).serve_forever()
`;
  }

  function buildLocalBridgePowerShellScript(): string {
    return `$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class IpflixLocalBridge {
  private static int _port = 8787;

  public static void Run(int port) {
    _port = port;
    ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
    ServicePointManager.Expect100Continue = false;
    ServicePointManager.DefaultConnectionLimit = 64;
    try {
      ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
    } catch {}

    TcpListener listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    Console.WriteLine("");
    Console.WriteLine("==============================================================");
    Console.WriteLine("  IPFLIX Local IP Bridge v2.0 AKTIF / ACTIVE (Windows Native)");
    Console.WriteLine("  Adres / Address : http://127.0.0.1:" + port);
    Console.WriteLine("  Kendi internet IP adresinizle bolge kisitlamasiz yayin!");
    Console.WriteLine("  Bu pencereyi IPFLIX izlerken acik tutun (Kapatmak: Ctrl+C)");
    Console.WriteLine("==============================================================");
    Console.WriteLine("");

    while (true) {
      TcpClient client = listener.AcceptTcpClient();
      ThreadPool.QueueUserWorkItem(HandleClient, client);
    }
  }

  private static string CorsHeaders() {
    return "Access-Control-Allow-Origin: *\\r\\n"
      + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\\r\\n"
      + "Access-Control-Allow-Headers: Range, Content-Type, Accept, Origin\\r\\n"
      + "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type, X-IPFLIX-Bridge, X-IPFLIX-Final-Url\\r\\n"
      + "Access-Control-Allow-Private-Network: true\\r\\n"
      + "X-IPFLIX-Bridge: 2.0\\r\\n";
  }

  private static string GuessCt(string url, string rawCt) {
    string clean = (rawCt ?? "").Trim();
    if (!string.IsNullOrEmpty(clean) && !clean.ToLowerInvariant().Contains("octet-stream") && !clean.ToLowerInvariant().Contains("text/plain")) return clean;
    string lower = (url ?? "").ToLowerInvariant().Split('?')[0];
    if (lower.EndsWith(".m3u8") || lower.EndsWith(".m3u")) return "application/vnd.apple.mpegurl";
    if (lower.EndsWith(".ts") || lower.EndsWith(".m2ts")) return "video/mp2t";
    if (lower.EndsWith(".mp4") || lower.EndsWith(".m4v")) return "video/mp4";
    if (lower.EndsWith(".mkv")) return "video/x-matroska";
    if (lower.EndsWith(".webm")) return "video/webm";
    return string.IsNullOrEmpty(clean) ? "application/octet-stream" : clean;
  }

  private static Dictionary<string, string> ParseQuery(string query) {
    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    if (string.IsNullOrEmpty(query)) return map;
    string q = query.StartsWith("?") ? query.Substring(1) : query;
    foreach (string pair in q.Split('&')) {
      if (string.IsNullOrEmpty(pair)) continue;
      int eq = pair.IndexOf('=');
      if (eq < 0) map[Uri.UnescapeDataString(pair)] = "";
      else map[Uri.UnescapeDataString(pair.Substring(0, eq))] = Uri.UnescapeDataString(pair.Substring(eq + 1).Replace("+", " "));
    }
    return map;
  }

  private static string MakeBridgeUrl(string targetUrl, string ua, string referer) {
    StringBuilder sb = new StringBuilder();
    sb.Append("http://127.0.0.1:").Append(_port).Append("/stream?url=").Append(Uri.EscapeDataString(targetUrl));
    if (!string.IsNullOrEmpty(ua)) sb.Append("&ua=").Append(Uri.EscapeDataString(ua));
    if (!string.IsNullOrEmpty(referer)) sb.Append("&ref=").Append(Uri.EscapeDataString(referer));
    return sb.ToString();
  }

  private static string RewriteM3u8(string text, string baseUrl, string ua, string referer) {
    Uri baseUri = new Uri(baseUrl);
    string[] lines = Regex.Split(text, "\\r?\\n");
    for (int i = 0; i < lines.Length; i++) {
      string line = lines[i];
      string t = line.Trim();
      if (string.IsNullOrEmpty(t)) continue;
      if (t.StartsWith("#")) {
        lines[i] = Regex.Replace(line, "URI=\\"([^\\"]+)\\"", delegate(Match m) {
          try {
            Uri abs = new Uri(baseUri, m.Groups[1].Value.Trim());
            return "URI=\\"" + MakeBridgeUrl(abs.AbsoluteUri, ua, referer) + "\\"";
          } catch { return m.Value; }
        }, RegexOptions.IgnoreCase);
      } else {
        try {
          Uri abs = new Uri(baseUri, t);
          lines[i] = MakeBridgeUrl(abs.AbsoluteUri, ua, referer);
        } catch {}
      }
    }
    return string.Join("\\n", lines);
  }

  private static void WriteSimple(NetworkStream ns, int code, string reason, string ct, byte[] body) {
    byte[] payload = body ?? new byte[0];
    string head = "HTTP/1.1 " + code + " " + reason + "\\r\\n"
      + CorsHeaders()
      + "Content-Type: " + ct + "\\r\\n"
      + "Content-Length: " + payload.Length + "\\r\\n"
      + "Connection: close\\r\\n\\r\\n";
    byte[] hb = Encoding.ASCII.GetBytes(head);
    ns.Write(hb, 0, hb.Length);
    if (payload.Length > 0) ns.Write(payload, 0, payload.Length);
    ns.Flush();
  }

  private static void ApplyRange(HttpWebRequest req, string rangeHeader) {
    if (string.IsNullOrEmpty(rangeHeader)) return;
    Match m = Regex.Match(rangeHeader, @"bytes=(\\d*)-(\\d*)", RegexOptions.IgnoreCase);
    if (!m.Success) return;
    string s = m.Groups[1].Value;
    string e = m.Groups[2].Value;
    long startVal, endVal;
    if (!string.IsNullOrEmpty(s) && !string.IsNullOrEmpty(e) && long.TryParse(s, out startVal) && long.TryParse(e, out endVal)) {
      req.AddRange(startVal, endVal);
    } else if (!string.IsNullOrEmpty(s) && long.TryParse(s, out startVal)) {
      req.AddRange(startVal);
    }
  }

  private static void HandleClient(object state) {
    TcpClient client = (TcpClient)state;
    try {
      client.ReceiveTimeout = 10000;
      using (client)
      using (NetworkStream ns = client.GetStream()) {
        List<byte> reqBytes = new List<byte>();
        byte[] b = new byte[1];
        while (reqBytes.Count < 32768) {
          int n = ns.Read(b, 0, 1);
          if (n <= 0) break;
          reqBytes.Add(b[0]);
          int c = reqBytes.Count;
          if (c >= 4 && reqBytes[c-4]==13 && reqBytes[c-3]==10 && reqBytes[c-2]==13 && reqBytes[c-1]==10) break;
        }
        if (reqBytes.Count == 0) return;
        string rawReq = Encoding.ASCII.GetString(reqBytes.ToArray());
        string[] lines = rawReq.Split(new[] { "\\r\\n" }, StringSplitOptions.None);
        if (lines.Length == 0) return;
        string[] parts = lines[0].Split(' ');
        if (parts.Length < 2) return;
        string method = parts[0].ToUpperInvariant();
        string rawTarget = parts[1];

        string rangeHeader = null;
        for (int i = 1; i < lines.Length; i++) {
          int col = lines[i].IndexOf(':');
          if (col > 0) {
            string k = lines[i].Substring(0, col).Trim();
            string v = lines[i].Substring(col + 1).Trim();
            if (k.Equals("Range", StringComparison.OrdinalIgnoreCase)) rangeHeader = v;
          }
        }

        if (method == "OPTIONS") {
          WriteSimple(ns, 204, "No Content", "text/plain", null);
          return;
        }

        int qIdx = rawTarget.IndexOf('?');
        string path = qIdx >= 0 ? rawTarget.Substring(0, qIdx) : rawTarget;
        string query = qIdx >= 0 ? rawTarget.Substring(qIdx) : "";

        if (path == "/" || path == "/health") {
          string json = "{\\"ok\\":true,\\"bridge\\":\\"ipflix-local-tr-bridge\\",\\"version\\":\\"2.0\\",\\"port\\":" + _port + ",\\"ffmpeg\\":false}";
          WriteSimple(ns, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json));
          return;
        }

        if (path != "/stream") {
          WriteSimple(ns, 404, "Not Found", "text/plain", Encoding.UTF8.GetBytes("Not Found"));
          return;
        }

        var qs = ParseQuery(query);
        string targetUrl = qs.ContainsKey("url") ? qs["url"] : "";
        string ua = qs.ContainsKey("ua") && !string.IsNullOrEmpty(qs["ua"]) ? qs["ua"] : "IPTVSmartersPro";
        string referer = qs.ContainsKey("ref") ? qs["ref"] : "";
        if (string.IsNullOrEmpty(targetUrl) || (!targetUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !targetUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) {
          WriteSimple(ns, 400, "Bad Request", "application/json", Encoding.UTF8.GetBytes("{\\"error\\":\\"Missing url\\"}"));
          return;
        }

        HttpWebRequest upReq = (HttpWebRequest)WebRequest.Create(targetUrl);
        upReq.Method = method == "HEAD" ? "HEAD" : "GET";
        upReq.UserAgent = ua;
        upReq.Accept = "*/*";
        upReq.KeepAlive = false;
        upReq.AllowAutoRedirect = true;
        upReq.MaximumAutomaticRedirections = 10;
        upReq.Timeout = 16000;
        upReq.ReadWriteTimeout = 30000;
        if (!string.IsNullOrEmpty(referer)) upReq.Referer = referer;
        ApplyRange(upReq, rangeHeader);

        HttpWebResponse upRes = null;
        try {
          upRes = (HttpWebResponse)upReq.GetResponse();
        } catch (WebException we) {
          if (we.Response is HttpWebResponse) upRes = (HttpWebResponse)we.Response;
          else throw;
        }

        using (upRes) {
          int statusCode = (int)upRes.StatusCode;
          string finalUrl = upRes.ResponseUri != null ? upRes.ResponseUri.AbsoluteUri : targetUrl;
          string rawCt = upRes.ContentType ?? "";
          string lowerFinal = finalUrl.ToLowerInvariant().Split('?')[0];
          bool looksLikeM3u8 = string.IsNullOrEmpty(rangeHeader) && statusCode >= 200 && statusCode < 300 && method != "HEAD"
            && (lowerFinal.EndsWith(".m3u8") || lowerFinal.EndsWith(".m3u") || rawCt.ToLowerInvariant().Contains("mpegurl"));

          if (looksLikeM3u8) {
            using (Stream s = upRes.GetResponseStream())
            using (MemoryStream ms = new MemoryStream()) {
              byte[] buf = new byte[16384];
              int read;
              while ((read = s.Read(buf, 0, buf.Length)) > 0 && ms.Length < 4 * 1024 * 1024) ms.Write(buf, 0, read);
              byte[] raw = ms.ToArray();
              string enc = (upRes.ContentEncoding ?? "").ToLowerInvariant();
              if (enc.Contains("gzip") || (raw.Length >= 2 && raw[0] == 0x1f && raw[1] == 0x8b)) {
                try {
                  using (var gs = new GZipStream(new MemoryStream(raw), CompressionMode.Decompress))
                  using (var outMs = new MemoryStream()) { gs.CopyTo(outMs); raw = outMs.ToArray(); }
                } catch {}
              }
              string text = Encoding.UTF8.GetString(raw);
              if (text.TrimStart().StartsWith("#EXTM3U")) {
                byte[] rewritten = Encoding.UTF8.GetBytes(RewriteM3u8(text, finalUrl, ua, referer));
                WriteSimple(ns, 200, "OK", "application/vnd.apple.mpegurl; charset=utf-8", rewritten);
                return;
              }
              WriteSimple(ns, statusCode, upRes.StatusDescription ?? "OK", GuessCt(finalUrl, rawCt), raw);
              return;
            }
          }

          StringBuilder hdr = new StringBuilder();
          hdr.Append("HTTP/1.1 ").Append(statusCode).Append(" ").Append(upRes.StatusDescription ?? "OK").Append("\\r\\n");
          hdr.Append(CorsHeaders());
          hdr.Append("X-IPFLIX-Final-Url: ").Append(finalUrl).Append("\\r\\n");
          hdr.Append("Content-Type: ").Append(GuessCt(finalUrl, rawCt)).Append("\\r\\n");
          if (upRes.ContentLength >= 0) hdr.Append("Content-Length: ").Append(upRes.ContentLength).Append("\\r\\n");
          string cr = upRes.Headers["Content-Range"];
          if (!string.IsNullOrEmpty(cr)) hdr.Append("Content-Range: ").Append(cr).Append("\\r\\n");
          string ar = upRes.Headers["Accept-Ranges"];
          hdr.Append("Accept-Ranges: ").Append(string.IsNullOrEmpty(ar) ? "bytes" : ar).Append("\\r\\n");
          hdr.Append("Cache-Control: no-store\\r\\nConnection: close\\r\\n\\r\\n");
          byte[] hBytes = Encoding.ASCII.GetBytes(hdr.ToString());
          ns.Write(hBytes, 0, hBytes.Length);
          ns.Flush();

          if (method == "HEAD") return;

          using (Stream upStream = upRes.GetResponseStream()) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = upStream.Read(buf, 0, buf.Length)) > 0) {
              ns.Write(buf, 0, n);
            }
          }
        }
      }
    } catch {
      // client disconnected or upstream reset
    }
  }
}
'@
Add-Type -TypeDefinition $code
[IpflixLocalBridge]::Run(8787)
`;
  }

  function wrapBase64(text: string): string {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return b64.replace(/.{1,76}/g, '$&\n').trim();
  }

  app.get('/api/relay/download', (req: Request, res: Response) => {
    const osKind = String(req.query.os || 'node').toLowerCase();
    const nodeCode = buildLocalBridgeNodeScript();
    const pyCode = buildLocalBridgePythonScript();
    const psCode = buildLocalBridgePowerShellScript();

    if (osKind === 'win' || osKind === 'windows') {
      const jsB64 = wrapBase64(nodeCode);
      const pyB64 = wrapBase64(pyCode);
      const psB64 = wrapBase64(psCode);
      const bat = [
        '@echo off',
        'chcp 65001 >nul',
        'title IPFLIX Local IP Bridge v2.0 (127.0.0.1:8787)',
        'echo.',
        'echo IPFLIX Yerel IP Koprusu v2.0 baslatiliyor...',
        'where node >nul 2>nul',
        'if %errorlevel%==0 (',
        '  node -e "const fs=require(\'fs\'),os=require(\'os\'),p=require(\'path\');const t=fs.readFileSync(process.argv[1],\'utf8\');const m=t.match(/::JS_B64_START\\r?\\n([\\s\\S]*?)\\r?\\n::JS_B64_END/);const out=p.join(os.tmpdir(),\'ipflix-local-bridge.mjs\');fs.writeFileSync(out,Buffer.from(m[1].replace(/[^A-Za-z0-9+/=]/g,\'\'),\'base64\'));" "%~f0"',
        '  node "%TEMP%\\ipflix-local-bridge.mjs"',
        '  pause',
        '  exit /b 0',
        ')',
        'where python >nul 2>nul',
        'if %errorlevel%==0 (',
        '  python -c "import sys,re,base64,os,tempfile;t=open(sys.argv[1],encoding=\'utf-8\').read();m=re.search(r\'::PY_B64_START\\r?\\n([\\s\\S]*?)\\r?\\n::PY_B64_END\',t);out=os.path.join(tempfile.gettempdir(),\'ipflix-local-bridge.py\');open(out,\'wb\').write(base64.b64decode(re.sub(r\'[^A-Za-z0-9+/=]\',\'\',m.group(1))))" "%~f0"',
        '  python "%TEMP%\\ipflix-local-bridge.py"',
        '  pause',
        '  exit /b 0',
        ')',
        'where py >nul 2>nul',
        'if %errorlevel%==0 (',
        '  py -3 -c "import sys,re,base64,os,tempfile;t=open(sys.argv[1],encoding=\'utf-8\').read();m=re.search(r\'::PY_B64_START\\r?\\n([\\s\\S]*?)\\r?\\n::PY_B64_END\',t);out=os.path.join(tempfile.gettempdir(),\'ipflix-local-bridge.py\');open(out,\'wb\').write(base64.b64decode(re.sub(r\'[^A-Za-z0-9+/=]\',\'\',m.group(1))))" "%~f0"',
        '  py -3 "%TEMP%\\ipflix-local-bridge.py"',
        '  pause',
        '  exit /b 0',
        ')',
        'echo Node.js/Python bulunamadi - Windows dahili PowerShell motoru kullaniliyor...',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText(\'%~f0\');$m=[regex]::Match($t,\'::PS_B64_START\\r?\\n([\\s\\S]*?)\\r?\\n::PS_B64_END\');$out=Join-Path $env:TEMP \'ipflix-local-bridge.ps1\';[IO.File]::WriteAllBytes($out,[Convert]::FromBase64String(($m.Groups[1].Value -replace \'[^A-Za-z0-9+/=]\',\'\')));& $out"',
        'pause',
        'exit /b 0',
        '::JS_B64_START',
        jsB64,
        '::JS_B64_END',
        '::PY_B64_START',
        pyB64,
        '::PY_B64_END',
        '::PS_B64_START',
        psB64,
        '::PS_B64_END',
        '',
      ].join('\r\n');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="IPFLIX-TR-Bridge-Windows.bat"');
      res.send(bat);
      return;
    }

    if (osKind === 'mac' || osKind === 'linux') {
      const sh = [
        '#!/usr/bin/env bash',
        'set -e',
        'echo ""',
        'echo "IPFLIX Yerel IP Koprusu baslatiliyor..."',
        'if command -v node >/dev/null 2>&1; then',
        '  TMP_JS="$(mktemp /tmp/ipflix-bridge.XXXXXX.mjs)"',
        '  trap \'rm -f "$TMP_JS"\' EXIT',
        '  cat <<\'__IPFLIX_NODE_EOF__\' > "$TMP_JS"',
        nodeCode,
        '__IPFLIX_NODE_EOF__',
        '  node "$TMP_JS"',
        'elif command -v python3 >/dev/null 2>&1; then',
        '  TMP_PY="$(mktemp /tmp/ipflix-bridge.XXXXXX.py)"',
        '  trap \'rm -f "$TMP_PY"\' EXIT',
        '  cat <<\'__IPFLIX_PY_EOF__\' > "$TMP_PY"',
        pyCode,
        '__IPFLIX_PY_EOF__',
        '  python3 "$TMP_PY"',
        'else',
        '  echo "[HATA] Node.js veya Python 3 bulunamadi. https://nodejs.org adresinden kurabilirsiniz."',
        '  exit 1',
        'fi',
        '',
      ].join('\n');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="IPFLIX-TR-Bridge-MacLinux.command"');
      res.send(sh);
      return;
    }

    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ipflix-local-bridge.mjs"');
    res.send(nodeCode);
  });

  // ==========================================================================
  // 8. IMAGE PROXY (Prevents Mixed Content on HTTP IPTV logos & posters)
  // ==========================================================================
  app.get('/api/proxy/image', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    try {
      await assertSafeUpstreamUrl(targetUrl);
    } catch {
      res.sendStatus(400);
      return;
    }

    try {
      const result = await fetchBuffer(targetUrl, {
        userAgent: FALLBACK_USER_AGENTS[5],
        timeoutMs: 6000,
        maxBytes: 6 * 1024 * 1024,
      });

      if (result.statusCode >= 400) {
        res.sendStatus(404);
        return;
      }

      const ct = String(result.headers['content-type'] || 'image/jpeg');
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(result.body);
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.sendStatus(400);
        return;
      }
      res.sendStatus(404);
    }
  });

  // ==========================================================================
  // 9. GITHUB RELEASES MULTI-PLATFORM AUTO-UPDATE & SHA-256 VERIFICATION
  // ==========================================================================
  const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000;
  let updateCache: {
    etag: string | null;
    checkedAt: number;
    releases: GitHubReleaseRecord[];
    manifest: ParsedReleaseManifest | null;
    checksumText: string | null;
  } | null = null;

  const VALID_UPDATE_CHANNELS = new Set<DistributionChannel>([
    'windows_electron',
    'android_apk',
    'google_play',
    'android_tv_apk',
    'android_tv_play',
    'web',
  ]);

  function fetchVerifiedGitHubText(
    rawUrl: string,
    etag?: string | null,
    redirectsLeft = 5
  ): Promise<{ statusCode: number; etag: string | null; text: string }> {
    if (!isAllowedGitHubUrl(rawUrl)) {
      return Promise.reject(new BlockedUrlError('Engellenmiş güncelleme adresi'));
    }
    return new Promise((resolve, reject) => {
      const parsed = new URL(rawUrl);
      const headers: Record<string, string> = {
        'User-Agent': `IPFlix-Server/${APP_VERSION}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (etag) headers['If-None-Match'] = etag;

      const req = https.get(
        {
          protocol: 'https:',
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          headers,
          rejectUnauthorized: true,
          timeout: 15000,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode || 0;
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            upstreamRes.headers.location &&
            redirectsLeft > 0
          ) {
            upstreamRes.resume();
            let nextUrl: string;
            try {
              nextUrl = new URL(upstreamRes.headers.location, rawUrl).toString();
            } catch {
              reject(new BlockedUrlError('Geçersiz güncelleme yönlendirmesi'));
              return;
            }
            fetchVerifiedGitHubText(nextUrl, etag, redirectsLeft - 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          upstreamRes.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > 4 * 1024 * 1024) {
              req.destroy();
              reject(new Error('GitHub yanıt boyutu sınırı aşıldı'));
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            resolve({
              statusCode: status,
              etag: typeof upstreamRes.headers.etag === 'string' ? upstreamRes.headers.etag : null,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('GitHub API isteği zaman aşımına uğradı')));
      req.on('error', reject);
    });
  }

  function downloadVerifiedGitHubBinary(
    rawUrl: string,
    redirectsLeft = 6
  ): Promise<{ buffer: Buffer; sha256: string }> {
    if (!isAllowedGitHubUrl(rawUrl)) {
      return Promise.reject(new BlockedUrlError('Güvenilmeyen güncelleme indirme adresi'));
    }
    return new Promise((resolve, reject) => {
      const parsed = new URL(rawUrl);
      const maxBytes = 180 * 1024 * 1024;
      const req = https.get(
        {
          protocol: 'https:',
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            'User-Agent': `IPFlix-Server/${APP_VERSION}`,
            Accept: 'application/octet-stream',
          },
          rejectUnauthorized: true,
          timeout: 30000,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode || 0;
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            upstreamRes.headers.location &&
            redirectsLeft > 0
          ) {
            upstreamRes.resume();
            let nextUrl: string;
            try {
              nextUrl = new URL(upstreamRes.headers.location, rawUrl).toString();
            } catch {
              reject(new BlockedUrlError('Geçersiz indirme yönlendirmesi'));
              return;
            }
            downloadVerifiedGitHubBinary(nextUrl, redirectsLeft - 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            upstreamRes.resume();
            reject(new Error(`Kurulum dosyası indirilemedi (HTTP ${status})`));
            return;
          }

          const chunks: Buffer[] = [];
          const hash = crypto.createHash('sha256');
          let total = 0;

          upstreamRes.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              req.destroy();
              reject(new Error('Kurulum paketi 180MB sınırını aşıyor'));
              return;
            }
            hash.update(chunk);
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            resolve({
              buffer: Buffer.concat(chunks),
              sha256: hash.digest('hex').toLowerCase(),
            });
          });
          upstreamRes.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('İndirme bağlantısı zaman aşımına uğradı')));
      req.on('error', reject);
    });
  }

  app.get('/api/updates/check', async (req: Request, res: Response) => {
    const rawChannel = String(req.query.channel || 'web') as DistributionChannel;
    const channel: DistributionChannel = VALID_UPDATE_CHANNELS.has(rawChannel)
      ? rawChannel
      : 'web';
    const currentVersion =
      typeof req.query.currentVersion === 'string' && req.query.currentVersion.trim()
        ? req.query.currentVersion.trim()
        : APP_VERSION;
    const force = req.query.force === '1' || req.query.force === 'true';
    const now = Date.now();

    if (isPlayStoreChannel(channel)) {
      res.json(
        buildUpdateCheckResultFromRelease({
          releases: [],
          channel,
          currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
        })
      );
      return;
    }

    if (!force && updateCache && now - updateCache.checkedAt < UPDATE_CACHE_TTL_MS) {
      res.json(
        buildUpdateCheckResultFromRelease({
          releases: updateCache.releases,
          channel,
          currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          manifestOverride: updateCache.manifest,
          checksumTextOverride: updateCache.checksumText,
          cached: true,
          checkedAt: updateCache.checkedAt,
        })
      );
      return;
    }

    try {
      const ghRes = await fetchVerifiedGitHubText(
        GITHUB_RELEASES_API,
        force ? null : updateCache?.etag
      );

      if (ghRes.statusCode === 304 && updateCache) {
        updateCache.checkedAt = now;
        res.json(
          buildUpdateCheckResultFromRelease({
            releases: updateCache.releases,
            channel,
            currentVersion,
            currentVersionCode: APP_VERSION_CODE,
            manifestOverride: updateCache.manifest,
            checksumTextOverride: updateCache.checksumText,
            cached: true,
            checkedAt: now,
          })
        );
        return;
      }

      if (ghRes.statusCode === 404) {
        updateCache = {
          etag: ghRes.etag,
          checkedAt: now,
          releases: [],
          manifest: null,
          checksumText: null,
        };
        res.json(
          buildUpdateCheckResultFromRelease({
            releases: [],
            channel,
            currentVersion,
            currentVersionCode: APP_VERSION_CODE,
            checkedAt: now,
          })
        );
        return;
      }

      if (ghRes.statusCode === 403 || ghRes.statusCode === 429) {
        if (updateCache) {
          res.json(
            buildUpdateCheckResultFromRelease({
              releases: updateCache.releases,
              channel,
              currentVersion,
              currentVersionCode: APP_VERSION_CODE,
              manifestOverride: updateCache.manifest,
              checksumTextOverride: updateCache.checksumText,
              cached: true,
              checkedAt: updateCache.checkedAt,
            })
          );
          return;
        }
        res.status(503).json({
          status: 'error',
          channel,
          currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
          cached: false,
          updateAvailable: false,
          isExternalApkAllowed: true,
          error: 'GitHub API istek limiti doldu. Lütfen biraz sonra tekrar deneyin.',
        });
        return;
      }

      if (ghRes.statusCode < 200 || ghRes.statusCode >= 300) {
        res.status(502).json({
          status: 'error',
          channel,
          currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          checkedAt: now,
          cached: false,
          updateAvailable: false,
          isExternalApkAllowed: true,
          error: `GitHub Releases yanıt hatası (HTTP ${ghRes.statusCode}).`,
        });
        return;
      }

      const rawParsed = JSON.parse(ghRes.text) as GitHubReleaseRecord | GitHubReleaseRecord[];
      const releases = Array.isArray(rawParsed) ? rawParsed : rawParsed ? [rawParsed] : [];
      const prelim = buildUpdateCheckResultFromRelease({
        releases,
        channel,
        currentVersion,
        currentVersionCode: APP_VERSION_CODE,
        checkedAt: now,
      });

      let manifest: ParsedReleaseManifest | null = null;
      let checksumText: string | null = null;
      const latestRelease = releases.find((r) => r && !r.draft && !r.prerelease) || releases[0];

      if (latestRelease && Array.isArray(latestRelease.assets)) {
        const { manifestUrl, checksumUrls } = findChecksumAssetUrls(
          latestRelease.assets,
          prelim.latest?.assetName || null
        );
        if (manifestUrl) {
          try {
            const mRes = await fetchVerifiedGitHubText(manifestUrl);
            if (mRes.statusCode >= 200 && mRes.statusCode < 300) {
              manifest = JSON.parse(mRes.text) as ParsedReleaseManifest;
            }
          } catch {
            // Optional manifest file
          }
        }
        for (const cUrl of checksumUrls) {
          try {
            const cRes = await fetchVerifiedGitHubText(cUrl);
            if (cRes.statusCode >= 200 && cRes.statusCode < 300 && cRes.text.trim()) {
              checksumText = (checksumText ? `${checksumText}\n` : '') + cRes.text.trim();
            }
          } catch {
            // Optional checksum file
          }
        }
      }

      updateCache = {
        etag: ghRes.etag,
        checkedAt: now,
        releases,
        manifest,
        checksumText,
      };

      res.json(
        buildUpdateCheckResultFromRelease({
          releases,
          channel,
          currentVersion,
          currentVersionCode: APP_VERSION_CODE,
          manifestOverride: manifest,
          checksumTextOverride: checksumText,
          cached: false,
          checkedAt: now,
        })
      );
    } catch (err) {
      res.status(502).json({
        status: 'error',
        channel,
        currentVersion,
        currentVersionCode: APP_VERSION_CODE,
        checkedAt: now,
        cached: false,
        updateAvailable: false,
        isExternalApkAllowed: true,
        error: err instanceof Error ? err.message : 'Güncelleme kontrolü başarısız oldu.',
      });
    }
  });

  app.get('/api/updates/download', async (req: Request, res: Response) => {
    const channelRaw = String(req.query.channel || 'android_apk') as DistributionChannel;
    if (isPlayStoreChannel(channelRaw)) {
      res.status(403).json({
        error: 'Google Play Store kanalında harici APK indirme kapalıdır.',
      });
      return;
    }

    const targetUrl = String(req.query.url || '').trim();
    const expectedSha256 = String(req.query.sha256 || '').trim().toLowerCase();
    const rawName = path.basename(String(req.query.name || 'IPFlix-Update.apk').trim());

    if (!isAllowedGitHubUrl(targetUrl)) {
      res.status(400).json({ error: 'Yalnızca doğrulanmış GitHub HTTPS indirme adreslerine izin verilir.' });
      return;
    }
    if (!isValidSha256Hex(expectedSha256)) {
      res.status(400).json({ error: 'Güvenlik gereği geçerli bir SHA-256 doğrulama özeti gereklidir.' });
      return;
    }
    if (!/^[a-zA-Z0-9._-]+\.(apk|exe)$/i.test(rawName)) {
      res.status(400).json({ error: 'Geçersiz paket dosya adı.' });
      return;
    }

    try {
      const downloaded = await downloadVerifiedGitHubBinary(targetUrl);
      if (downloaded.sha256 !== expectedSha256) {
        res.status(422).json({
          error: 'SHA-256 doğrulaması başarısız! Paket bütünlüğü doğrulanamadı.',
        });
        return;
      }

      const contentType = rawName.toLowerCase().endsWith('.apk')
        ? 'application/vnd.android.package-archive'
        : 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${rawName}"`);
      res.setHeader('Content-Length', String(downloaded.buffer.length));
      res.setHeader('X-Content-SHA256', downloaded.sha256);
      res.setHeader('Cache-Control', 'no-store');
      res.send(downloaded.buffer);
    } catch (err) {
      res.status(err instanceof BlockedUrlError ? 400 : 502).json({
        error: err instanceof Error ? err.message : 'Paket indirilemedi.',
      });
    }
  });

  // ==========================================================================
  // VITE DEV MIDDLEWARE OR PRODUCTION STATIC SERVING
  // ==========================================================================
  if (!isProduction) {
    // Serve public/ directly before Vite middleware so newly created static assets
    // (icons, logos, intro audio) resolve with proper MIME types & Range support
    // even when DISABLE_HMR disables Vite's file watcher.
    const publicDir = path.resolve(SERVER_DIR, 'public');
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir, { index: false }));
    }
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = process.env.IPFLIX_DIST_DIR
      ? path.resolve(process.env.IPFLIX_DIST_DIR)
      : path.resolve(SERVER_DIR, 'dist');
    app.use(express.static(distDir, { maxAge: '1d' }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      activePort = addr.port;
    }
    console.log(
      `IPFLIX server listening on http://${HOST}:${activePort} (FFmpeg: ${ffmpegAvailable ? 'enabled' : 'unavailable'})`
    );
    if (typeof process.send === 'function') {
      try {
        process.send({
          type: 'ready',
          port: activePort,
          host: HOST,
          ffmpegAvailable,
        });
      } catch {
        // ignore if parent IPC channel already closed
      }
    }
  });

  server.on('error', (err) => {
    console.error('IPFLIX server failed to bind:', err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const proc of activeFfmpegProcesses) {
      try {
        proc.kill(isWindows ? undefined : 'SIGKILL');
      } catch {
        // ignore
      }
    }
    activeFfmpegProcesses.clear();

    for (const proc of activeCurlProcesses) {
      try {
        proc.kill(isWindows ? undefined : 'SIGKILL');
      } catch {
        // ignore
      }
    }
    activeCurlProcesses.clear();

    // Immediately release open keep-alive / stream sockets so Electron exits cleanly
    if (typeof server.closeAllConnections === 'function') {
      try {
        server.closeAllConnections();
      } catch {
        // ignore
      }
    }

    const forceExitTimer = setTimeout(() => process.exit(0), 2000);
    forceExitTimer.unref();

    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('message', (msg) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') {
      shutdown();
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start IPFLIX server:', err);
  process.exit(1);
});
