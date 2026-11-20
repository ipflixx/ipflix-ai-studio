import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Clapperboard,
  Clock,
  Film,
  FolderKanban,
  Play,
  Search,
  Tv,
  X,
} from 'lucide-react';
import type {
  EpisodeItem,
  LiveChannel,
  MovieItem,
  NavSection,
  PlaylistCatalog,
  SeriesItem,
} from '../types/iptv';
import { useI18n } from '../i18n/I18nContext';
import { cleanMediaTitle } from '../utils/titleCleaner';
import {
  addRecentSearchTerm,
  removeRecentSearchTerm,
  searchCatalogSmart,
  type CategorySearchMatch,
  type EpisodeSearchMatch,
} from '../utils/smartSearch';
import { ResilientImage } from './MediaArtwork';

interface HomeSmartSearchProps {
  catalog: PlaylistCatalog | null;
  profileId?: string;
  recentSearches: string[];
  onUpdateRecentSearches: (next: string[]) => void;
  onOpenMovieDetail: (movie: MovieItem) => void;
  onOpenSeriesDetail: (series: SeriesItem) => void;
  onPlayEpisode: (series: SeriesItem, episode: EpisodeItem) => void;
  onPlayChannel: (channel: LiveChannel) => void;
  onSelectCategory: (section: 'live' | 'movies' | 'series', category: string) => void;
  onOpenFullSearch: (query: string) => void;
  onNavigate?: (section: NavSection) => void;
}

type FlatSearchAction =
  | { key: string; kind: 'movie'; item: MovieItem }
  | { key: string; kind: 'series'; item: SeriesItem }
  | { key: string; kind: 'episode'; item: EpisodeSearchMatch }
  | { key: string; kind: 'channel'; item: LiveChannel }
  | { key: string; kind: 'category'; item: CategorySearchMatch }
  | { key: string; kind: 'view_all'; query: string };

const DEBOUNCE_MS = 180;

export function HomeSmartSearch({
  catalog,
  recentSearches,
  onUpdateRecentSearches,
  onOpenMovieDetail,
  onOpenSeriesDetail,
  onPlayEpisode,
  onPlayChannel,
  onSelectCategory,
  onOpenFullSearch,
}: HomeSmartSearchProps) {
  const { t } = useI18n();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const recentSearchesRef = useRef<string[]>(recentSearches);
  recentSearchesRef.current = recentSearches;

  // Debounce live search for snappy typing on huge IPTV libraries
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Listen for custom focus event dispatched from Top Bar Search button or Ctrl+K
  useEffect(() => {
    const onFocusRequest = () => {
      const input = inputRef.current;
      if (!input) return;
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus();
      input.select();
      setFocused(true);
      if (input.value.trim().length > 0 || recentSearchesRef.current.length > 0) {
        setPanelOpen(true);
      }
    };
    window.addEventListener('ipflix:focus-home-search', onFocusRequest);
    return () => window.removeEventListener('ipflix:focus-home-search', onFocusRequest);
  }, []);

  // Close results dropdown when clicking/tapping outside
  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
        setFocused(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [panelOpen]);

  const results = useMemo(
    () =>
      searchCatalogSmart(catalog, debouncedQuery, {
        movies: 6,
        series: 6,
        episodes: 5,
        channels: 6,
        categories: 5,
      }),
    [catalog, debouncedQuery]
  );

  const flatActions = useMemo<FlatSearchAction[]>(() => {
    if (!debouncedQuery) return [];
    const list: FlatSearchAction[] = [];
    for (const m of results.movies) {
      list.push({ key: `m_${m.id}`, kind: 'movie', item: m });
    }
    for (const s of results.series) {
      list.push({ key: `s_${s.id}`, kind: 'series', item: s });
    }
    for (const ep of results.episodes) {
      list.push({ key: `e_${ep.episode.id}`, kind: 'episode', item: ep });
    }
    for (const ch of results.channels) {
      list.push({ key: `c_${ch.id}`, kind: 'channel', item: ch });
    }
    for (const cat of results.categories) {
      list.push({ key: `cat_${cat.section}_${cat.name}`, kind: 'category', item: cat });
    }
    if (results.totals.all > 0) {
      list.push({ key: 'view_all', kind: 'view_all', query: debouncedQuery });
    }
    return list;
  }, [debouncedQuery, results]);

  // Reset active highlight when results list changes
  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  // Keep keyboard / Android TV highlighted result scrolled into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  const commitRecent = useCallback(
    (term: string) => {
      const updated = addRecentSearchTerm(recentSearchesRef.current, term);
      onUpdateRecentSearches(updated);
    },
    [onUpdateRecentSearches]
  );

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setActiveIndex(-1);
  }, []);

  const executeAction = useCallback(
    (action: FlatSearchAction) => {
      if (query.trim()) {
        commitRecent(query.trim());
      }
      closePanel();
      inputRef.current?.blur();

      switch (action.kind) {
        case 'movie':
          onOpenMovieDetail(action.item);
          break;
        case 'series':
          onOpenSeriesDetail(action.item);
          break;
        case 'episode':
          onPlayEpisode(action.item.series, action.item.episode);
          break;
        case 'channel':
          onPlayChannel(action.item);
          break;
        case 'category':
          onSelectCategory(action.item.section, action.item.name);
          break;
        case 'view_all':
          onOpenFullSearch(action.query);
          break;
      }
    },
    [
      closePanel,
      commitRecent,
      onOpenFullSearch,
      onOpenMovieDetail,
      onOpenSeriesDetail,
      onPlayChannel,
      onPlayEpisode,
      onSelectCategory,
      query,
    ]
  );

  const hasQuery = query.trim().length > 0;
  const hasDebouncedQuery = debouncedQuery.length > 0;
  const isSearching = hasQuery && query.trim() !== debouncedQuery;
  const showRecentDropdown = panelOpen && !hasQuery && recentSearches.length > 0;
  const showResultsDropdown = panelOpen && hasQuery;
  const showAnyPanel = showRecentDropdown || showResultsDropdown;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (showAnyPanel) {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
        return;
      }
      if (hasQuery) {
        e.preventDefault();
        e.stopPropagation();
        setQuery('');
        setDebouncedQuery('');
        return;
      }
      inputRef.current?.blur();
      return;
    }

    if (e.key === 'ArrowDown' && showResultsDropdown && flatActions.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((prev) => (prev + 1) % flatActions.length);
      return;
    }

    if (e.key === 'ArrowUp' && showResultsDropdown && flatActions.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((prev) => (prev <= 0 ? flatActions.length - 1 : prev - 1));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (showResultsDropdown && activeIndex >= 0 && flatActions[activeIndex]) {
        executeAction(flatActions[activeIndex]);
        return;
      }
      const trimmed = query.trim();
      if (trimmed) {
        commitRecent(trimmed);
        closePanel();
        inputRef.current?.blur();
        onOpenFullSearch(trimmed);
      }
    }
  };

  const actionIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    flatActions.forEach((a, idx) => map.set(a.key, idx));
    return map;
  }, [flatActions]);

  const categorySectionLabel = (section: 'live' | 'movies' | 'series') => {
    if (section === 'live') return t('nav.live');
    if (section === 'movies') return t('nav.movies');
    return t('nav.series');
  };

  return (
    <section
      aria-label={t('nav.search')}
      className="relative z-20 w-full px-4 sm:px-8 lg:px-12 xl:px-14 pt-3.5 sm:pt-4 pb-3.5 sm:pb-4 bg-[#08090D]"
    >
      <div ref={containerRef} className="relative w-full max-w-4xl">
        {/* ALWAYS-VISIBLE SMART SEARCH INPUT */}
        <div
          className={`relative flex items-center rounded-xl transition-all duration-150 border ${
            focused
              ? 'bg-[#151821] border-[#E50914]/85 ring-2 ring-[#E50914]/20 shadow-[0_8px_28px_-10px_rgba(229,9,20,0.35)]'
              : 'bg-[#12141B] border-white/[0.1] hover:border-white/[0.18]'
          }`}
        >
          <Search
            className={`w-[18px] h-[18px] ml-4 shrink-0 transition-colors ${
              focused ? 'text-[#E50914]' : 'text-[#8B93A4]'
            }`}
            aria-hidden="true"
          />

          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={showAnyPanel}
            aria-autocomplete="list"
            aria-controls="ipflix-home-search-results"
            aria-label={t('search.homePlaceholder')}
            data-focusable="true"
            data-home-search-input="true"
            value={query}
            onFocus={() => {
              setFocused(true);
              if (query.trim().length > 0 || recentSearches.length > 0) {
                setPanelOpen(true);
              }
            }}
            onBlur={() => {
              setFocused(false);
            }}
            onChange={(e) => {
              const val = e.target.value;
              setQuery(val);
              if (val.trim().length > 0) {
                setPanelOpen(true);
              } else {
                setPanelOpen(recentSearches.length > 0);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('search.homePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-h-[48px] sm:min-h-[50px] bg-transparent pl-3.5 pr-20 sm:pr-28 py-2.5 text-base sm:text-[15px] text-white placeholder:text-[#7F8799] focus:outline-none"
          />

          {/* Right Clear Button / Keyboard Shortcut Hint */}
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {hasQuery ? (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  setDebouncedQuery('');
                  setActiveIndex(-1);
                  setPanelOpen(recentSearches.length > 0);
                  inputRef.current?.focus();
                }}
                aria-label={t('search.clearSearch')}
                className="w-9 h-9 rounded-lg text-[#9CA3B2] hover:text-white hover:bg-white/[0.08] flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <kbd
                aria-hidden="true"
                className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.05] border border-white/[0.08] text-[11px] font-mono text-[#7F8799] select-none pointer-events-none"
              >
                Ctrl K
              </kbd>
            )}
          </div>
        </div>

        {/* FLOATING INSTANT RESULTS / RECENT SEARCHES PANEL (Zero layout shift) */}
        {showAnyPanel && (
          <div
            id="ipflix-home-search-results"
            ref={listRef}
            role="listbox"
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-40 rounded-xl bg-[#11131A]/98 backdrop-blur-2xl border border-white/[0.12] shadow-[0_24px_64px_-12px_rgba(0,0,0,0.88)] overflow-hidden"
          >
            <div className="max-h-[min(56dvh,420px)] sm:max-h-[min(68vh,540px)] overflow-y-auto overscroll-contain divide-y divide-white/[0.06]">
              {/* RECENT SEARCHES (Only when focused with empty query & history exists) */}
              {showRecentDropdown && (
                <div className="p-3 sm:p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <span className="text-xs font-semibold text-[#8B93A4]">
                      {t('search.recentSearches')}
                    </span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onUpdateRecentSearches([]);
                        setPanelOpen(false);
                      }}
                      className="text-xs font-medium text-[#8B93A4] hover:text-white transition-colors px-1.5 py-0.5"
                    >
                      {t('search.clearRecent')}
                    </button>
                  </div>

                  <div className="space-y-0.5">
                    {recentSearches.map((term) => (
                      <div
                        key={term}
                        className="flex items-center justify-between gap-2 rounded-lg hover:bg-white/[0.05] transition-colors"
                      >
                        <button
                          type="button"
                          data-focusable="true"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setQuery(term);
                            setDebouncedQuery(term);
                            setPanelOpen(true);
                            inputRef.current?.focus();
                          }}
                          className="flex-1 min-h-[42px] px-2.5 py-2 flex items-center gap-2.5 text-left text-sm text-[#D6DCE8] hover:text-white truncate"
                        >
                          <Clock className="w-3.5 h-3.5 text-[#7F8799] shrink-0" />
                          <span className="truncate">{term}</span>
                        </button>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            const updated = removeRecentSearchTerm(recentSearchesRef.current, term);
                            onUpdateRecentSearches(updated);
                            if (updated.length === 0) setPanelOpen(false);
                          }}
                          aria-label={t('common.delete')}
                          className="w-9 h-9 mr-1 rounded-md text-[#6F7788] hover:text-white hover:bg-white/[0.08] flex items-center justify-center shrink-0 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* LIVE CATEGORIZED RESULTS */}
              {showResultsDropdown && (
                <>
                  {isSearching && !hasDebouncedQuery ? (
                    <div className="px-5 py-8 text-center text-sm text-[#9CA3B2]">
                      {t('common.loading')}
                    </div>
                  ) : results.totals.all === 0 ? (
                    <div className="px-5 py-9 text-center space-y-1.5">
                      <p className="text-sm font-semibold text-white">
                        {t('search.noResults', { query: debouncedQuery || query.trim() })}
                      </p>
                      <p className="text-xs text-[#8B93A4]">
                        {t('search.emptyHint', { query: debouncedQuery || query.trim() })}
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* 1. MOVIES */}
                      {results.movies.length > 0 && (
                        <div className="p-2.5 sm:p-3 space-y-1">
                          <div className="px-2.5 py-1 flex items-center justify-between text-xs font-semibold text-[#8B93A4]">
                            <span className="inline-flex items-center gap-1.5">
                              <Film className="w-3.5 h-3.5 text-[#E50914]" />
                              {t('search.movieResults')}
                            </span>
                            <span className="tabular-nums text-[#6E7688]">
                              {results.totals.movies.toLocaleString()}
                            </span>
                          </div>
                          {results.movies.map((m) => {
                            const key = `m_${m.id}`;
                            const idx = actionIndexByKey.get(key) ?? -1;
                            const isActive = idx === activeIndex;
                            const cleanTitle = cleanMediaTitle(m.name);
                            const meta = [
                              m.year,
                              m.genre || m.category,
                              m.rating && m.rating > 0 ? `★ ${m.rating.toFixed(1)}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ');

                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => executeAction({ key, kind: 'movie', item: m })}
                                className={`w-full min-h-[56px] px-2.5 py-2 rounded-lg flex items-center gap-3 text-left transition-colors ${
                                  isActive
                                    ? 'bg-white/[0.1] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.06]'
                                }`}
                              >
                                <div className="w-9 h-[52px] rounded-md overflow-hidden bg-[#181B24] shrink-0">
                                  <ResilientImage
                                    src={m.poster}
                                    alt={cleanTitle}
                                    fallbackTitle={cleanTitle}
                                    fallbackKind="movie"
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {cleanTitle}
                                  </p>
                                  {meta && (
                                    <p className="text-xs text-[#8B93A4] truncate mt-0.5 tabular-nums">
                                      {meta}
                                    </p>
                                  )}
                                </div>
                                <span className="text-[11px] font-medium text-[#8B93A4] shrink-0">
                                  {t('search.typeMovie')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* 2. SERIES */}
                      {results.series.length > 0 && (
                        <div className="p-2.5 sm:p-3 space-y-1">
                          <div className="px-2.5 py-1 flex items-center justify-between text-xs font-semibold text-[#8B93A4]">
                            <span className="inline-flex items-center gap-1.5">
                              <Clapperboard className="w-3.5 h-3.5 text-[#E50914]" />
                              {t('search.seriesResults')}
                            </span>
                            <span className="tabular-nums text-[#6E7688]">
                              {results.totals.series.toLocaleString()}
                            </span>
                          </div>
                          {results.series.map((s) => {
                            const key = `s_${s.id}`;
                            const idx = actionIndexByKey.get(key) ?? -1;
                            const isActive = idx === activeIndex;
                            const cleanTitle = cleanMediaTitle(s.name);
                            const meta = [
                              s.year,
                              s.seasons.length > 0 ? `${s.seasons.length} ${t('common.seasons')}` : null,
                              s.genre || s.category,
                              s.rating && s.rating > 0 ? `★ ${s.rating.toFixed(1)}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ');

                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => executeAction({ key, kind: 'series', item: s })}
                                className={`w-full min-h-[56px] px-2.5 py-2 rounded-lg flex items-center gap-3 text-left transition-colors ${
                                  isActive
                                    ? 'bg-white/[0.1] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.06]'
                                }`}
                              >
                                <div className="w-9 h-[52px] rounded-md overflow-hidden bg-[#181B24] shrink-0">
                                  <ResilientImage
                                    src={s.poster}
                                    alt={cleanTitle}
                                    fallbackTitle={cleanTitle}
                                    fallbackKind="series"
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {cleanTitle}
                                  </p>
                                  {meta && (
                                    <p className="text-xs text-[#8B93A4] truncate mt-0.5 tabular-nums">
                                      {meta}
                                    </p>
                                  )}
                                </div>
                                <span className="text-[11px] font-medium text-[#8B93A4] shrink-0">
                                  {t('search.typeSeries')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* 3. SERIES EPISODES */}
                      {results.episodes.length > 0 && (
                        <div className="p-2.5 sm:p-3 space-y-1">
                          <div className="px-2.5 py-1 flex items-center justify-between text-xs font-semibold text-[#8B93A4]">
                            <span className="inline-flex items-center gap-1.5">
                              <Play className="w-3.5 h-3.5 text-[#E50914]" />
                              {t('search.episodeResults')}
                            </span>
                            <span className="tabular-nums text-[#6E7688]">
                              {results.totals.episodes.toLocaleString()}
                            </span>
                          </div>
                          {results.episodes.map((epMatch) => {
                            const key = `e_${epMatch.episode.id}`;
                            const idx = actionIndexByKey.get(key) ?? -1;
                            const isActive = idx === activeIndex;

                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => executeAction({ key, kind: 'episode', item: epMatch })}
                                className={`w-full min-h-[54px] px-2.5 py-2 rounded-lg flex items-center gap-3 text-left transition-colors ${
                                  isActive
                                    ? 'bg-white/[0.1] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.06]'
                                }`}
                              >
                                <div className="w-16 h-10 rounded-md overflow-hidden bg-[#181B24] shrink-0">
                                  <ResilientImage
                                    src={epMatch.episode.thumbnail || epMatch.series.backdrop || epMatch.series.poster}
                                    alt={epMatch.cleanEpisodeTitle}
                                    fallbackTitle={epMatch.cleanSeriesTitle}
                                    fallbackKind="series"
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {epMatch.cleanEpisodeTitle}
                                  </p>
                                  <p className="text-xs text-[#8B93A4] truncate mt-0.5 tabular-nums">
                                    {epMatch.cleanSeriesTitle} · {epMatch.episodeCode}
                                    {epMatch.episode.duration ? ` · ${epMatch.episode.duration}` : ''}
                                  </p>
                                </div>
                                <span className="text-[11px] font-medium text-[#8B93A4] shrink-0">
                                  {t('search.typeEpisode')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* 4. LIVE TV CHANNELS */}
                      {results.channels.length > 0 && (
                        <div className="p-2.5 sm:p-3 space-y-1">
                          <div className="px-2.5 py-1 flex items-center justify-between text-xs font-semibold text-[#8B93A4]">
                            <span className="inline-flex items-center gap-1.5">
                              <Tv className="w-3.5 h-3.5 text-[#E50914]" />
                              {t('search.liveResults')}
                            </span>
                            <span className="tabular-nums text-[#6E7688]">
                              {results.totals.channels.toLocaleString()}
                            </span>
                          </div>
                          {results.channels.map((ch) => {
                            const key = `c_${ch.id}`;
                            const idx = actionIndexByKey.get(key) ?? -1;
                            const isActive = idx === activeIndex;
                            const cleanName = cleanMediaTitle(ch.name);

                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => executeAction({ key, kind: 'channel', item: ch })}
                                className={`w-full min-h-[52px] px-2.5 py-2 rounded-lg flex items-center gap-3 text-left transition-colors ${
                                  isActive
                                    ? 'bg-white/[0.1] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.06]'
                                }`}
                              >
                                <div className="w-12 h-9 rounded-md overflow-hidden bg-[#181B24] border border-white/[0.06] flex items-center justify-center p-1 shrink-0">
                                  <ResilientImage
                                    src={ch.logo}
                                    alt={cleanName}
                                    fallbackTitle={cleanName}
                                    fallbackKind="channel"
                                    className="w-full h-full object-contain"
                                  />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {cleanName}
                                  </p>
                                  <p className="text-xs text-[#8B93A4] truncate mt-0.5 tabular-nums">
                                    {[ch.num ? `#${ch.num}` : null, ch.category]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </p>
                                </div>
                                <span className="text-[11px] font-medium text-[#E50914] shrink-0">
                                  {t('search.typeLive')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* 5. CATEGORIES */}
                      {results.categories.length > 0 && (
                        <div className="p-2.5 sm:p-3 space-y-1">
                          <div className="px-2.5 py-1 flex items-center justify-between text-xs font-semibold text-[#8B93A4]">
                            <span className="inline-flex items-center gap-1.5">
                              <FolderKanban className="w-3.5 h-3.5 text-[#E50914]" />
                              {t('search.categoryResults')}
                            </span>
                            <span className="tabular-nums text-[#6E7688]">
                              {results.totals.categories.toLocaleString()}
                            </span>
                          </div>
                          {results.categories.map((cat) => {
                            const key = `cat_${cat.section}_${cat.name}`;
                            const idx = actionIndexByKey.get(key) ?? -1;
                            const isActive = idx === activeIndex;

                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => executeAction({ key, kind: 'category', item: cat })}
                                className={`w-full min-h-[46px] px-2.5 py-2 rounded-lg flex items-center justify-between gap-3 text-left transition-colors ${
                                  isActive
                                    ? 'bg-white/[0.1] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.06]'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {cat.name}
                                  </p>
                                  <p className="text-xs text-[#8B93A4] truncate tabular-nums">
                                    {categorySectionLabel(cat.section)} ·{' '}
                                    {t('categories.itemsCount', { count: cat.count.toLocaleString() })}
                                  </p>
                                </div>
                                <span className="text-[11px] font-medium text-[#8B93A4] shrink-0">
                                  {t('search.typeCategory')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* VIEW ALL RESULTS FOOTER ACTION */}
                      {results.totals.all > 0 && (
                        <div className="p-2 bg-[#0D0F15]">
                          {(() => {
                            const idx = actionIndexByKey.get('view_all') ?? -1;
                            const isActive = idx === activeIndex;
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                data-focusable="true"
                                data-result-index={idx}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() =>
                                  executeAction({
                                    key: 'view_all',
                                    kind: 'view_all',
                                    query: debouncedQuery,
                                  })
                                }
                                className={`w-full min-h-[44px] px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center justify-between gap-2 transition-colors ${
                                  isActive
                                    ? 'bg-[#E50914] text-white'
                                    : 'text-[#E5E9F2] hover:bg-white/[0.07]'
                                }`}
                              >
                                <span className="tabular-nums">
                                  {t('search.viewAllResults', {
                                    total: results.totals.all.toLocaleString(),
                                  })}
                                </span>
                                <ArrowRight className="w-4 h-4 shrink-0" />
                              </button>
                            );
                          })()}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
