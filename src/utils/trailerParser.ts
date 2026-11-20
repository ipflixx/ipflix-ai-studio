export type ParsedTrailer =
  | { kind: 'youtube'; embedUrl: string; videoId: string }
  | { kind: 'vimeo'; embedUrl: string; videoId: string }
  | { kind: 'video'; src: string };

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const DIRECT_VIDEO_EXT_REGEX = /\.(mp4|webm|mov|m4v|ogv|ogg)(?:[?#].*)?$/i;
const EMPTY_PLACEHOLDERS = new Set([
  '',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'false',
  '0',
  '-',
]);

/**
 * Safely parses a real trailer URL or YouTube ID supplied by an IPTV provider
 * into an in-app playable embed or HTML5 video source.
 *
 * Strictly returns `null` when no valid real trailer exists — never fabricates
 * fallback or placeholder videos.
 */
export function parseTrailerSource(rawUrl?: string | null): ParsedTrailer | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || EMPTY_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;

  // Bare 11-character YouTube video ID (common in Xtream Codes `youtube_trailer`)
  if (YOUTUBE_ID_REGEX.test(trimmed)) {
    return {
      kind: 'youtube',
      videoId: trimmed,
      embedUrl: `https://www.youtube-nocookie.com/embed/${trimmed}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
    };
  }

  // Relative local / proxied direct video path
  if (trimmed.startsWith('/')) {
    if (DIRECT_VIDEO_EXT_REGEX.test(trimmed)) {
      return { kind: 'video', src: trimmed };
    }
    return null;
  }

  // Parse absolute URLs safely
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  // YouTube formats: watch?v=, youtu.be/, embed/, shorts/, live/
  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host === 'youtu.be'
  ) {
    let videoId: string | null = null;
    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (parsed.pathname.startsWith('/watch')) {
      videoId = parsed.searchParams.get('v');
    } else {
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (
        segs.length >= 2 &&
        (segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'v')
      ) {
        videoId = segs[1];
      }
    }

    if (videoId && YOUTUBE_ID_REGEX.test(videoId)) {
      return {
        kind: 'youtube',
        videoId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
      };
    }
    return null;
  }

  // Vimeo formats: vimeo.com/<id> or player.vimeo.com/video/<id>
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const segs = parsed.pathname.split('/').filter(Boolean);
    const idCandidate =
      host === 'player.vimeo.com' && segs[0] === 'video' ? segs[1] : segs[segs.length - 1];
    if (idCandidate && /^\d{5,15}$/.test(idCandidate)) {
      return {
        kind: 'vimeo',
        videoId: idCandidate,
        embedUrl: `https://player.vimeo.com/video/${idCandidate}?autoplay=1&dnt=1`,
      };
    }
    return null;
  }

  // Direct HTML5 playable video files (MP4 / WebM / MOV / M4V / OGG)
  if (DIRECT_VIDEO_EXT_REGEX.test(parsed.pathname)) {
    return { kind: 'video', src: parsed.toString() };
  }

  return null;
}

/**
 * Splits a provider cast string (comma, semicolon, or pipe delimited) into
 * clean, deduplicated actor names. Returns an empty array when no cast exists.
 */
export function parseCastNames(rawCast?: string | null, limit = 12): string[] {
  if (!rawCast || typeof rawCast !== 'string') return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of rawCast.split(/[,;|•\n]+/)) {
    const name = part.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) continue;
    const lower = name.toLowerCase();
    if (EMPTY_PLACEHOLDERS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    result.push(name);
    if (result.length >= limit) break;
  }

  return result;
}
