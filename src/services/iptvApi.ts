import type {
  EpgProgram,
  EpisodeItem,
  LiveChannel,
  MovieItem,
  PlaylistCatalog,
  PlaylistSource,
  SeasonGroup,
  SeriesItem,
  XtreamAccountInfo,
} from '../types/iptv';
import { resolveApiUrl } from './androidBridge';

export interface XtreamAuthResponse {
  ok: boolean;
  mode?: 'xtream' | 'm3u_fallback';
  m3uUrl?: string;
  resolvedServerUrl?: string;
  workingUserAgent?: string;
  username?: string;
  userInfo?: XtreamAccountInfo;
  error?: string;
  diagnostics?: string[];
}

export interface StreamProbeResult {
  ok: boolean;
  probed?: boolean;
  ffmpegAvailable?: boolean;
  formatName?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number;
  bitrate?: number;
  needsAudioFix?: boolean;
  needsTranscode?: boolean;
  recommendedMode?: 'direct' | 'hls' | 'mpegts' | 'audiofix' | 'transcode';
}

export interface StreamResolveResult {
  ok: boolean;
  directHttpsUrls: string[];
  redirectedUrl?: string;
  corsAllowed?: boolean;
  geoBlockedOnProxy?: boolean;
  upstreamStatus?: number;
  upstreamMessage?: string;
}

export interface StreamDiagnoseResult {
  ok: boolean;
  reachable?: boolean;
  statusCode?: number;
  transport?: 'node' | 'curl';
  finalUrl?: string;
  contentType?: string;
  isMediaBytes?: boolean;
  geoBlocked?: boolean;
  suspectedBanVideo?: boolean;
  errorKind?: string;
  reason?: string;
  snippet?: string;
  httpsDirectCandidate?: string;
  videoCodec?: string;
  videoPixFmt?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number;
  formatName?: string;
  needsAudioFix?: boolean;
  needsTranscode?: boolean;
  recommendedMode?: 'direct' | 'hls' | 'mpegts' | 'audiofix' | 'transcode';
  serverRegion?: string;
  clientIpDetected?: boolean;
}

export interface ServerCapabilities {
  ok: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
}

export async function diagnoseStream(
  url: string,
  userAgent?: string,
  referer?: string,
  mediaType?: 'live' | 'movie' | 'episode' | 'local'
): Promise<StreamDiagnoseResult> {
  try {
    const params = new URLSearchParams({ url });
    if (userAgent) params.set('ua', userAgent);
    if (referer) params.set('ref', referer);
    if (mediaType && mediaType !== 'local') params.set('type', mediaType);
    const res = await fetch(resolveApiUrl(`/api/proxy/diagnose?${params.toString()}`));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return (await res.json()) as StreamDiagnoseResult;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Diagnostics failed' };
  }
}

export async function checkServerCapabilities(): Promise<ServerCapabilities> {
  try {
    const res = await fetch(resolveApiUrl('/api/health'));
    if (!res.ok) return { ok: false, ffmpegAvailable: false, ffprobeAvailable: false };
    return (await res.json()) as ServerCapabilities;
  } catch {
    return { ok: false, ffmpegAvailable: false, ffprobeAvailable: false };
  }
}

export function buildProxiedImageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  // Local app assets and blob/data URLs pass directly
  if (trimmed.startsWith('/') || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed;
  }
  // Proxy HTTP URLs on HTTPS pages (and IPTV provider URLs with custom ports) to prevent mixed content
  if (trimmed.startsWith('http://') || /:\d{2,5}\//.test(trimmed)) {
    return resolveApiUrl(`/api/proxy/image?url=${encodeURIComponent(trimmed)}`);
  }
  return trimmed;
}

function toAbsoluteProxyUrl(relativePath: string): string {
  if (!relativePath || /^https?:\/\//i.test(relativePath) || relativePath.startsWith('blob:')) {
    return relativePath;
  }
  const resolved = resolveApiUrl(relativePath);
  if (/^https?:\/\//i.test(resolved)) {
    return resolved;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(resolved, window.location.origin).toString();
    } catch {
      return resolved;
    }
  }
  return resolved;
}

export function buildProxiedStreamUrl(
  url: string,
  options: {
    useProxy: boolean;
    userAgent?: string;
    referer?: string;
    isLocalBlob?: boolean;
    manifestOnly?: boolean;
  }
): string {
  if (!url || options.isLocalBlob || url.startsWith('blob:')) {
    return url;
  }
  if (url.startsWith('/api/')) {
    return toAbsoluteProxyUrl(url);
  }
  if (!options.useProxy) return url;
  const params = new URLSearchParams({ url });
  if (options.userAgent) params.set('ua', options.userAgent);
  if (options.referer) params.set('ref', options.referer);
  if (options.manifestOnly) params.set('manifestOnly', '1');
  return toAbsoluteProxyUrl(`/api/proxy/stream?${params.toString()}`);
}

export async function resolveDirectStreamUrls(options: {
  url: string;
  altUrl?: string;
  httpsUrl?: string;
  userAgent?: string;
  referer?: string;
}): Promise<StreamResolveResult> {
  try {
    const params = new URLSearchParams({ url: options.url });
    if (options.altUrl) params.set('altUrl', options.altUrl);
    if (options.httpsUrl) params.set('httpsUrl', options.httpsUrl);
    if (options.userAgent) params.set('ua', options.userAgent);
    if (options.referer) params.set('ref', options.referer);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3500);
    const res = await fetch(resolveApiUrl(`/api/proxy/resolve?${params.toString()}`), {
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return { ok: false, directHttpsUrls: [] };
    return (await res.json()) as StreamResolveResult;
  } catch {
    return { ok: false, directHttpsUrls: [] };
  }
}

export function buildRemuxUrl(
  url: string,
  options: {
    mode: 'audiofix' | 'transcode';
    format?: 'mp4' | 'ts';
    userAgent?: string;
    referer?: string;
    startSeconds?: number;
    isLive?: boolean;
  }
): string {
  const params = new URLSearchParams({
    url,
    mode: options.mode,
    live: options.isLive ? '1' : '0',
  });
  if (options.format === 'ts') {
    params.set('format', 'ts');
  }
  if (options.userAgent) params.set('ua', options.userAgent);
  if (options.referer) params.set('ref', options.referer);
  if (!options.isLive && options.startSeconds && options.startSeconds > 0) {
    params.set('start', String(Math.floor(options.startSeconds)));
  }
  return toAbsoluteProxyUrl(`/api/proxy/remux?${params.toString()}`);
}

export async function probeStream(
  url: string,
  userAgent?: string,
  referer?: string
): Promise<StreamProbeResult> {
  try {
    const params = new URLSearchParams({ url });
    if (userAgent) params.set('ua', userAgent);
    if (referer) params.set('ref', referer);
    const res = await fetch(resolveApiUrl(`/api/proxy/probe?${params.toString()}`));
    if (!res.ok) return { ok: false };
    return (await res.json()) as StreamProbeResult;
  } catch {
    return { ok: false };
  }
}

export async function authenticateXtream(params: {
  serverUrl: string;
  username: string;
  password: string;
  userAgent?: string;
}): Promise<XtreamAuthResponse> {
  const res = await fetch(resolveApiUrl('/api/xtream/auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as XtreamAuthResponse;
  return data;
}

async function callXtreamAction<T>(params: {
  serverUrl: string;
  username: string;
  password: string;
  action: string;
  extra?: Record<string, string>;
  userAgent?: string;
}): Promise<T> {
  const res = await fetch(resolveApiUrl('/api/xtream/action'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverUrl: params.serverUrl,
      username: params.username,
      password: params.password,
      action: params.action,
      params: params.extra,
      userAgent: params.userAgent,
    }),
  });
  let json: { ok?: boolean; data?: T; error?: string } | null = null;
  try {
    json = (await res.json()) as { ok?: boolean; data?: T; error?: string };
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `Xtream action ${params.action} failed (HTTP ${res.status})`);
  }
  return json.data as T;
}

function asPlainRecord(val: unknown): Record<string, unknown> | null {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

function toRecordArray(val: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(val)) {
    return val.map(asPlainRecord).filter((item): item is Record<string, unknown> => item !== null);
  }
  const rec = asPlainRecord(val);
  if (rec) {
    return Object.values(rec)
      .map(asPlainRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
  }
  return [];
}

function nonEmptyString(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const t = val.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return String(val);
  }
  return undefined;
}

function parseSeasonNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    const digitMatch = trimmed.match(/(\d+)/);
    if (digitMatch) {
      return parseInt(digitMatch[1], 10);
    }
  }
  return null;
}

function looksLikeEpisodeObject(obj: Record<string, unknown>): boolean {
  const hasStreamOrEpKey =
    obj.id !== undefined ||
    obj.episode_id !== undefined ||
    obj.stream_id !== undefined ||
    obj.episode_num !== undefined ||
    obj.container_extension !== undefined ||
    obj.direct_source !== undefined;
  if (!hasStreamOrEpKey) return false;
  // Exclude season container objects that wrap an `episodes` array
  if (Array.isArray(obj.episodes)) return false;
  const idVal = obj.id ?? obj.episode_id ?? obj.stream_id ?? obj.episode_num;
  return idVal === undefined || typeof idVal === 'string' || typeof idVal === 'number';
}

function extractEpisodeObjects(bucket: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(bucket)) {
    return bucket.map(asPlainRecord).filter((item): item is Record<string, unknown> => item !== null);
  }
  const rec = asPlainRecord(bucket);
  if (!rec) return [];
  if (looksLikeEpisodeObject(rec)) {
    return [rec];
  }
  return Object.values(rec)
    .map(asPlainRecord)
    .filter((item): item is Record<string, unknown> => item !== null && looksLikeEpisodeObject(item));
}

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

function extractYear(text?: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/\b((?:19|20)\d{2})\b/);
  return m ? m[1] : undefined;
}

export async function syncXtreamCatalog(
  source: PlaylistSource,
  onProgress?: (stage: string, pct: number) => void
): Promise<PlaylistCatalog> {
  const base = (source.resolvedServerUrl || source.serverUrl || '').replace(/\/+$/, '');
  const username = source.username || '';
  const password = source.password || '';
  const ua = source.userAgent;

  onProgress?.('Fetching categories...', 15);
  const [liveCatsRaw, vodCatsRaw, seriesCatsRaw] = await Promise.all([
    callXtreamAction<Array<{ category_id: string; category_name: string }>>({
      serverUrl: base,
      username,
      password,
      action: 'get_live_categories',
      userAgent: ua,
    }).catch(() => []),
    callXtreamAction<Array<{ category_id: string; category_name: string }>>({
      serverUrl: base,
      username,
      password,
      action: 'get_vod_categories',
      userAgent: ua,
    }).catch(() => []),
    callXtreamAction<Array<{ category_id: string; category_name: string }>>({
      serverUrl: base,
      username,
      password,
      action: 'get_series_categories',
      userAgent: ua,
    }).catch(() => []),
  ]);

  const liveCatMap = new Map<string, string>();
  if (Array.isArray(liveCatsRaw)) {
    for (const c of liveCatsRaw) {
      liveCatMap.set(String(c.category_id), String(c.category_name || 'General'));
    }
  }
  const vodCatMap = new Map<string, string>();
  if (Array.isArray(vodCatsRaw)) {
    for (const c of vodCatsRaw) {
      vodCatMap.set(String(c.category_id), String(c.category_name || 'Movies'));
    }
  }
  const seriesCatMap = new Map<string, string>();
  if (Array.isArray(seriesCatsRaw)) {
    for (const c of seriesCatsRaw) {
      seriesCatMap.set(String(c.category_id), String(c.category_name || 'Series'));
    }
  }

  onProgress?.('Loading Live TV channels...', 38);
  const liveStreamsRaw = await callXtreamAction<Array<Record<string, unknown>>>({
    serverUrl: base,
    username,
    password,
    action: 'get_live_streams',
    userAgent: ua,
  }).catch(() => []);

  onProgress?.('Loading Movies library...', 62);
  const vodStreamsRaw = await callXtreamAction<Array<Record<string, unknown>>>({
    serverUrl: base,
    username,
    password,
    action: 'get_vod_streams',
    userAgent: ua,
  }).catch(() => []);

  onProgress?.('Loading Series library...', 82);
  const seriesRaw = await callXtreamAction<Array<Record<string, unknown>>>({
    serverUrl: base,
    username,
    password,
    action: 'get_series',
    userAgent: ua,
  }).catch(() => []);

  const allowedFormats = source.accountInfo?.allowedOutputFormats || ['m3u8', 'ts'];
  const preferTs = source.liveFormat === 'ts' || (!allowedFormats.includes('m3u8') && source.liveFormat !== 'm3u8');
  const primaryExt = preferTs ? 'ts' : 'm3u8';
  const altExt = preferTs ? 'm3u8' : 'ts';
  const httpsBase = source.accountInfo?.httpsBaseUrl?.replace(/\/+$/, '');

  const channels: LiveChannel[] = toRecordArray(liveStreamsRaw).map((raw, idx) => {
    const streamId = String(raw.stream_id ?? raw.id ?? idx + 1);
    const catName = liveCatMap.get(String(raw.category_id || '')) || 'General';
    const numVal = Number(raw.num);
    const epgId = raw.epg_channel_id ? String(raw.epg_channel_id) : undefined;
    const tvArchive = Number(raw.tv_archive) === 1;
    const tvArchiveDuration = Number(raw.tv_archive_duration) || undefined;
    const rawDirectSource = typeof raw.direct_source === 'string' ? raw.direct_source.trim() : '';
    const directSourceUrl = /^https?:\/\//i.test(rawDirectSource) ? rawDirectSource : undefined;
    const httpsStreamUrl = httpsBase
      ? `${httpsBase}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.m3u8`
      : undefined;

    return {
      id: `${source.id}_live_${streamId}`,
      num: !Number.isNaN(numVal) && numVal > 0 ? numVal : idx + 1,
      name: String(raw.name || `Channel ${idx + 1}`),
      streamId,
      streamUrl: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${primaryExt}`,
      altStreamUrl: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${altExt}`,
      httpsStreamUrl,
      directSourceUrl,
      logo: raw.stream_icon ? String(raw.stream_icon) : undefined,
      category: catName,
      normalizedCategory: normalizeLiveCategory(catName),
      epgId,
      catchup: tvArchive,
      catchupDays: tvArchiveDuration,
      customUserAgent: ua,
    };
  });

  const movies: MovieItem[] = toRecordArray(vodStreamsRaw).map((raw, idx) => {
    const streamId = String(raw.stream_id ?? raw.id ?? idx + 1);
    const ext = String(raw.container_extension || 'mp4').replace(/^\./, '').toLowerCase();
    const catName = vodCatMap.get(String(raw.category_id || '')) || 'Movies';
    const name = String(raw.name || `Movie ${idx + 1}`);
    const ratingVal = raw.rating_5based
      ? Number(raw.rating_5based) * 2
      : raw.rating
      ? Number(raw.rating)
      : undefined;
    const addedTs = raw.added ? Number(raw.added) * 1000 : undefined;

    const httpsStreamUrl = httpsBase
      ? `${httpsBase}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`
      : undefined;

    return {
      id: `${source.id}_vod_${streamId}`,
      streamId,
      name,
      streamUrl: `${base}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`,
      httpsStreamUrl,
      containerExtension: ext,
      poster: raw.stream_icon ? String(raw.stream_icon) : undefined,
      backdrop: raw.stream_icon ? String(raw.stream_icon) : undefined,
      category: catName,
      genre: catName,
      year: extractYear(name),
      rating: ratingVal && !Number.isNaN(ratingVal) && ratingVal > 0 ? Math.min(10, Number(ratingVal.toFixed(1))) : undefined,
      addedAt: addedTs && !Number.isNaN(addedTs) ? addedTs : undefined,
      customUserAgent: ua,
    };
  });

  const series: SeriesItem[] = toRecordArray(seriesRaw).map((raw, idx) => {
    const seriesId = String(raw.series_id ?? raw.id ?? idx + 1);
    const catName = seriesCatMap.get(String(raw.category_id || '')) || 'Series';
    const name = String(raw.name || `Series ${idx + 1}`);
    const ratingVal = raw.rating_5based
      ? Number(raw.rating_5based) * 2
      : raw.rating
      ? Number(raw.rating)
      : undefined;
    const backdrops = Array.isArray(raw.backdrop_path) ? (raw.backdrop_path as string[]) : [];
    const addedTs = raw.last_modified ? Number(raw.last_modified) * 1000 : undefined;

    return {
      id: `${source.id}_ser_${seriesId}`,
      seriesId,
      name,
      poster: raw.cover ? String(raw.cover) : undefined,
      backdrop: backdrops[0] || (raw.cover ? String(raw.cover) : undefined),
      category: catName,
      genre: raw.genre ? String(raw.genre) : catName,
      year: extractYear(String(raw.releaseDate || raw.release_date || name)),
      rating: ratingVal && !Number.isNaN(ratingVal) && ratingVal > 0 ? Math.min(10, Number(ratingVal.toFixed(1))) : undefined,
      plot: raw.plot ? String(raw.plot) : undefined,
      director: raw.director ? String(raw.director) : undefined,
      cast: raw.cast ? String(raw.cast) : undefined,
      trailerUrl: raw.youtube_trailer ? normalizeTrailerUrl(String(raw.youtube_trailer)) : undefined,
      addedAt: addedTs && !Number.isNaN(addedTs) ? addedTs : undefined,
      seasons: [],
      seasonsLoaded: false,
    };
  });

  // Safety net: if player_api.php auth succeeded but all catalog actions returned empty,
  // automatically fetch via get.php M3U endpoint so channels/movies/series still load!
  if (channels.length === 0 && movies.length === 0 && series.length === 0) {
    onProgress?.('API catalog empty — syncing via get.php M3U bridge...', 88);
    const getPhpUrl = `${base}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(
      password
    )}&type=m3u_plus&output=${primaryExt}`;
    try {
      const m3uFallback = await fetchAndParseM3U({
        url: getPhpUrl,
        playlistId: source.id,
        userAgent: ua,
      });
      if (m3uFallback.ok) {
        onProgress?.('Finalizing catalog...', 96);
        return {
          playlistId: source.id,
          channels: m3uFallback.channels,
          movies: m3uFallback.movies,
          series: m3uFallback.series,
          epgPrograms: {},
        };
      }
    } catch {
      // keep empty catalog if fallback also fails
    }
  }

  onProgress?.('Finalizing catalog...', 95);
  return {
    playlistId: source.id,
    channels,
    movies,
    series,
    epgPrograms: {},
  };
}

function normalizeTrailerUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9_-]{8,15}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  return undefined;
}

export async function fetchXtreamVodDetails(
  source: PlaylistSource,
  movie: MovieItem
): Promise<Partial<MovieItem>> {
  if (source.type !== 'xtream' || !movie.streamId) return {};
  const base = (source.resolvedServerUrl || source.serverUrl || '').replace(/\/+$/, '');
  const data = await callXtreamAction<Record<string, unknown>>({
    serverUrl: base,
    username: source.username || '',
    password: source.password || '',
    action: 'get_vod_info',
    extra: { vod_id: movie.streamId },
    userAgent: source.userAgent,
  });

  const info = (data?.info || {}) as Record<string, unknown>;
  const movieData = (data?.movie_data || {}) as Record<string, unknown>;
  const backdrops = Array.isArray(info.backdrop_path) ? (info.backdrop_path as string[]) : [];

  const ext = movieData.container_extension
    ? String(movieData.container_extension).replace(/^\./, '').toLowerCase()
    : movie.containerExtension;

  const httpsBase = source.accountInfo?.httpsBaseUrl?.replace(/\/+$/, '');
  const updatedStreamUrl =
    ext && movie.streamId
      ? `${base}/movie/${encodeURIComponent(source.username || '')}/${encodeURIComponent(
          source.password || ''
        )}/${movie.streamId}.${ext}`
      : movie.streamUrl;
  const updatedHttpsStreamUrl =
    httpsBase && ext && movie.streamId
      ? `${httpsBase}/movie/${encodeURIComponent(source.username || '')}/${encodeURIComponent(
          source.password || ''
        )}/${movie.streamId}.${ext}`
      : movie.httpsStreamUrl;

  return {
    streamUrl: updatedStreamUrl,
    httpsStreamUrl: updatedHttpsStreamUrl,
    containerExtension: ext,
    backdrop: backdrops[0] || (info.movie_image ? String(info.movie_image) : movie.backdrop),
    poster: info.movie_image ? String(info.movie_image) : movie.poster,
    plot: info.plot ? String(info.plot) : info.description ? String(info.description) : movie.plot,
    genre: info.genre ? String(info.genre) : movie.genre,
    director: info.director ? String(info.director) : movie.director,
    cast: info.cast ? String(info.cast) : info.actors ? String(info.actors) : movie.cast,
    duration: info.duration ? String(info.duration) : movie.duration,
    durationSeconds: info.duration_secs ? Number(info.duration_secs) : movie.durationSeconds,
    year: extractYear(String(info.releasedate || info.release_date || '')) || movie.year,
    rating: info.rating ? Number(info.rating) || movie.rating : movie.rating,
    country: info.country ? String(info.country) : movie.country,
    trailerUrl: info.youtube_trailer ? normalizeTrailerUrl(String(info.youtube_trailer)) : movie.trailerUrl,
  };
}

export function parseXtreamSeriesResponse(
  data: unknown,
  source: PlaylistSource,
  seriesItem: SeriesItem
): Partial<SeriesItem> {
  const root = asPlainRecord(data);
  if (!root) {
    return { seasonsLoaded: false };
  }

  const base = (source.resolvedServerUrl || source.serverUrl || '').replace(/\/+$/, '');
  const username = source.username || '';
  const password = source.password || '';
  const httpsBase = source.accountInfo?.httpsBaseUrl?.replace(/\/+$/, '');

  const info = asPlainRecord(root.info) || {};
  const backdrops = Array.isArray(info.backdrop_path)
    ? info.backdrop_path.map((b) => nonEmptyString(b)).filter((b): b is string => Boolean(b))
    : nonEmptyString(info.backdrop_path)
    ? [String(info.backdrop_path).trim()]
    : [];

  // Extract optional season metadata from `data.seasons` (names, covers, overview)
  const seasonMetaMap = new Map<number, { name?: string; cover?: string }>();
  const rawSeasonsMeta = toRecordArray(root.seasons);
  for (const sMeta of rawSeasonsMeta) {
    const sNum = parseSeasonNumber(sMeta.season_number ?? sMeta.season ?? sMeta.id);
    if (sNum !== null) {
      seasonMetaMap.set(sNum, {
        name: nonEmptyString(sMeta.name),
        cover: nonEmptyString(sMeta.cover_big) || nonEmptyString(sMeta.cover),
      });
    }
  }

  // Group episodes across all real-world Xtream / PHP panel JSON shapes
  const seasonBuckets = new Map<number, Array<Record<string, unknown>>>();
  const pushEpisode = (seasonNum: number, epObj: Record<string, unknown>) => {
    const list = seasonBuckets.get(seasonNum) || [];
    list.push(epObj);
    seasonBuckets.set(seasonNum, list);
  };

  const rawEpisodes = root.episodes;

  if (Array.isArray(rawEpisodes)) {
    // Check if flat array of episode objects: `[{ id, season: 1, episode_num: 1, ... }]`
    const isFlatEpisodeArray = rawEpisodes.some((item) => {
      const rec = asPlainRecord(item);
      return rec !== null && looksLikeEpisodeObject(rec);
    });

    if (isFlatEpisodeArray) {
      for (const item of rawEpisodes) {
        const epObj = asPlainRecord(item);
        if (!epObj || !looksLikeEpisodeObject(epObj)) continue;
        const epSeason = parseSeasonNumber(epObj.season ?? epObj.season_num ?? epObj.season_number);
        pushEpisode(epSeason ?? 1, epObj);
      }
    } else {
      // Array of season buckets: e.g. `[null, [ep1, ep2], [ep3]]` or `[[ep1, ep2], [ep3]]`
      const zeroSlotEpisodes = extractEpisodeObjects(rawEpisodes[0]);
      const hasEmptyZeroSlot = rawEpisodes.length > 0 && zeroSlotEpisodes.length === 0;

      for (let i = 0; i < rawEpisodes.length; i++) {
        const epList = extractEpisodeObjects(rawEpisodes[i]);
        if (epList.length === 0) continue;
        for (const epObj of epList) {
          const explicitSeason = parseSeasonNumber(
            epObj.season ?? epObj.season_num ?? epObj.season_number
          );
          const fallbackSeason = hasEmptyZeroSlot ? i : i + 1;
          pushEpisode(explicitSeason ?? fallbackSeason, epObj);
        }
      }
    }
  } else {
    const episodesRecord = asPlainRecord(rawEpisodes);
    if (episodesRecord) {
      for (const [seasonKey, bucket] of Object.entries(episodesRecord)) {
        const epList = extractEpisodeObjects(bucket);
        if (epList.length === 0) continue;
        const keySeason = parseSeasonNumber(seasonKey);
        for (const epObj of epList) {
          const explicitSeason = parseSeasonNumber(
            epObj.season ?? epObj.season_num ?? epObj.season_number
          );
          const resolvedSeason = keySeason ?? explicitSeason ?? 1;
          pushEpisode(resolvedSeason, epObj);
        }
      }
    }
  }

  // Fallback: some panels embed `episodes` directly inside each `data.seasons[]` entry
  if (seasonBuckets.size === 0 && rawSeasonsMeta.length > 0) {
    for (let i = 0; i < rawSeasonsMeta.length; i++) {
      const sMeta = rawSeasonsMeta[i];
      const epList = extractEpisodeObjects(sMeta.episodes);
      if (epList.length === 0) continue;
      const sNum = parseSeasonNumber(sMeta.season_number ?? sMeta.season) ?? i + 1;
      for (const epObj of epList) {
        pushEpisode(sNum, epObj);
      }
    }
  }

  const resolvedBackdrop = backdrops[0] || nonEmptyString(info.cover) || seriesItem.backdrop;
  const resolvedPoster = nonEmptyString(info.cover) || seriesItem.poster;

  const seasons: SeasonGroup[] = Array.from(seasonBuckets.entries())
    .map(([seasonNumber, rawEps]) => {
      const meta = seasonMetaMap.get(seasonNumber);
      const seenIds = new Set<string>();
      const eps: EpisodeItem[] = [];

      rawEps.forEach((ep, idx) => {
        const rawEpId = nonEmptyString(ep.id ?? ep.episode_id ?? ep.stream_id);
        const epId = rawEpId || `${seasonNumber}_${idx + 1}`;
        const uniqueId = `${seriesItem.id}_ep_${epId}`;
        if (seenIds.has(uniqueId)) return;
        seenIds.add(uniqueId);

        const ext = (nonEmptyString(ep.container_extension) || 'mp4')
          .replace(/^\./, '')
          .toLowerCase();
        const epInfo = asPlainRecord(ep.info) || {};
        const parsedEpNum = Number(ep.episode_num ?? ep.episode ?? ep.num);
        const episodeNumber =
          Number.isFinite(parsedEpNum) && parsedEpNum > 0 ? Math.floor(parsedEpNum) : idx + 1;

        const directUrl = nonEmptyString(ep.direct_source);
        const hasValidDirectUrl = Boolean(directUrl && /^https?:\/\//i.test(directUrl));
        const streamUrl =
          rawEpId && base
            ? `${base}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${rawEpId}.${ext}`
            : hasValidDirectUrl
            ? directUrl!
            : `${base}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${epId}.${ext}`;
        const httpsStreamUrl =
          rawEpId && httpsBase
            ? `${httpsBase}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${rawEpId}.${ext}`
            : undefined;

        const thumbnail =
          nonEmptyString(epInfo.movie_image) ||
          nonEmptyString(epInfo.cover_big) ||
          nonEmptyString(epInfo.cover) ||
          nonEmptyString(ep.cover) ||
          meta?.cover ||
          resolvedBackdrop ||
          resolvedPoster;

        const durSecsNum = Number(epInfo.duration_secs ?? ep.duration_secs);
        const epRatingNum = Number(epInfo.rating ?? ep.rating);

        eps.push({
          id: uniqueId,
          seriesId: seriesItem.id,
          seasonNumber,
          episodeNumber,
          title:
            nonEmptyString(ep.title) ||
            nonEmptyString(ep.name) ||
            nonEmptyString(epInfo.name) ||
            `Episode ${episodeNumber}`,
          streamUrl,
          httpsStreamUrl,
          containerExtension: ext,
          thumbnail,
          plot:
            nonEmptyString(epInfo.plot) ||
            nonEmptyString(epInfo.overview) ||
            nonEmptyString(epInfo.description) ||
            nonEmptyString(ep.plot),
          duration: nonEmptyString(epInfo.duration) || nonEmptyString(ep.duration),
          durationSeconds: Number.isFinite(durSecsNum) && durSecsNum > 0 ? durSecsNum : undefined,
          rating: Number.isFinite(epRatingNum) && epRatingNum > 0 ? epRatingNum : undefined,
          airDate:
            nonEmptyString(epInfo.releasedate) ||
            nonEmptyString(epInfo.release_date) ||
            nonEmptyString(epInfo.air_date),
          customUserAgent: source.userAgent,
        });
      });

      return {
        seasonNumber,
        name: meta?.name || (seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`),
        episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber),
      };
    })
    .filter((s) => s.episodes.length > 0)
    .sort((a, b) => {
      // Keep Season 1..N first, and place Specials (season 0) at the end
      if (a.seasonNumber === 0 && b.seasonNumber !== 0) return 1;
      if (b.seasonNumber === 0 && a.seasonNumber !== 0) return -1;
      return a.seasonNumber - b.seasonNumber;
    });

  const infoRating = info.rating ? Number(info.rating) : NaN;
  const parsedRating =
    Number.isFinite(infoRating) && infoRating > 0
      ? Math.min(10, Number(infoRating.toFixed(1)))
      : seriesItem.rating;

  const trailerRaw = nonEmptyString(info.youtube_trailer);

  return {
    backdrop: resolvedBackdrop,
    poster: resolvedPoster,
    plot: nonEmptyString(info.plot) || nonEmptyString(info.description) || seriesItem.plot,
    genre: nonEmptyString(info.genre) || seriesItem.genre,
    director: nonEmptyString(info.director) || seriesItem.director,
    cast: nonEmptyString(info.cast) || nonEmptyString(info.actors) || seriesItem.cast,
    year:
      extractYear(String(info.releaseDate || info.release_date || info.releasedate || '')) ||
      seriesItem.year,
    rating: parsedRating,
    trailerUrl: trailerRaw ? normalizeTrailerUrl(trailerRaw) : seriesItem.trailerUrl,
    ...(seasons.length > 0 ? { seasons, seasonsLoaded: true } : { seasonsLoaded: false }),
  };
}

export async function fetchXtreamSeriesDetails(
  source: PlaylistSource,
  seriesItem: SeriesItem
): Promise<Partial<SeriesItem>> {
  const effectiveSeriesId =
    seriesItem.seriesId ||
    (seriesItem.id.includes('_ser_') ? seriesItem.id.split('_ser_').pop() : undefined);

  if (source.type !== 'xtream' || !effectiveSeriesId) return {};
  const base = (source.resolvedServerUrl || source.serverUrl || '').replace(/\/+$/, '');
  const username = source.username || '';
  const password = source.password || '';

  const data = await callXtreamAction<unknown>({
    serverUrl: base,
    username,
    password,
    action: 'get_series_info',
    extra: { series_id: effectiveSeriesId },
    userAgent: source.userAgent,
  });

  return parseXtreamSeriesResponse(data, source, {
    ...seriesItem,
    seriesId: effectiveSeriesId,
  });
}

export async function fetchXtreamChannelShortEpg(
  source: PlaylistSource,
  channel: LiveChannel
): Promise<EpgProgram[]> {
  if (source.type !== 'xtream' || !channel.streamId) return [];
  const base = (source.resolvedServerUrl || source.serverUrl || '').replace(/\/+$/, '');
  try {
    const data = await callXtreamAction<{ epg_listings?: Array<Record<string, unknown>> }>({
      serverUrl: base,
      username: source.username || '',
      password: source.password || '',
      action: 'get_short_epg',
      extra: { stream_id: channel.streamId, limit: '8' },
      userAgent: source.userAgent,
    });

    const listings = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
    return listings.map((item, idx) => {
      const decodeB64 = (val: unknown): string => {
        if (!val) return '';
        const str = String(val);
        try {
          return decodeURIComponent(escape(atob(str)));
        } catch {
          return str;
        }
      };

      const startSec = Number(item.start_timestamp) || Date.parse(String(item.start || '')) / 1000;
      const stopSec = Number(item.stop_timestamp) || Date.parse(String(item.end || '')) / 1000;
      return {
        id: `${channel.id}_epg_${idx}`,
        channelId: (channel.epgId || channel.name).toLowerCase(),
        title: decodeB64(item.title) || 'Program',
        description: decodeB64(item.description) || undefined,
        start: startSec * 1000,
        end: stopSec * 1000,
      };
    });
  } catch {
    return [];
  }
}

export async function fetchAndParseM3U(params: {
  url?: string;
  content?: string;
  playlistId: string;
  userAgent?: string;
}): Promise<{
  ok: boolean;
  finalUrl?: string;
  workingUserAgent?: string;
  detectedEpgUrl?: string;
  channels: LiveChannel[];
  movies: MovieItem[];
  series: SeriesItem[];
  error?: string;
}> {
  const res = await fetch(resolveApiUrl('/api/m3u/fetch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return (await res.json()) as {
    ok: boolean;
    finalUrl?: string;
    workingUserAgent?: string;
    detectedEpgUrl?: string;
    channels: LiveChannel[];
    movies: MovieItem[];
    series: SeriesItem[];
    error?: string;
  };
}

export async function fetchXmltvEpg(
  url: string,
  userAgent?: string
): Promise<{ ok: boolean; channelCount?: number; programs?: Record<string, EpgProgram[]>; error?: string }> {
  const res = await fetch(resolveApiUrl('/api/epg/fetch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, userAgent }),
  });
  return (await res.json()) as {
    ok: boolean;
    channelCount?: number;
    programs?: Record<string, EpgProgram[]>;
    error?: string;
  };
}

export function convertSrtToVtt(srtText: string): string {
  const normalized = srtText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${normalized}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function formatShortTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function getEpgForChannel(
  epgMap: Record<string, EpgProgram[]>,
  channel: LiveChannel,
  offsetHours = 0
): { current?: EpgProgram; next?: EpgProgram; all: EpgProgram[]; progressPct: number } {
  const keys = [
    channel.epgId?.toLowerCase().trim(),
    channel.name.toLowerCase().trim(),
  ].filter(Boolean) as string[];

  let list: EpgProgram[] = [];
  for (const k of keys) {
    if (epgMap[k] && epgMap[k].length > 0) {
      list = epgMap[k];
      break;
    }
  }

  if (list.length === 0) return { all: [], progressPct: 0 };

  const now = Date.now() - offsetHours * 3600 * 1000;
  let current: EpgProgram | undefined;
  let next: EpgProgram | undefined;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.start <= now && p.end > now) {
      current = p;
      next = list[i + 1];
      break;
    }
    if (p.start > now && !next) {
      next = p;
      break;
    }
  }

  let progressPct = 0;
  if (current && current.end > current.start) {
    progressPct = Math.max(0, Math.min(100, ((now - current.start) / (current.end - current.start)) * 100));
  }

  return { current, next, all: list, progressPct };
}
