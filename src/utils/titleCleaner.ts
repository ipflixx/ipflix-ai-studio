/**
 * Display-layer content title cleaner for IPFLIX.
 *
 * Strips verified IPTV provider, language, region, platform, quality, and group
 * prefixes (e.g., "TR:BYZBOX Matrix", "EN:BYZBOX The Matrix", "EN:GROUP Breaking Bad",
 * "[TR] [4K] John Wick", "TR | Inception") purely for UI presentation while keeping
 * raw source/database titles untouched and preserving real titles & episode numbers.
 */

// Verified ISO / IPTV language & country codes (uppercase)
const LANG_REGION_CODES = new Set([
  'TR', 'TUR', 'EN', 'ENG', 'US', 'USA', 'UK', 'GB', 'DE', 'DEU', 'GER',
  'FR', 'FRA', 'ES', 'ESP', 'SPA', 'IT', 'ITA', 'NL', 'NLD', 'BE', 'BEL',
  'PT', 'POR', 'BR', 'BRA', 'RU', 'RUS', 'AR', 'ARA', 'AZ', 'AZE',
  'PL', 'POL', 'RO', 'ROU', 'BG', 'BGR', 'GR', 'GRE', 'SE', 'SWE',
  'NO', 'NOR', 'DK', 'DEN', 'FI', 'FIN', 'CZ', 'CZE', 'SK', 'HU', 'HUN',
  'HR', 'RS', 'SRB', 'BA', 'AL', 'ALB', 'MK', 'UA', 'UKR', 'KZ', 'UZ',
  'IR', 'FA', 'IN', 'IND', 'PK', 'JP', 'JPN', 'KR', 'KOR', 'CN', 'CHN',
  'TW', 'TH', 'VN', 'ID', 'MY', 'CA', 'AU', 'MX', 'CO', 'CL', 'PE',
  'EU', 'INT', 'INTL', 'LAT', 'LATINO', 'MULTI', 'DUAL', 'GLOBAL',
]);

// 2-letter codes that are also real common English/Turkish words and therefore
// require strict uppercase when appearing as standalone prefixes like "IN:" / "NO:" / "IT:"
const AMBIGUOUS_SHORT_CODES = new Set([
  'IN', 'NO', 'IT', 'US', 'BE', 'ID', 'MY', 'DE', 'AR', 'EN', 'AL', 'AT', 'OR', 'TO', 'SO', 'AS', 'IS',
]);

// Verified IPTV / streaming platform / quality / group tags (uppercase)
const KNOWN_PROVIDER_TAGS = new Set([
  'VOD', 'VIP', 'PPV', 'IPTV', 'OTT', 'TV', 'LIVE', 'CANLI',
  '4K', 'UHD', 'FHD', 'HD', 'SD', 'HEVC', 'H265', 'H264', 'RAW', 'HQ',
  'SUB', 'DUB', 'ALT', 'ALTYAZI', 'ALTYAZILI', 'DUBLAJ', 'TRDUB', 'TRALT', 'TURKCE',
  'MULTI', 'DUAL', 'ORG', 'ORJ', 'ORIJINAL', 'ORIGINAL',
  'GROUP', 'GRP', 'BOX', 'BOXSET', 'PAKET', 'PACK', 'SERVER', 'SRV', 'BACKUP', 'YEDEK',
  'NETFLIX', 'NF', 'DISNEY', 'DISNEY+', 'D+', 'PRIME', 'AMZ', 'AMAZON', 'HBO', 'HBOMAX',
  'APPLE', 'APPLETV', 'ATV+', 'EXXEN', 'BLUTV', 'GAIN', 'TABII', 'TOD', 'MUBI', 'BEIN',
  'HULU', 'PARAMOUNT', 'PEACOCK', 'SHOWTIME', 'STARZ', 'SKY', 'CANAL', 'DAZN', 'ESPN',
  'SINEMA', 'CINEMA', 'FILM', 'FILMLER', 'MOVIE', 'MOVIES', 'DIZI', 'DIZILER', 'SERIES',
  'YERLI', 'YABANCI', 'ANIME', 'KIDS', 'COCUK', 'BELGESEL', 'DOCU',
]);

// Tags safe to strip as standalone `TAG:` / `TAG |` without a leading country code
const STANDALONE_PREFIX_TAGS = new Set([
  ...LANG_REGION_CODES,
  'VOD', 'VIP', 'PPV', 'IPTV', 'OTT',
  '4K', 'UHD', 'FHD', 'HD', 'SD', 'HEVC', 'RAW',
  'SUB', 'DUB', 'TRDUB', 'TRALT', 'MULTI', 'DUAL', 'BOXSET',
  'NETFLIX', 'NF', 'DISNEY', 'DISNEY+', 'D+', 'PRIME', 'AMZ', 'AMAZON', 'HBO', 'HBOMAX',
  'APPLETV', 'ATV+', 'EXXEN', 'BLUTV', 'GAIN', 'TABII', 'TOD', 'MUBI',
]);

// Compact quality/platform tokens safe to strip as space-separated secondary tags after a verified prefix
const COMPACT_SECONDARY_TAGS = new Set([
  '4K', 'HD', 'SD', 'NF', 'D+', 'TV',
]);

// Technical quality/format/reseller tags safe to strip even when space-separated after an already-stripped prefix
// (Broadcast network brands like BEIN, SKY, ESPN, DAZN, CANAL, HBO are NOT stripped when space-separated,
// preserving real live channel names like "beIN SPORTS 1", "Sky News", "ESPN HD", "DAZN 1".)
const SPACE_SAFE_SECONDARY_TAGS = new Set([
  'VOD', 'VIP', 'PPV', 'IPTV', 'OTT',
  '4K', 'UHD', 'FHD', 'HD', 'SD', 'HEVC', 'H265', 'H264', 'RAW', 'HQ',
  'SUB', 'DUB', 'ALTYAZI', 'ALTYAZILI', 'DUBLAJ', 'TRDUB', 'TRALT', 'TURKCE',
  'MULTI', 'DUAL', 'ORG', 'ORJ', 'ORIJINAL', 'ORIGINAL',
  'GROUP', 'GRP', 'BOXSET', 'PAKET', 'PACK', 'SERVER', 'SRV', 'BACKUP', 'YEDEK',
]);

// Common words that must NEVER be mistaken for an unknown provider token directly after `CODE:`
// (e.g., "TR:THE Matrix" -> "THE Matrix", "TR:STAR Wars" -> "STAR Wars", "TR:JOHN Wick" -> "JOHN Wick")
const PROTECTED_TITLE_WORDS = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'YOU', 'ALL', 'ONE', 'TWO', 'SIX', 'TEN',
  'RED', 'BAD', 'BIG', 'OLD', 'NEW', 'MAN', 'MEN', 'WAR', 'GOD', 'DAY',
  'END', 'TOP', 'HOT', 'ICE', 'SKY', 'SUN', 'SON', 'MAD', 'RUN', 'OUT',
  'HOW', 'WHO', 'WHY', 'OUR', 'HER', 'HIS', 'SHE', 'CAN', 'ARE', 'WAS',
  'STAR', 'DARK', 'IRON', 'DEAD', 'FAST', 'LAST', 'GOOD', 'LOST', 'TRUE',
  'FREE', 'WILD', 'KING', 'LORD', 'GAME', 'JOHN', 'JANE', 'JACK', 'BABY',
  'LOVE', 'LIFE', 'TIME', 'HOME', 'CITY', 'ROAD', 'FIRE', 'COLD', 'BLUE',
  'PINK', 'GOLD', 'HARD', 'HIGH', 'REAL', 'DEEP', 'LONG', 'FULL', 'OPEN',
  'BLACK', 'WHITE', 'GREEN', 'NIGHT', 'WORLD', 'HOUSE', 'BLOOD', 'SPACE',
  'GHOST', 'DEATH', 'FINAL', 'FIRST', 'GREAT', 'SUPER', 'YOUNG', 'SWEET',
  'BIR', 'IKI', 'SON', 'ILK', 'YENI', 'ESKI', 'BUYUK', 'KUCUK', 'GUZEL',
  'KARA', 'BEYAZ', 'MAVI', 'KIZIL', 'GECE', 'GUNES', 'ATES', 'KAN', 'ASK',
  'BEN', 'SEN', 'BIZ', 'SIZ', 'ONLAR', 'DELI', 'KIRAL', 'KRAL', 'BABA',
  'ANNE', 'KARDES', 'DOST', 'SEVGILI', 'HAYAT', 'DUNYA', 'SEHIR', 'YOL',
  'SANDBOX', 'JUKEBOX', 'TOOLBOX', 'BOOMBOX', 'MATCHBOX', 'BLACKBOX',
  'OUTBOX', 'INBOX', 'MAILBOX', 'PLAYBOX', 'XBOX', 'CHATBOX', 'HOTBOX',
  'GEARBOX', 'FIREBOX', 'ICEBOX', 'SHOEBOX', 'LOCKBOX', 'WORKBOX',
]);

// Season/episode tokens that must always be preserved
const SEASON_EPISODE_TOKEN_RE = /^(?:S\d{1,2}(?:E\d{1,3})?|E\d{1,3}|\d{1,2}x\d{1,3}|B\d{1,3})$/i;

// Known IPTV provider/reseller brand suffixes (e.g., BYZBOX, SMARTIPTV, TURKOTT, VIPFLIX)
const PROVIDER_SUFFIX_RE =
  /(?:BOX|IPTV|OTT|VOD|VIP|GRP|GROUP|STREAM|FLIX|SAT|SRV|SERVER|PANEL|PORTAL|HUB|CLUB|ZONE|PLAY|MAX|PRO|PLUS|TV|NET|MEDIA|HD|4K|FHD|UHD|SUB|DUB|ALT)$/;

const STRONG_PROVIDER_BRAND_SUFFIX_RE =
  /(?:BOX|IPTV|OTT|FLIX|STREAM|GRP|GROUP|SRV|SERVER|PANEL|PORTAL)$/;

// Bounded memoization cache so scrolling 10,000+ titles has O(1) cost
const MAX_CACHE_SIZE = 15000;
const cleanTitleCache = new Map<string, string>();

function isVerifiedCode(token: string): boolean {
  return LANG_REGION_CODES.has(token.toUpperCase());
}

function isKnownTag(token: string): boolean {
  return KNOWN_PROVIDER_TAGS.has(token.toUpperCase());
}

function isAllUpperAsciiToken(token: string): boolean {
  return /^[A-Z0-9][A-Z0-9._+-]*$/.test(token) && /[A-Z]/.test(token);
}

function isStrongProviderBrand(token: string): boolean {
  const upper = token.toUpperCase();
  if (token.length < 5 || token.length > 24) return false;
  if (PROTECTED_TITLE_WORDS.has(upper)) return false;
  if (SEASON_EPISODE_TOKEN_RE.test(token)) return false;
  return isAllUpperAsciiToken(token) && STRONG_PROVIDER_BRAND_SUFFIX_RE.test(upper);
}

function isProviderStyledToken(token: string, remainder: string): boolean {
  const upper = token.toUpperCase();
  if (token.length < 2 || token.length > 24) return false;
  if (PROTECTED_TITLE_WORDS.has(upper)) return false;
  if (SEASON_EPISODE_TOKEN_RE.test(token)) return false;
  if (/^(?:19|20)\d{2}$/.test(token)) return false;

  if (isKnownTag(token) || isVerifiedCode(token)) {
    return true;
  }

  // ALL-UPPERCASE token attached to a verified code (e.g., BYZBOX, GROUP, KRONOS, ALPHA)
  if (isAllUpperAsciiToken(token) && token.length >= 3) {
    const remainderHasLower = /[a-zçğıöşü]/.test(remainder);
    const hasProviderMorphology =
      /[_.+\d]/.test(token) || (token.length >= 4 && PROVIDER_SUFFIX_RE.test(upper));

    if (remainderHasLower || hasProviderMorphology) {
      return true;
    }
  }

  // CamelCase provider branding (e.g., ByzBox, SmartIPTV, TurkOTT)
  if (/[a-z][A-Z]/.test(token) && PROVIDER_SUFFIX_RE.test(upper)) {
    return true;
  }

  // All-lowercase strong provider brand directly attached to verified code (e.g., "tr:byzbox Matrix")
  if (
    token.length >= 5 &&
    /^[a-z0-9][a-z0-9._+-]*$/.test(token) &&
    STRONG_PROVIDER_BRAND_SUFFIX_RE.test(upper)
  ) {
    return true;
  }

  return false;
}

function isSafeCodePrefixCase(code: string): boolean {
  const upper = code.toUpperCase();
  // Ambiguous words like "In", "No", "It", "Us", "En" must be ALL-UPPERCASE to qualify as a prefix code
  if (AMBIGUOUS_SHORT_CODES.has(upper)) {
    return code === upper;
  }
  return true;
}

function isRealColonTitleException(code: string, rest: string): boolean {
  const upper = code.toUpperCase();
  // Protect Stephen King's "IT: Chapter Two" / "IT: Welcome to Derry"
  if (upper === 'IT' && /^(?:chapter|welcome)\b/i.test(rest)) {
    return true;
  }
  return false;
}

/**
 * Cleans verified leading IPTV provider, language, region, platform, and group
 * prefixes from a media title for display purposes.
 *
 * Original database/source records remain untouched.
 */
export function cleanMediaTitle(rawTitle?: string | null): string {
  if (!rawTitle) return '';
  const normalized = rawTitle.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 3) return normalized;

  const cached = cleanTitleCache.get(normalized);
  if (cached !== undefined) return cached;

  let working = normalized;
  let sawVerifiedPrefix = false;
  let consumedProviderTag = false;

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;

    // Rule 1: Bracketed / enclosed leading prefix: [TR], [TR:BYZBOX], (EN), |TR|, [4K], [BYZBOX]
    const bracketMatch = working.match(
      /^[\[\(\{【|]\s*([^\[\]\(\)\{\}【】|]{1,36}?)\s*[\]\)\}】|]\s*(?:[-–—:|/•·»›]\s*)?(.+)$/
    );
    if (bracketMatch) {
      const inner = bracketMatch[1].trim();
      const rest = bracketMatch[2].trim();
      const parts = inner.split(/[:|/\-\s]+/).filter(Boolean);
      const isOnlyYear = /^\d{4}$/.test(inner);

      if (
        rest.length > 0 &&
        !isOnlyYear &&
        parts.length >= 1 &&
        parts.length <= 4 &&
        !SEASON_EPISODE_TOKEN_RE.test(inner)
      ) {
        const hasVerifiedPart = parts.some(
          (p) => isVerifiedCode(p) || isKnownTag(p) || isStrongProviderBrand(p)
        );
        const allTagLike = parts.every(
          (p) =>
            p.length <= 20 &&
            (isVerifiedCode(p) ||
              isKnownTag(p) ||
              isAllUpperAsciiToken(p) ||
              isProviderStyledToken(p, rest))
        );

        if (hasVerifiedPart && allTagLike) {
          working = rest;
          sawVerifiedPrefix = true;
          if (parts.length > 1 || parts.some((p) => isStrongProviderBrand(p))) {
            consumedProviderTag = true;
          }
          changed = true;
          continue;
        }
      }
    }

    // Rule 2: Directly attached composite prefix: TR:BYZBOX Matrix, EN:BYZBOX The Matrix,
    // TR:BYZBOX:4K Matrix, TR:BYZBOX - Matrix, TR:BYZBOX | Matrix, TR_BYZBOX Matrix, TR-BYZBOX Matrix
    const compositeMatch = working.match(
      /^([A-Za-z0-9+]{2,12})([:|/_-])([A-Za-z0-9._+-]{2,24})(?:([:|/_])([A-Za-z0-9._+-]{2,24}))?(\s*[-–—:|/•·»›]\s*|\s+)(.+)$/
    );
    if (compositeMatch) {
      const [, code, delim1, tag1, delim2, tag2, trailingSep, restRaw] = compositeMatch;
      const rest = restRaw.trim();
      const codeUpper = code.toUpperCase();
      const hasExplicitTrailingDelim = /[-–—:|/•·»›]/.test(trailingSep);

      if (
        rest.length > 0 &&
        (isVerifiedCode(code) || isKnownTag(code)) &&
        isSafeCodePrefixCase(code) &&
        !SEASON_EPISODE_TOKEN_RE.test(tag1)
      ) {
        // Hyphen between code & tag (e.g., TR-BYZBOX Matrix) requires strict uppercase/known tag
        const hyphenOk =
          delim1 !== '-' ||
          isKnownTag(tag1) ||
          isVerifiedCode(tag1) ||
          (isAllUpperAsciiToken(tag1) && tag1.length >= 3 && !PROTECTED_TITLE_WORDS.has(tag1.toUpperCase()));

        // Guard real titles like "US-Canada: ..." or "IT:Chapter..."
        const tag1Qualifies =
          hyphenOk &&
          (hasExplicitTrailingDelim ||
            Boolean(tag2) ||
            isProviderStyledToken(tag1, rest));

        if (tag1Qualifies) {
          if (tag2 && delim2) {
            const tag2Qualifies =
              !SEASON_EPISODE_TOKEN_RE.test(tag2) &&
              (hasExplicitTrailingDelim || isProviderStyledToken(tag2, rest));
            if (tag2Qualifies) {
              working = rest;
              sawVerifiedPrefix = true;
              consumedProviderTag = true;
              changed = true;
              continue;
            }
          } else {
            // Avoid stripping "TR:2023" when 2023 is standalone year without trailing delim
            if (!(/^(?:19|20)\d{2}$/.test(tag1) && !hasExplicitTrailingDelim && codeUpper !== 'TR')) {
              working = rest;
              sawVerifiedPrefix = true;
              consumedProviderTag = true;
              changed = true;
              continue;
            }
          }
        }
      }
    }

    // Rule 3: Single verified prefix with explicit separator:
    // "TR: Matrix", "TR:Matrix", "EN: The Matrix", "TR | Matrix", "TR - Matrix", "VIP | Dune", "BYZBOX: Matrix"
    const singlePrefixMatch = working.match(
      /^([A-Za-z0-9+]{2,24})(\s*[:|/]\s*|\s+[-–—•·»›]\s+)(.+)$/
    );
    if (singlePrefixMatch) {
      const [, code, sep, restRaw] = singlePrefixMatch;
      const rest = restRaw.trim();
      const codeUpper = code.toUpperCase();
      const isColon = sep.includes(':');

      const qualifiesAsStandalone =
        (STANDALONE_PREFIX_TAGS.has(codeUpper) && isSafeCodePrefixCase(code)) ||
        isStrongProviderBrand(code);

      // Do not turn a prefix-only string like "TR:BYZBOX" (with no title after it) into "BYZBOX"
      const restIsOnlyProviderTag =
        !rest.includes(' ') && isStrongProviderBrand(rest);

      if (
        rest.length > 0 &&
        !restIsOnlyProviderTag &&
        qualifiesAsStandalone &&
        !(isColon && isRealColonTitleException(code, rest))
      ) {
        working = rest;
        sawVerifiedPrefix = true;
        if (isStrongProviderBrand(code)) consumedProviderTag = true;
        changed = true;
        continue;
      }
    }

    // Rule 4: Secondary space-separated provider/quality token ONLY after a verified prefix was already stripped
    // Handles: "TR: BYZBOX Matrix", "[TR] BYZBOX John Wick", "TR:BYZBOX 4K Matrix"
    // Preserves real colon titles like "TR:BYZBOX TRON: Legacy" and "TR: CSI: Miami"
    if (sawVerifiedPrefix) {
      const secondaryMatch = working.match(
        /^([A-Za-z0-9._+-]{2,24})(\s*[-–—:|/•·»›]\s*|\s+)(.+)$/
      );
      if (secondaryMatch) {
        const [, token, sep, restRaw] = secondaryMatch;
        const rest = restRaw.trim();
        const tokenUpper = token.toUpperCase();
        const sepHasColon = sep.includes(':');
        const sepHasExplicitDelim = /[-–—:|/•·»›]/.test(sep);
        // Never strip bare 2-letter words like "En" (Turkish "En Büyük Şaban") unless compact quality tag (4K, HD, SD, NF, D+, TV)
        const lengthOk = token.length >= 3 || COMPACT_SECONDARY_TAGS.has(tokenUpper);

        // If we already stripped a provider tag (e.g., TR:BYZBOX) OR the next token is followed by a colon
        // (e.g., "TRON: Legacy", "CSI: Miami"), ONLY strip strictly safe technical tags (or known tags with explicit delim)
        // so real broadcast brands like "beIN SPORTS 1" or "Sky Cinema" are never stripped!
        const tokenQualifies =
          consumedProviderTag || sepHasColon
            ? (sepHasExplicitDelim ? isKnownTag(token) : SPACE_SAFE_SECONDARY_TAGS.has(tokenUpper)) ||
              isStrongProviderBrand(token) ||
              (isVerifiedCode(token) && sepHasColon)
            : isProviderStyledToken(token, rest);

        if (
          rest.length > 0 &&
          lengthOk &&
          tokenQualifies &&
          !(sepHasColon && isRealColonTitleException(token, rest))
        ) {
          working = rest;
          consumedProviderTag = true;
          changed = true;
          continue;
        }
      }
    }

    if (!changed) break;
  }

  if (sawVerifiedPrefix) {
    working = working.replace(/^[-–—:|/•·»›\s]+/, '').trim();
  }
  working = working.replace(/\s+/g, ' ').trim();

  // Safety guarantee: never return empty or punctuation-only title
  const result = working.length > 0 && /[\p{L}\p{N}]/u.test(working) ? working : normalized;

  if (cleanTitleCache.size >= MAX_CACHE_SIZE) {
    const oldest = cleanTitleCache.keys().next().value;
    if (oldest !== undefined) cleanTitleCache.delete(oldest);
  }
  cleanTitleCache.set(normalized, result);

  return result;
}

/**
 * Cleans episode/watch-progress subtitle strings (e.g. "S1 E1 · TR:BYZBOX Pilot")
 * while keeping season/episode markers intact.
 */
export function cleanDisplaySubtitle(rawSubtitle?: string | null): string {
  if (!rawSubtitle) return '';
  const parts = rawSubtitle.split(' · ');
  if (parts.length <= 1) return cleanMediaTitle(rawSubtitle);
  return parts.map((part) => cleanMediaTitle(part)).join(' · ');
}

function foldSearchText(value: string): string {
  return value.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase();
}

/**
 * Matches a search query against both the cleaned display title and the original
 * raw title (plus any optional extra metadata fields like genre, category, cast).
 */
export function matchesMediaQuery(
  rawTitle: string,
  normalizedLowerQuery: string,
  ...extraFields: Array<string | undefined>
): boolean {
  if (!normalizedLowerQuery) return true;
  const foldedQuery = foldSearchText(normalizedLowerQuery);
  const cleaned = cleanMediaTitle(rawTitle);
  if (cleaned.toLowerCase().includes(normalizedLowerQuery) || foldSearchText(cleaned).includes(foldedQuery)) {
    return true;
  }
  if (rawTitle.toLowerCase().includes(normalizedLowerQuery) || foldSearchText(rawTitle).includes(foldedQuery)) {
    return true;
  }
  for (const field of extraFields) {
    if (
      field &&
      (field.toLowerCase().includes(normalizedLowerQuery) || foldSearchText(field).includes(foldedQuery))
    ) {
      return true;
    }
  }
  return false;
}
