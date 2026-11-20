import type {
  EpisodeItem,
  LiveChannel,
  MovieItem,
  PlaylistCatalog,
  SeriesItem,
} from '../types/iptv';
import { cleanMediaTitle } from './titleCleaner';

export interface EpisodeSearchMatch {
  series: SeriesItem;
  episode: EpisodeItem;
  cleanSeriesTitle: string;
  cleanEpisodeTitle: string;
  episodeCode: string;
}

export interface CategorySearchMatch {
  section: 'live' | 'movies' | 'series';
  name: string;
  count: number;
}

export interface SmartSearchResults {
  movies: MovieItem[];
  series: SeriesItem[];
  episodes: EpisodeSearchMatch[];
  channels: LiveChannel[];
  categories: CategorySearchMatch[];
  totals: {
    movies: number;
    series: number;
    episodes: number;
    channels: number;
    categories: number;
    all: number;
  };
}

export interface SmartSearchLimits {
  movies?: number;
  series?: number;
  episodes?: number;
  channels?: number;
  categories?: number;
}

interface IndexedMovie {
  item: MovieItem;
  cleanTitleNorm: string;
  metaNorm: string;
}

interface IndexedSeries {
  item: SeriesItem;
  cleanTitleNorm: string;
  metaNorm: string;
}

interface IndexedEpisode {
  series: SeriesItem;
  episode: EpisodeItem;
  cleanSeriesTitle: string;
  cleanEpisodeTitle: string;
  episodeCode: string;
  titleNorm: string;
  seriesNorm: string;
  codeNorm: string;
}

interface IndexedChannel {
  item: LiveChannel;
  cleanTitleNorm: string;
  metaNorm: string;
}

interface IndexedCategory {
  match: CategorySearchMatch;
  nameNorm: string;
}

interface CatalogSearchIndex {
  movies: IndexedMovie[];
  series: IndexedSeries[];
  episodes: IndexedEpisode[];
  channels: IndexedChannel[];
  categories: IndexedCategory[];
}

const catalogIndexCache = new WeakMap<PlaylistCatalog, CatalogSearchIndex>();

const TURKISH_CHAR_MAP: Record<string, string> = {
  ç: 'c',
  Ç: 'c',
  ğ: 'g',
  Ğ: 'g',
  ı: 'i',
  I: 'i',
  İ: 'i',
  ö: 'o',
  Ö: 'o',
  ş: 's',
  Ş: 's',
  ü: 'u',
  Ü: 'u',
};

/**
 * Normalizes text for Turkish-aware, case-insensitive, diacritic-insensitive search.
 * Maps Turkish letters (ç/ğ/ı/İ/I/ö/ş/ü) to ASCII equivalents so both Turkish
 * and ASCII queries match seamlessly ("çukur" <-> "cukur", "İstanbul" <-> "istanbul").
 */
export function normalizeTurkishSearch(raw?: string | null): string {
  if (!raw) return '';
  let mapped = '';
  let hasNonAscii = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const tr = TURKISH_CHAR_MAP[ch];
    if (tr !== undefined) {
      mapped += tr;
    } else {
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        mapped += String.fromCharCode(code + 32);
      } else if (code > 127) {
        hasNonAscii = true;
        mapped += ch.toLowerCase();
      } else {
        mapped += ch;
      }
    }
  }

  if (hasNonAscii) {
    mapped = mapped.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Collapse dotted initialisms/acronyms (e.g., "g.o.r.a." -> "gora", "s.h.i.e.l.d." -> "shield")
  if (mapped.includes('.')) {
    mapped = mapped.replace(/(?:^|(?<=\s))(?:[a-z]\.){2,}[a-z]?/g, (m) => m.replace(/\./g, ''));
  }

  return mapped.replace(/\s+/g, ' ').trim();
}

function buildCatalogSearchIndex(catalog: PlaylistCatalog): CatalogSearchIndex {
  const existing = catalogIndexCache.get(catalog);
  if (existing) return existing;

  const movieCategoryCounts = new Map<string, number>();
  const seriesCategoryCounts = new Map<string, number>();
  const liveCategoryCounts = new Map<string, number>();

  const movies: IndexedMovie[] = new Array(catalog.movies.length);
  for (let i = 0; i < catalog.movies.length; i++) {
    const m = catalog.movies[i];
    const cleanTitle = cleanMediaTitle(m.name);
    if (m.category) {
      movieCategoryCounts.set(m.category, (movieCategoryCounts.get(m.category) || 0) + 1);
    }
    movies[i] = {
      item: m,
      cleanTitleNorm: normalizeTurkishSearch(cleanTitle),
      metaNorm: normalizeTurkishSearch(
        [m.category, m.genre, m.director, m.cast, m.year].filter(Boolean).join(' ')
      ),
    };
  }

  const series: IndexedSeries[] = new Array(catalog.series.length);
  const episodes: IndexedEpisode[] = [];
  for (let i = 0; i < catalog.series.length; i++) {
    const s = catalog.series[i];
    const cleanSeriesTitle = cleanMediaTitle(s.name);
    const seriesNorm = normalizeTurkishSearch(cleanSeriesTitle);
    if (s.category) {
      seriesCategoryCounts.set(s.category, (seriesCategoryCounts.get(s.category) || 0) + 1);
    }
    series[i] = {
      item: s,
      cleanTitleNorm: seriesNorm,
      metaNorm: normalizeTurkishSearch(
        [s.category, s.genre, s.cast, s.year].filter(Boolean).join(' ')
      ),
    };

    if (s.seasons && s.seasons.length > 0) {
      for (let si = 0; si < s.seasons.length; si++) {
        const season = s.seasons[si];
        const eps = season.episodes;
        if (!eps || eps.length === 0) continue;
        for (let ei = 0; ei < eps.length; ei++) {
          const ep = eps[ei];
          const cleanEpisodeTitle = cleanMediaTitle(ep.title);
          const sNum = ep.seasonNumber || season.seasonNumber || 1;
          const eNum = ep.episodeNumber || ei + 1;
          const sPad = String(sNum).padStart(2, '0');
          const ePad = String(eNum).padStart(2, '0');
          const episodeCode = `S${sPad}E${ePad}`;
          episodes.push({
            series: s,
            episode: ep,
            cleanSeriesTitle,
            cleanEpisodeTitle,
            episodeCode,
            titleNorm: normalizeTurkishSearch(cleanEpisodeTitle),
            seriesNorm,
            codeNorm: `s${sNum}e${eNum} s${sPad}e${ePad} s${sNum} b${eNum} sezon ${sNum} bolum ${eNum}`,
          });
        }
      }
    }
  }

  const channels: IndexedChannel[] = new Array(catalog.channels.length);
  for (let i = 0; i < catalog.channels.length; i++) {
    const ch = catalog.channels[i];
    const cleanTitle = cleanMediaTitle(ch.name);
    const cat = ch.category;
    if (cat) {
      liveCategoryCounts.set(cat, (liveCategoryCounts.get(cat) || 0) + 1);
    }
    channels[i] = {
      item: ch,
      cleanTitleNorm: normalizeTurkishSearch(cleanTitle),
      metaNorm: normalizeTurkishSearch(
        [String(ch.num || ''), ch.category, ch.normalizedCategory, ch.country].filter(Boolean).join(' ')
      ),
    };
  }

  const categories: IndexedCategory[] = [];
  for (const [name, count] of movieCategoryCounts.entries()) {
    categories.push({
      match: { section: 'movies', name, count },
      nameNorm: normalizeTurkishSearch(name),
    });
  }
  for (const [name, count] of seriesCategoryCounts.entries()) {
    categories.push({
      match: { section: 'series', name, count },
      nameNorm: normalizeTurkishSearch(name),
    });
  }
  for (const [name, count] of liveCategoryCounts.entries()) {
    categories.push({
      match: { section: 'live', name, count },
      nameNorm: normalizeTurkishSearch(name),
    });
  }

  const index: CatalogSearchIndex = { movies, series, episodes, channels, categories };
  catalogIndexCache.set(catalog, index);
  return index;
}

function scoreFieldMatch(
  primaryNorm: string,
  metaNorm: string,
  fullQuery: string,
  tokens: string[]
): number {
  if (!primaryNorm && !metaNorm) return 0;

  // Fast-path single token or full phrase in cleaned primary title
  if (primaryNorm === fullQuery) return 120;
  if (primaryNorm.startsWith(fullQuery)) return 95;
  if (primaryNorm.includes(` ${fullQuery}`)) return 82;
  if (primaryNorm.includes(fullQuery)) return 68;

  // Multi-token match across primary title + metadata
  if (tokens.length > 1) {
    let allInPrimary = true;
    for (let i = 0; i < tokens.length; i++) {
      if (!primaryNorm.includes(tokens[i])) {
        allInPrimary = false;
        break;
      }
    }
    if (allInPrimary) return 60;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!primaryNorm.includes(tok) && !metaNorm.includes(tok)) {
        return 0;
      }
    }
    return 32;
  }

  // Single token fallback against metadata (genre, category, cast, channel number)
  if (metaNorm.includes(fullQuery)) {
    return metaNorm.startsWith(fullQuery) ? 35 : 24;
  }

  return 0;
}

function insertTopScored<T>(
  bucket: Array<{ score: number; item: T }>,
  score: number,
  item: T,
  limit: number
) {
  if (limit <= 0) return;
  if (bucket.length < limit) {
    bucket.push({ score, item });
    if (bucket.length === limit) {
      bucket.sort((a, b) => b.score - a.score);
    }
    return;
  }
  if (score <= bucket[bucket.length - 1].score) return;
  bucket[bucket.length - 1] = { score, item };
  // Insertion bubble up (bucket is tiny: 5-36 elements)
  for (let i = bucket.length - 1; i > 0; i--) {
    if (bucket[i].score > bucket[i - 1].score) {
      const tmp = bucket[i - 1];
      bucket[i - 1] = bucket[i];
      bucket[i] = tmp;
    } else {
      break;
    }
  }
}

export function searchCatalogSmart(
  catalog: PlaylistCatalog | null,
  rawQuery: string,
  limits: SmartSearchLimits = {}
): SmartSearchResults {
  const empty: SmartSearchResults = {
    movies: [],
    series: [],
    episodes: [],
    channels: [],
    categories: [],
    totals: { movies: 0, series: 0, episodes: 0, channels: 0, categories: 0, all: 0 },
  };

  if (!catalog) return empty;
  const fullQuery = normalizeTurkishSearch(rawQuery);
  if (!fullQuery) return empty;

  const tokens = fullQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return empty;

  const index = buildCatalogSearchIndex(catalog);
  const maxMovies = limits.movies ?? 6;
  const maxSeries = limits.series ?? 6;
  const maxEpisodes = limits.episodes ?? 5;
  const maxChannels = limits.channels ?? 6;
  const maxCategories = limits.categories ?? 5;

  const topMovies: Array<{ score: number; item: MovieItem }> = [];
  let movieTotal = 0;
  for (let i = 0; i < index.movies.length; i++) {
    const entry = index.movies[i];
    const score = scoreFieldMatch(entry.cleanTitleNorm, entry.metaNorm, fullQuery, tokens);
    if (score > 0) {
      movieTotal++;
      const boost = (entry.item.poster ? 2 : 0) + (entry.item.rating ? Math.min(entry.item.rating, 10) * 0.2 : 0);
      insertTopScored(topMovies, score + boost, entry.item, maxMovies);
    }
  }

  const topSeries: Array<{ score: number; item: SeriesItem }> = [];
  let seriesTotal = 0;
  for (let i = 0; i < index.series.length; i++) {
    const entry = index.series[i];
    const score = scoreFieldMatch(entry.cleanTitleNorm, entry.metaNorm, fullQuery, tokens);
    if (score > 0) {
      seriesTotal++;
      const boost = (entry.item.poster ? 2 : 0) + (entry.item.rating ? Math.min(entry.item.rating, 10) * 0.2 : 0);
      insertTopScored(topSeries, score + boost, entry.item, maxSeries);
    }
  }

  const topEpisodes: Array<{ score: number; item: EpisodeSearchMatch }> = [];
  let episodeTotal = 0;
  for (let i = 0; i < index.episodes.length; i++) {
    const entry = index.episodes[i];
    const metaCombined = `${entry.seriesNorm} ${entry.codeNorm}`;
    const score = scoreFieldMatch(entry.titleNorm, metaCombined, fullQuery, tokens);
    if (score > 0) {
      episodeTotal++;
      insertTopScored(
        topEpisodes,
        score,
        {
          series: entry.series,
          episode: entry.episode,
          cleanSeriesTitle: entry.cleanSeriesTitle,
          cleanEpisodeTitle: entry.cleanEpisodeTitle,
          episodeCode: entry.episodeCode,
        },
        maxEpisodes
      );
    }
  }

  const topChannels: Array<{ score: number; item: LiveChannel }> = [];
  let channelTotal = 0;
  for (let i = 0; i < index.channels.length; i++) {
    const entry = index.channels[i];
    const score = scoreFieldMatch(entry.cleanTitleNorm, entry.metaNorm, fullQuery, tokens);
    if (score > 0) {
      channelTotal++;
      const boost = entry.item.logo ? 1.5 : 0;
      insertTopScored(topChannels, score + boost, entry.item, maxChannels);
    }
  }

  const topCategories: Array<{ score: number; item: CategorySearchMatch }> = [];
  let categoryTotal = 0;
  for (let i = 0; i < index.categories.length; i++) {
    const entry = index.categories[i];
    const score = scoreFieldMatch(entry.nameNorm, '', fullQuery, tokens);
    if (score > 0) {
      categoryTotal++;
      insertTopScored(topCategories, score + Math.min(entry.match.count / 500, 3), entry.match, maxCategories);
    }
  }

  topMovies.sort((a, b) => b.score - a.score);
  topSeries.sort((a, b) => b.score - a.score);
  topEpisodes.sort((a, b) => b.score - a.score);
  topChannels.sort((a, b) => b.score - a.score);
  topCategories.sort((a, b) => b.score - a.score);

  return {
    movies: topMovies.map((x) => x.item),
    series: topSeries.map((x) => x.item),
    episodes: topEpisodes.map((x) => x.item),
    channels: topChannels.map((x) => x.item),
    categories: topCategories.map((x) => x.item),
    totals: {
      movies: movieTotal,
      series: seriesTotal,
      episodes: episodeTotal,
      channels: channelTotal,
      categories: categoryTotal,
      all: movieTotal + seriesTotal + episodeTotal + channelTotal + categoryTotal,
    },
  };
}

// ============================================================================
// PER-PROFILE RECENT SEARCHES HELPERS (Backed by Durable Persistent Storage)
// ============================================================================

const MAX_RECENT_SEARCHES = 8;

export function addRecentSearchTerm(current: string[], query: string): string[] {
  const clean = query.trim();
  if (clean.length < 2) return current.slice(0, MAX_RECENT_SEARCHES);
  const norm = normalizeTurkishSearch(clean);
  return [
    clean,
    ...current.filter((item) => normalizeTurkishSearch(item) !== norm),
  ].slice(0, MAX_RECENT_SEARCHES);
}

export function removeRecentSearchTerm(current: string[], query: string): string[] {
  const norm = normalizeTurkishSearch(query);
  return current.filter((item) => normalizeTurkishSearch(item) !== norm);
}

