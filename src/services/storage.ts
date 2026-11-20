import type {
  AppNotification,
  AppSettings,
  PersistedAppState,
  PlaylistCatalog,
  PlaylistSource,
  ProfileData,
  ProfileListType,
  UserProfile,
  WatchProgress,
} from '../types/iptv';
import { DEFAULT_SETTINGS } from '../types/iptv';
import {
  decryptJsonWithDeviceKey,
  encryptJsonWithDeviceKey,
  encryptJsonWithRawAesKeySync,
  generateDeviceAesKey,
  generateRawDeviceAesKey,
  isCsprngAvailable,
  isWebCryptoSubtleAvailable,
  type DeviceVaultKey,
} from './vaultCrypto';

const DB_NAME = 'ipflix_store_v1';
const DB_VERSION = 2;
const STORE_CATALOGS = 'catalogs';
const STORE_APP_STATE = 'app_state';
const STORE_CRYPTO_KEYS = 'crypto_keys';

const APP_STATE_RECORD_KEY = 'primary_v2';
const APP_STATE_BACKUP_KEY = 'primary_v2_bak';
const APP_STATE_QUARANTINE_PREFIX = 'quarantine_v2_';
const DEVICE_KEY_RECORD_ID = 'device_aes_key_v1';
const DEVICE_RAW_KEY_RECORD_ID = 'device_aes_raw_key_v1';

// Legacy v1 localStorage keys (read ONLY during one-time migration; secrets are scrubbed immediately after migration)
const LS_PLAYLISTS = 'ipflix_playlists_v1';
const LS_ACTIVE_PLAYLIST = 'ipflix_active_playlist_v1';
const LS_SETTINGS = 'ipflix_settings_v1';
const LS_FAVORITES = 'ipflix_favorites_v1';
const LS_PROGRESS = 'ipflix_progress_v1';
const LS_RECENT_CHANNELS = 'ipflix_recent_channels_v1';
const LS_HIDDEN_CHANNELS = 'ipflix_hidden_channels_v1';
const LS_NOTIFICATIONS = 'ipflix_notifications_v1';
const LS_ONBOARDING_DONE = 'ipflix_onboarding_done_v1';
const LS_PROFILES = 'ipflix_profiles_v1';
const LS_ACTIVE_PROFILE = 'ipflix_active_profile_v1';
const LS_PROFILE_DATA_MAP = 'ipflix_profile_data_map_v1';
const LS_MIRROR_META = 'ipflix_meta_mirror_v2';
const LS_LEGACY_RECENT_SEARCH_PREFIX = 'ipflix_recent_searches_v1_';

const VALID_PLAYBACK_RATES = new Set([0.5, 0.75, 1, 1.25, 1.5, 2]);
const MAX_RECENT_SEARCHES = 8;

export const DEFAULT_PROFILE_ID = 'profile_primary';
export const GUEST_PROFILE_ID = 'profile_guest';
export const CURRENT_SCHEMA_VERSION = 3;

export type LocalEncryptionMode =
  | 'dpapi_safestorage'
  | 'node_aes_256_gcm'
  | 'webcrypto_aes_256_gcm'
  | 'aes_256_gcm';

export interface StorageDiagnostics {
  backend: 'electron_userdata' | 'browser_indexeddb';
  storagePath: string | null;
  sqliteEnabled?: boolean;
  sqlitePath?: string;
  schemaVersion?: number;
  safeStorageEncrypted: boolean;
  encryptionMode: LocalEncryptionMode;
  hydrated: boolean;
  persistentStorageGranted?: boolean;
  lastSavedAt: number | null;
  lastError: string | null;
  vaultLocked: boolean;
  vaultError: string | null;
  recoveredFromBackup: boolean;
}

type StorageChangeListener = (event: {
  source: 'local';
  state: PersistedAppState;
  diagnostics: StorageDiagnostics;
}) => void;

interface BrowserEncryptedEnvelope {
  id: string;
  schemaVersion: number;
  updatedAt: number;
  stateWithoutSecrets: PersistedAppState;
  encryptedSecrets: string;
}

interface SecretVaultBundle {
  playlistSecrets: Record<string, { password?: string; m3uUrl?: string; epgUrl?: string }>;
  profilePins: Record<string, string>;
}

const EMPTY_PROFILE_DATA: ProfileData = {
  favorites: [],
  watchlist: [],
  watchProgress: {},
  recentChannels: [],
  hiddenChannels: [],
  lastLiveChannelId: undefined,
  lastLiveCategory: undefined,
  recentSearches: [],
  listTimestamps: {},
};

let dbPromise: Promise<IDBDatabase> | null = null;
let cachedDb: IDBDatabase | null = null;
let cachedDeviceKey: DeviceVaultKey | null = null;
let hydrated = false;
let hydratePromise: Promise<PersistedAppState> | null = null;
let memState: PersistedAppState = createEmptyPersistedState();
let persistChain: Promise<void> = Promise.resolve();
let dirtyRevision = 0;
let persistedRevision = 0;
let vaultLocked = false;

let diagnostics: StorageDiagnostics = {
  backend: isElectronStorageAvailable() ? 'electron_userdata' : 'browser_indexeddb',
  storagePath: null,
  safeStorageEncrypted: false,
  encryptionMode: isElectronStorageAvailable()
    ? 'dpapi_safestorage'
    : isWebCryptoSubtleAvailable()
    ? 'webcrypto_aes_256_gcm'
    : 'aes_256_gcm',
  hydrated: false,
  lastSavedAt: null,
  lastError: null,
  vaultLocked: false,
  vaultError: null,
  recoveredFromBackup: false,
};

const listeners = new Set<StorageChangeListener>();

function isElectronStorageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ipflixDesktop?.storage);
}

async function requestPersistentBrowserStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      if (navigator.storage.persisted) {
        const already = await navigator.storage.persisted();
        if (already) return true;
      }
      return await navigator.storage.persist();
    }
  } catch {
    // Best-effort OS quota protection (unsupported on some plain HTTP contexts)
  }
  return false;
}

function clampVolume(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS.playerVolume;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}

function normalizePlaybackRate(raw: unknown): number {
  if (typeof raw === 'number' && VALID_PLAYBACK_RATES.has(raw)) return raw;
  return DEFAULT_SETTINGS.playerPlaybackRate;
}

function normalizeSettings(raw?: Partial<AppSettings> | null): AppSettings {
  const stored = raw || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    language: stored.language === 'en' ? 'en' : 'tr',
    introSoundEnabled: stored.introSoundEnabled ?? true,
    useServerProxy: true,
    directStreamFirst: false,
    customRelayUrl: '',
    playerVolume: clampVolume(stored.playerVolume),
    playerMuted: Boolean(stored.playerMuted),
    playerPlaybackRate: normalizePlaybackRate(stored.playerPlaybackRate),
    autoCheckUpdates: stored.autoCheckUpdates ?? true,
    skippedUpdateVersion:
      typeof stored.skippedUpdateVersion === 'string' && stored.skippedUpdateVersion.trim()
        ? stored.skippedUpdateVersion.trim()
        : undefined,
  };
}

function normalizeRecentSearches(raw?: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length < 2) continue;
    const key = trimmed.toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_RECENT_SEARCHES) break;
  }
  return out;
}

function dedupeStringArray(raw: unknown, limit?: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function normalizeWatchProgressMap(
  raw: unknown
): Record<string, WatchProgress> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, WatchProgress> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const entry = val as Partial<WatchProgress>;
    const itemId = typeof entry.itemId === 'string' && entry.itemId.trim() ? entry.itemId : key;
    if (!itemId) continue;
    const pos =
      typeof entry.position === 'number' && Number.isFinite(entry.position) && entry.position >= 0
        ? entry.position
        : 0;
    const dur =
      typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0
        ? entry.duration
        : 0;
    const updatedAt =
      typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : Date.now();
    const isCompleted =
      typeof entry.completed === 'boolean'
        ? entry.completed
        : dur > 0 && pos / dur >= 0.92;

    out[itemId] = {
      ...entry,
      itemId,
      type: entry.type === 'episode' || entry.type === 'live' ? entry.type : 'movie',
      title: typeof entry.title === 'string' ? entry.title : '',
      position: pos,
      duration: dur,
      updatedAt,
      completed: isCompleted,
      completedAt:
        isCompleted
          ? typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt)
            ? entry.completedAt
            : updatedAt
          : undefined,
    };
  }
  return out;
}

function normalizeProfileData(raw?: Partial<ProfileData> | null): ProfileData {
  if (!raw) {
    return {
      favorites: [],
      watchlist: [],
      watchProgress: {},
      recentChannels: [],
      hiddenChannels: [],
      lastLiveChannelId: undefined,
      lastLiveCategory: undefined,
      recentSearches: [],
      listTimestamps: {},
    };
  }
  return {
    favorites: dedupeStringArray(raw.favorites),
    watchlist: dedupeStringArray(raw.watchlist),
    watchProgress: normalizeWatchProgressMap(raw.watchProgress),
    recentChannels: dedupeStringArray(raw.recentChannels, 40),
    hiddenChannels: dedupeStringArray(raw.hiddenChannels),
    lastLiveChannelId:
      typeof raw.lastLiveChannelId === 'string' && raw.lastLiveChannelId.trim()
        ? raw.lastLiveChannelId
        : undefined,
    lastLiveCategory:
      typeof raw.lastLiveCategory === 'string' && raw.lastLiveCategory.trim()
        ? raw.lastLiveCategory
        : undefined,
    recentSearches: normalizeRecentSearches(raw.recentSearches),
    listTimestamps:
      raw.listTimestamps && typeof raw.listTimestamps === 'object'
        ? { ...raw.listTimestamps }
        : {},
    clearedHistoryAt: typeof raw.clearedHistoryAt === 'number' ? raw.clearedHistoryAt : undefined,
  };
}

function createEmptyPersistedState(): PersistedAppState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: 0,
    onboardingCompleted: false,
    activePlaylistId: null,
    activeProfileId: null,
    settings: normalizeSettings(DEFAULT_SETTINGS),
    settingsUpdatedAt: 0,
    playlists: [],
    deletedPlaylists: {},
    profiles: [],
    deletedProfiles: {},
    profileData: {},
    notifications: [],
  };
}

function normalizePersistedState(raw: Partial<PersistedAppState>): PersistedAppState {
  // Preserve ALL user data across schema/app version upgrades without resetting!
  const seenProfileIds = new Set<string>();
  const normalizedProfiles: UserProfile[] = Array.isArray(raw.profiles)
    ? raw.profiles
        .filter((p): p is UserProfile => {
          if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return false;
          if (seenProfileIds.has(p.id)) return false;
          seenProfileIds.add(p.id);
          return true;
        })
        .map((p) => ({
          ...p,
          isGuest: Boolean(p.isGuest) || p.id === GUEST_PROFILE_ID,
          hasPin: Boolean(p.pin && p.pin.length === 4) || Boolean(p.hasPin),
          updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : p.createdAt || Date.now(),
        }))
    : [];

  const seenPlaylistIds = new Set<string>();
  const normalizedPlaylists: PlaylistSource[] = Array.isArray(raw.playlists)
    ? raw.playlists.filter((p): p is PlaylistSource => {
        if (!p || typeof p.id !== 'string' || seenPlaylistIds.has(p.id)) return false;
        seenPlaylistIds.add(p.id);
        return true;
      })
    : [];

  const profileData: Record<string, ProfileData> = {};
  if (raw.profileData && typeof raw.profileData === 'object') {
    for (const [pid, pdata] of Object.entries(raw.profileData)) {
      profileData[pid] = normalizeProfileData(pdata);
    }
  }

  const hasRealSource = normalizedPlaylists.some((p) => p.type !== 'demo');

  return {
    schemaVersion:
      typeof raw.schemaVersion === 'number' && raw.schemaVersion > CURRENT_SCHEMA_VERSION
        ? raw.schemaVersion
        : CURRENT_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    onboardingCompleted: Boolean(raw.onboardingCompleted) || hasRealSource,
    activePlaylistId: typeof raw.activePlaylistId === 'string' ? raw.activePlaylistId : null,
    activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : null,
    settings: normalizeSettings(raw.settings),
    settingsUpdatedAt: typeof raw.settingsUpdatedAt === 'number' ? raw.settingsUpdatedAt : 0,
    playlists: normalizedPlaylists,
    deletedPlaylists:
      raw.deletedPlaylists && typeof raw.deletedPlaylists === 'object'
        ? { ...raw.deletedPlaylists }
        : {},
    profiles: normalizedProfiles,
    deletedProfiles:
      raw.deletedProfiles && typeof raw.deletedProfiles === 'object'
        ? { ...raw.deletedProfiles }
        : {},
    profileData,
    notifications: Array.isArray(raw.notifications) ? raw.notifications.slice(0, 30) : [],
  };
}

function notifyListeners(): void {
  const snap = getPersistedStateSnapshot();
  const diag = getStorageDiagnostics();
  for (const fn of listeners) {
    try {
      fn({ source: 'local', state: snap, diagnostics: diag });
    } catch {
      // isolate subscriber errors
    }
  }
}

export function subscribeStorageEvents(fn: StorageChangeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getStorageDiagnostics(): StorageDiagnostics {
  return { ...diagnostics };
}

export function getPersistedStateSnapshot(): PersistedAppState {
  return structuredClone(memState);
}

// ============================================================================
// IndexedDB Core (Catalogs + Encrypted App State + Crypto Keys)
// ============================================================================
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CATALOGS)) {
        db.createObjectStore(STORE_CATALOGS, { keyPath: 'playlistId' });
      }
      if (!db.objectStoreNames.contains(STORE_APP_STATE)) {
        db.createObjectStore(STORE_APP_STATE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CRYPTO_KEYS)) {
        db.createObjectStore(STORE_CRYPTO_KEYS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      cachedDb = req.result;
      cachedDb.onclose = () => {
        cachedDb = null;
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

/**
 * Resolves the device's AES-256-GCM key cleanly across ALL browser environments:
 * - Secure Context (HTTPS / localhost): preserves existing non-extractable Web Crypto CryptoKey
 *   in IndexedDB `crypto_keys` (`device_aes_key_v1`).
 * - LAN HTTP (Android phone & Android TV over `http://192.168.x.x:3000` where `crypto.subtle`
 *   is restricted by browser policy): creates and persists a 256-bit CSPRNG key in IndexedDB
 *   `crypto_keys` (`device_aes_raw_key_v1`) and uses genuine NIST AES-256-GCM (`@noble/ciphers`).
 *
 * Encryption is NEVER disabled and sensitive data is NEVER stored in plaintext.
 */
async function getOrCreateBrowserDeviceKey(): Promise<DeviceVaultKey | null> {
  if (cachedDeviceKey) return cachedDeviceKey;

  try {
    const hasSubtle = isWebCryptoSubtleAvailable();

    // 1. Existing Web Crypto non-extractable key (100% backwards-compatible with existing vaults)
    if (hasSubtle) {
      const existingWebKey = await idbGet<{ id: string; key: CryptoKey }>(
        STORE_CRYPTO_KEYS,
        DEVICE_KEY_RECORD_ID
      );
      if (existingWebKey?.key) {
        cachedDeviceKey = { kind: 'webcrypto', key: existingWebKey.key };
        return cachedDeviceKey;
      }
    }

    // 2. Existing raw AES-256-GCM key (used on LAN HTTP on Android phone & Android TV)
    const existingRawKey = await idbGet<{ id: string; rawKey: Uint8Array | ArrayBuffer }>(
      STORE_CRYPTO_KEYS,
      DEVICE_RAW_KEY_RECORD_ID
    );
    if (existingRawKey?.rawKey) {
      const bytes =
        existingRawKey.rawKey instanceof Uint8Array
          ? existingRawKey.rawKey
          : new Uint8Array(existingRawKey.rawKey);
      if (bytes.byteLength === 32) {
        cachedDeviceKey = { kind: 'noble', rawKey: bytes };
        return cachedDeviceKey;
      }
    }

    // 3. First-time key creation on Secure Context -> Web Crypto non-extractable AES-256-GCM
    if (hasSubtle) {
      const created = await generateDeviceAesKey();
      await idbPut(STORE_CRYPTO_KEYS, { id: DEVICE_KEY_RECORD_ID, key: created });
      cachedDeviceKey = { kind: 'webcrypto', key: created };
      return cachedDeviceKey;
    }

    // 4. First-time key creation on LAN HTTP (Android phone / Android TV) -> CSPRNG AES-256-GCM
    if (isCsprngAvailable()) {
      const rawKey = generateRawDeviceAesKey();
      await idbPut(STORE_CRYPTO_KEYS, { id: DEVICE_RAW_KEY_RECORD_ID, rawKey });
      cachedDeviceKey = { kind: 'noble', rawKey };
      return cachedDeviceKey;
    }

    return null;
  } catch {
    return null;
  }
}

function splitStateAndSecrets(state: PersistedAppState): {
  sanitized: PersistedAppState;
  secrets: SecretVaultBundle;
} {
  const playlistSecrets: SecretVaultBundle['playlistSecrets'] = {};
  const playlists = state.playlists.map((pl) => {
    const copy: PlaylistSource = { ...pl };
    const entry: { password?: string; m3uUrl?: string; epgUrl?: string } = {};
    let hasSecret = false;
    if (copy.password) {
      entry.password = copy.password;
      hasSecret = true;
    }
    if (copy.m3uUrl) {
      entry.m3uUrl = copy.m3uUrl;
      hasSecret = true;
    }
    if (copy.epgUrl) {
      entry.epgUrl = copy.epgUrl;
      hasSecret = true;
    }
    delete copy.password;
    delete copy.m3uUrl;
    delete copy.epgUrl;
    if (hasSecret) {
      copy.hasEncryptedSecrets = true;
      playlistSecrets[pl.id] = entry;
    } else {
      delete copy.hasEncryptedSecrets;
    }
    return copy;
  });

  const profilePins: SecretVaultBundle['profilePins'] = {};
  const profiles = state.profiles.map((prof) => {
    const copy: UserProfile = { ...prof };
    if (copy.pin && copy.pin.length === 4) {
      profilePins[prof.id] = copy.pin;
      copy.hasPin = true;
    } else {
      copy.hasPin = false;
    }
    delete copy.pin;
    return copy;
  });

  return {
    sanitized: {
      ...state,
      playlists,
      profiles,
    },
    secrets: { playlistSecrets, profilePins },
  };
}

function mergeSecretsIntoState(
  state: PersistedAppState,
  secrets: SecretVaultBundle | null
): PersistedAppState {
  if (!secrets) return state;
  return {
    ...state,
    playlists: state.playlists.map((pl) => {
      const sec = secrets.playlistSecrets?.[pl.id];
      if (!sec) return pl;
      return {
        ...pl,
        password: sec.password ?? pl.password,
        m3uUrl: sec.m3uUrl ?? pl.m3uUrl,
        epgUrl: sec.epgUrl ?? pl.epgUrl,
      };
    }),
    profiles: state.profiles.map((prof) => {
      const pin = secrets.profilePins?.[prof.id];
      if (!pin) return prof;
      return {
        ...prof,
        pin,
        hasPin: true,
      };
    }),
  };
}

// ============================================================================
// Legacy localStorage Readers (One-Time Non-Destructive Migration)
// ============================================================================
function readLegacyLocalStorageJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * One-time non-destructive migration of legacy `ipflix_recent_searches_v1_<profileId>`
 * from browser localStorage into durable `PersistedAppState.profileData[profileId].recentSearches`.
 * Returns true if any legacy search terms were imported.
 */
function migrateLegacyRecentSearchesIntoState(state: PersistedAppState): boolean {
  let migrated = false;
  try {
    const candidateProfileIds = new Set<string>([
      ...state.profiles.map((p) => p.id),
      ...Object.keys(state.profileData),
      DEFAULT_PROFILE_ID,
      'default',
    ]);

    for (const pid of candidateProfileIds) {
      const lsKey = `${LS_LEGACY_RECENT_SEARCH_PREFIX}${pid}`;
      const raw = localStorage.getItem(lsKey);
      if (!raw) continue;
      const parsed = normalizeRecentSearches(JSON.parse(raw));
      if (parsed.length > 0) {
        const targetPid = pid === 'default' ? state.activeProfileId || state.profiles[0]?.id || DEFAULT_PROFILE_ID : pid;
        const current = normalizeProfileData(state.profileData[targetPid]);
        const merged = normalizeRecentSearches([...(current.recentSearches || []), ...parsed]);
        if (merged.length !== (current.recentSearches || []).length) {
          state.profileData[targetPid] = {
            ...current,
            recentSearches: merged,
          };
          migrated = true;
        }
      }
      localStorage.removeItem(lsKey);
    }
  } catch {
    // ignore storage access issues
  }
  return migrated;
}

function readLegacyLocalStorageState(): PersistedAppState | null {
  try {
    const legacyPlaylists = readLegacyLocalStorageJson<PlaylistSource[]>(LS_PLAYLISTS, []);
    const legacyProfiles = readLegacyLocalStorageJson<UserProfile[]>(LS_PROFILES, []);
    const legacyProfileData = readLegacyLocalStorageJson<Record<string, ProfileData>>(
      LS_PROFILE_DATA_MAP,
      {}
    );
    const legacySettings = readLegacyLocalStorageJson<Partial<AppSettings> | null>(
      LS_SETTINGS,
      null
    );
    const legacyNotifs = readLegacyLocalStorageJson<AppNotification[]>(LS_NOTIFICATIONS, []);
    const legacyActivePlaylist = localStorage.getItem(LS_ACTIVE_PLAYLIST);
    const legacyActiveProfile = localStorage.getItem(LS_ACTIVE_PROFILE);
    const legacyOnboarding = localStorage.getItem(LS_ONBOARDING_DONE) === '1';

    const legacyGlobalFavs = readLegacyLocalStorageJson<string[]>(LS_FAVORITES, []);
    const legacyGlobalProgress = readLegacyLocalStorageJson<Record<string, WatchProgress>>(
      LS_PROGRESS,
      {}
    );
    const legacyGlobalRecent = readLegacyLocalStorageJson<string[]>(LS_RECENT_CHANNELS, []);
    const legacyGlobalHidden = readLegacyLocalStorageJson<string[]>(LS_HIDDEN_CHANNELS, []);

    const hasAnyLegacy =
      legacyPlaylists.length > 0 ||
      legacyProfiles.length > 0 ||
      Object.keys(legacyProfileData).length > 0 ||
      legacyGlobalFavs.length > 0 ||
      Object.keys(legacyGlobalProgress).length > 0 ||
      legacySettings !== null ||
      legacyOnboarding;

    if (!hasAnyLegacy) return null;

    const profiles =
      legacyProfiles.length > 0 ? legacyProfiles : [createDefaultProfile('Ana Profil')];
    const profileData: Record<string, ProfileData> = {};
    for (const [pid, pdata] of Object.entries(legacyProfileData)) {
      profileData[pid] = normalizeProfileData(pdata);
    }

    if (
      !profileData[DEFAULT_PROFILE_ID] &&
      (legacyGlobalFavs.length > 0 ||
        Object.keys(legacyGlobalProgress).length > 0 ||
        legacyGlobalRecent.length > 0 ||
        legacyGlobalHidden.length > 0)
    ) {
      profileData[DEFAULT_PROFILE_ID] = normalizeProfileData({
        favorites: legacyGlobalFavs,
        watchlist: [],
        watchProgress: legacyGlobalProgress,
        recentChannels: legacyGlobalRecent,
        hiddenChannels: legacyGlobalHidden,
      });
    }

    const now = Date.now();
    const migratedState = normalizePersistedState({
      schemaVersion: 2,
      updatedAt: now,
      onboardingCompleted: legacyOnboarding || legacyPlaylists.some((p) => p.type !== 'demo'),
      activePlaylistId: legacyActivePlaylist,
      activeProfileId: legacyActiveProfile || profiles[0]?.id || DEFAULT_PROFILE_ID,
      settings: normalizeSettings(legacySettings),
      settingsUpdatedAt: now,
      playlists: legacyPlaylists,
      deletedPlaylists: {},
      profiles,
      deletedProfiles: {},
      profileData,
      notifications: legacyNotifs,
    });
    migrateLegacyRecentSearchesIntoState(migratedState);
    return migratedState;
  } catch {
    return null;
  }
}

function scrubLegacyPlaintextLocalStorage(): void {
  try {
    // Scrub legacy plaintext credentials & profiles from localStorage once safely migrated to encrypted vault
    localStorage.removeItem(LS_PLAYLISTS);
    localStorage.removeItem(LS_PROFILES);
    localStorage.removeItem(LS_FAVORITES);
    localStorage.removeItem(LS_PROGRESS);
    localStorage.removeItem(LS_RECENT_CHANNELS);
    localStorage.removeItem(LS_HIDDEN_CHANNELS);
    localStorage.removeItem(LS_PROFILE_DATA_MAP);
    localStorage.removeItem(LS_ACTIVE_PLAYLIST);
    localStorage.removeItem(LS_ACTIVE_PROFILE);
    localStorage.removeItem(LS_NOTIFICATIONS);
    localStorage.removeItem(LS_ONBOARDING_DONE);
    // Clean any legacy recent search keys
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_LEGACY_RECENT_SEARCH_PREFIX)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }
}

function writeNonSecretMetaMirror(state: PersistedAppState): void {
  try {
    // Only lightweight non-secret boot hints (language & intro sound) — zero IPTV passwords or PINs!
    localStorage.setItem(
      LS_MIRROR_META,
      JSON.stringify({
        language: state.settings.language,
        introSoundEnabled: state.settings.introSoundEnabled,
        updatedAt: state.updatedAt,
      })
    );
  } catch {
    // ignore
  }
}

// ============================================================================
// Durable Save Queue (Electron userData + DPAPI safeStorage OR Browser IndexedDB + AES-256-GCM)
// ============================================================================
function persistStateToDisk(): Promise<void> {
  if (!hydrated) {
    return Promise.resolve();
  }

  // CRITICAL SAFETY GUARD: Never overwrite existing vault/state while vault decryption is locked!
  if (vaultLocked) {
    diagnostics = {
      ...diagnostics,
      vaultLocked: true,
      lastError:
        diagnostics.vaultError ||
        'Şifreli kasa kilitli olduğu için mevcut verilerinizin üzerine yazılmadı.',
    };
    notifyListeners();
    return Promise.resolve();
  }

  const targetRevision = ++dirtyRevision;
  const snapshot = structuredClone(memState);
  writeNonSecretMetaMirror(snapshot);

  persistChain = persistChain.then(async () => {
    // Coalesce rapid bursts and NEVER let an older async snapshot overwrite a newer sync flush
    if (vaultLocked || persistedRevision >= targetRevision || targetRevision < dirtyRevision) {
      return;
    }

    try {
      if (isElectronStorageAvailable()) {
        if (persistedRevision >= targetRevision) return;
        const res = await window.ipflixDesktop!.storage.saveState(
          snapshot as unknown as Record<string, unknown>
        );
        if (res.vaultLocked) {
          vaultLocked = true;
          diagnostics = {
            ...diagnostics,
            vaultLocked: true,
            vaultError:
              res.error || 'Şifreli kasa çözülemedi; mevcut verileriniz koruma altına alındı.',
            lastError:
              res.error || 'Şifreli kasa çözülemedi; mevcut verileriniz koruma altına alındı.',
          };
          notifyListeners();
          return;
        }
        if (!res.ok) {
          throw new Error(res.error || 'Electron userData kaydetme başarısız oldu.');
        }
        persistedRevision = Math.max(persistedRevision, targetRevision);
        diagnostics = {
          ...diagnostics,
          lastSavedAt: res.savedAt || Date.now(),
          lastError: null,
        };
      } else {
        const { sanitized, secrets } = splitStateAndSecrets(snapshot);
        const deviceKey = await getOrCreateBrowserDeviceKey();
        if (!deviceKey) {
          throw new Error('AES-256-GCM şifreleme anahtarı oluşturulamadı.');
        }
        const encryptedSecrets = await encryptJsonWithDeviceKey(deviceKey, secrets);
        // Re-check after async crypto/key lookup so an interleaved sync unload flush is never clobbered
        if (vaultLocked || persistedRevision >= targetRevision) {
          return;
        }
        const envelope: BrowserEncryptedEnvelope = {
          id: APP_STATE_RECORD_KEY,
          schemaVersion: 2,
          updatedAt: snapshot.updatedAt,
          stateWithoutSecrets: sanitized,
          encryptedSecrets,
        };
        const backupEnvelope: BrowserEncryptedEnvelope = {
          ...envelope,
          id: APP_STATE_BACKUP_KEY,
        };
        // Preserve previous healthy envelope into backup before/with primary update
        const previousPrimary = await idbGet<BrowserEncryptedEnvelope>(
          STORE_APP_STATE,
          APP_STATE_RECORD_KEY
        );
        if (previousPrimary && previousPrimary.encryptedSecrets) {
          await idbPut(STORE_APP_STATE, {
            ...previousPrimary,
            id: APP_STATE_BACKUP_KEY,
          });
        }
        await idbPut(STORE_APP_STATE, envelope);
        // If no prior backup existed (first save), seed backup immediately so recovery always has a copy
        if (!previousPrimary) {
          await idbPut(STORE_APP_STATE, backupEnvelope);
        }
        persistedRevision = Math.max(persistedRevision, targetRevision);
        diagnostics = {
          ...diagnostics,
          safeStorageEncrypted: true,
          encryptionMode:
            deviceKey.kind === 'webcrypto' ? 'webcrypto_aes_256_gcm' : 'aes_256_gcm',
          lastSavedAt: Date.now(),
          lastError: null,
        };
      }
      notifyListeners();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[IPFLIX Storage] Persist failed:', msg);
      diagnostics = {
        ...diagnostics,
        lastError: msg,
      };
      notifyListeners();
    }
  });

  return persistChain;
}

export async function flushPendingSaves(): Promise<void> {
  await persistChain.catch(() => {});
}

/**
 * Crash / abrupt-close safety flush invoked during `beforeunload`, `pagehide`,
 * and `visibilitychange` (hidden).
 * - In Electron Desktop: executes synchronous IPC write (`saveStateSync`) so `vault.bin`
 *   and `state.json` are atomically flushed with `fsyncSync` BEFORE the renderer closes.
 * - In Browser (LAN HTTP / Android phone / Android TV): encrypts synchronously via
 *   `@noble/ciphers` AES-256-GCM and commits directly into the warm IndexedDB handle in the
 *   same event-loop tick so abrupt tab closure cannot drop in-flight edits.
 * - In Browser (Secure Context Web Crypto): kicks off an immediate persist flush.
 */
export function flushPendingSavesSync(): void {
  if (!hydrated || vaultLocked) return;
  const hasUnflushed = dirtyRevision > persistedRevision;
  const snapshot = structuredClone(memState);
  writeNonSecretMetaMirror(snapshot);

  try {
    if (isElectronStorageAvailable() && window.ipflixDesktop?.storage.saveStateSync) {
      if (hasUnflushed || diagnostics.lastSavedAt === null) {
        const res = window.ipflixDesktop.storage.saveStateSync(
          snapshot as unknown as Record<string, unknown>
        );
        if (res?.vaultLocked) {
          vaultLocked = true;
          diagnostics = {
            ...diagnostics,
            vaultLocked: true,
            vaultError: res.error || diagnostics.vaultError,
            lastError: res.error || diagnostics.lastError,
          };
          return;
        }
        if (res?.ok) {
          persistedRevision = dirtyRevision;
          diagnostics = {
            ...diagnostics,
            lastSavedAt: res.savedAt || Date.now(),
            lastError: null,
          };
        }
      }
      return;
    }

    // Browser synchronous IndexedDB transaction dispatch for raw AES-256-GCM key (LAN HTTP Android/TV)
    if (cachedDb && cachedDeviceKey && cachedDeviceKey.kind === 'noble' && hasUnflushed) {
      const { sanitized, secrets } = splitStateAndSecrets(snapshot);
      const encryptedSecrets = encryptJsonWithRawAesKeySync(cachedDeviceKey.rawKey, secrets);
      const envelope: BrowserEncryptedEnvelope = {
        id: APP_STATE_RECORD_KEY,
        schemaVersion: 2,
        updatedAt: snapshot.updatedAt,
        stateWithoutSecrets: sanitized,
        encryptedSecrets,
      };
      const tx = cachedDb.transaction(STORE_APP_STATE, 'readwrite');
      tx.objectStore(STORE_APP_STATE).put(envelope);
      persistedRevision = dirtyRevision;
      return;
    }

    // Secure context Web Crypto path: ensure any pending write is queued immediately
    if (hasUnflushed) {
      void persistStateToDisk();
    }
  } catch {
    // Fallback to async chain on any transient unload error
    void persistStateToDisk();
  }
}

// ============================================================================
// Startup Hydration (Strictly runs BEFORE defaults are ever initialized)
// ============================================================================
export async function hydratePersistentStorage(): Promise<PersistedAppState> {
  if (hydrated) return getPersistedStateSnapshot();
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    try {
      if (isElectronStorageAvailable()) {
        const info = await window.ipflixDesktop!.storage.getInfo();
        diagnostics = {
          backend: 'electron_userdata',
          storagePath: info.sqlitePath || info.storeDir,
          sqliteEnabled: Boolean(info.sqliteEnabled),
          sqlitePath: info.sqlitePath,
          schemaVersion: info.schemaVersion,
          safeStorageEncrypted: true,
          encryptionMode: info.safeStorageAvailable ? 'dpapi_safestorage' : 'node_aes_256_gcm',
          hydrated: false,
          lastSavedAt: null,
          lastError: null,
          vaultLocked: false,
          vaultError: null,
          recoveredFromBackup: false,
        };

        const loaded = await window.ipflixDesktop!.storage.loadState();
        if (loaded.ok && loaded.exists && loaded.state) {
          memState = normalizePersistedState(loaded.state as Partial<PersistedAppState>);
          const isVaultLocked = Boolean(loaded.vaultLocked);
          vaultLocked = isVaultLocked;
          const recovered = Boolean(loaded.recoveredFromBackup || loaded.vaultRecoveredFromBackup);
          diagnostics = {
            ...diagnostics,
            hydrated: true,
            lastSavedAt: memState.updatedAt || Date.now(),
            vaultLocked: isVaultLocked,
            vaultError: isVaultLocked
              ? loaded.vaultError ||
                'Şifreli kasa çözülemedi. Kayıtlı IPTV parolalarınız ve profil PIN kilitleriniz koruma altına alındı.'
              : null,
            lastError: isVaultLocked
              ? loaded.vaultError ||
                'Şifreli kasa çözülemedi. Kayıtlı IPTV parolalarınız ve profil PIN kilitleriniz koruma altına alındı.'
              : null,
            recoveredFromBackup: recovered,
          };
          const migratedSearches = isVaultLocked ? false : migrateLegacyRecentSearchesIntoState(memState);
          hydrated = true;
          writeNonSecretMetaMirror(memState);
          if (migratedSearches && !isVaultLocked) {
            await persistStateToDisk();
          }
          notifyListeners();
          return getPersistedStateSnapshot();
        }

        if (!loaded.ok && loaded.exists) {
          // Corrupt state file quarantined on disk — surface explicit error and lock writes!
          vaultLocked = true;
          const errMsg = loaded.error || 'Yerel depolama dosyası okunamadı.';
          diagnostics = {
            ...diagnostics,
            vaultLocked: true,
            vaultError: errMsg,
            lastError: errMsg,
          };
          hydrated = true;
          diagnostics.hydrated = true;
          notifyListeners();
          return getPersistedStateSnapshot();
        }

        // First launch on Electron v2: check if legacy browser localStorage has user data to migrate
        const legacy = readLegacyLocalStorageState();
        if (legacy) {
          vaultLocked = false;
          memState = legacy;
          hydrated = true;
          diagnostics.hydrated = true;
          await persistStateToDisk();
          scrubLegacyPlaintextLocalStorage();
          return getPersistedStateSnapshot();
        }
      } else {
        // Request persistent quota on Android APK/WebView, Android TV & desktop browsers so OS never evicts IndexedDB
        const persistentGranted = await requestPersistentBrowserStorage();
        // Warm IndexedDB handle & AES-256-GCM device key up front for instant encryption & unload flush
        const deviceKey = await getOrCreateBrowserDeviceKey();
        diagnostics = {
          backend: 'browser_indexeddb',
          storagePath: 'IndexedDB (ipflix_store_v1)',
          safeStorageEncrypted: Boolean(deviceKey),
          encryptionMode:
            deviceKey?.kind === 'webcrypto' ? 'webcrypto_aes_256_gcm' : 'aes_256_gcm',
          hydrated: false,
          persistentStorageGranted: persistentGranted,
          lastSavedAt: null,
          lastError: deviceKey ? null : 'Tarayıcı AES-256-GCM anahtarı başlatılamadı.',
          vaultLocked: false,
          vaultError: null,
          recoveredFromBackup: false,
        };

        const primaryEnv = await idbGet<BrowserEncryptedEnvelope>(
          STORE_APP_STATE,
          APP_STATE_RECORD_KEY
        );
        const backupEnv = await idbGet<BrowserEncryptedEnvelope>(
          STORE_APP_STATE,
          APP_STATE_BACKUP_KEY
        );

        const tryDecryptEnvelope = async (
          env: BrowserEncryptedEnvelope | null
        ): Promise<{ ok: boolean; secrets: SecretVaultBundle | null; expectedSecrets: boolean }> => {
          if (!env?.stateWithoutSecrets) {
            return { ok: false, secrets: null, expectedSecrets: false };
          }
          const hasCiphertext =
            typeof env.encryptedSecrets === 'string' && env.encryptedSecrets.trim().length > 0;
          const hasSecretMarkers =
            Boolean(env.stateWithoutSecrets.profiles?.some((p) => p.hasPin)) ||
            Boolean(
              env.stateWithoutSecrets.playlists?.some(
                (pl) => pl.hasEncryptedSecrets || pl.type === 'xtream' || pl.type === 'm3u_url'
              )
            );
          const expectedSecrets = hasCiphertext || hasSecretMarkers;

          if (!hasCiphertext) {
            return { ok: !hasSecretMarkers, secrets: null, expectedSecrets };
          }
          if (!deviceKey) {
            return { ok: false, secrets: null, expectedSecrets: true };
          }
          const decrypted = await decryptJsonWithDeviceKey<SecretVaultBundle>(
            deviceKey,
            env.encryptedSecrets
          );
          if (!decrypted) {
            return { ok: false, secrets: null, expectedSecrets: true };
          }
          return { ok: true, secrets: decrypted, expectedSecrets };
        };

        if (primaryEnv?.stateWithoutSecrets || backupEnv?.stateWithoutSecrets) {
          const primaryAttempt = await tryDecryptEnvelope(primaryEnv);
          if (primaryEnv?.stateWithoutSecrets && primaryAttempt.ok) {
            vaultLocked = false;
            memState = mergeSecretsIntoState(
              normalizePersistedState(primaryEnv.stateWithoutSecrets),
              primaryAttempt.secrets
            );
            const migratedSearches = migrateLegacyRecentSearchesIntoState(memState);
            hydrated = true;
            diagnostics.hydrated = true;
            diagnostics.lastSavedAt = memState.updatedAt || Date.now();
            writeNonSecretMetaMirror(memState);
            if (migratedSearches) {
              await persistStateToDisk();
            }
            notifyListeners();
            return getPersistedStateSnapshot();
          }

          // Primary missing or failed decryption — attempt IndexedDB backup recovery!
          const backupAttempt = await tryDecryptEnvelope(backupEnv);
          if (backupEnv?.stateWithoutSecrets && backupAttempt.ok) {
            vaultLocked = false;
            memState = mergeSecretsIntoState(
              normalizePersistedState(backupEnv.stateWithoutSecrets),
              backupAttempt.secrets
            );
            hydrated = true;
            diagnostics = {
              ...diagnostics,
              hydrated: true,
              recoveredFromBackup: true,
              lastSavedAt: memState.updatedAt || Date.now(),
              vaultLocked: false,
              vaultError: null,
              lastError: null,
            };
            // Restore healthy primary record from recovered backup
            await idbPut(STORE_APP_STATE, {
              ...backupEnv,
              id: APP_STATE_RECORD_KEY,
            });
            writeNonSecretMetaMirror(memState);
            notifyListeners();
            return getPersistedStateSnapshot();
          }

          // BOTH primary & backup failed vault decryption!
          // NEVER silently unlock PINs or overwrite encryptedSecrets with an empty vault!
          const fallbackEnvelope = primaryEnv?.stateWithoutSecrets ? primaryEnv : backupEnv!;
          const errMsg =
            'Şifreli yerel kasa çözülemedi (cihaz şifreleme anahtarı eksik veya kasa verisi bozulmuş). Kayıtlı IPTV parolalarınız ve profil PIN kilitleriniz koruma altına alındı; mevcut verilerinizin üzerine yazılmayacaktır.';
          vaultLocked = true;
          memState = normalizePersistedState(fallbackEnvelope.stateWithoutSecrets);
          hydrated = true;
          diagnostics = {
            ...diagnostics,
            hydrated: true,
            lastSavedAt: memState.updatedAt || Date.now(),
            vaultLocked: true,
            vaultError: errMsg,
            lastError: errMsg,
            recoveredFromBackup: false,
          };
          writeNonSecretMetaMirror(memState);
          notifyListeners();
          return getPersistedStateSnapshot();
        }

        // One-time migration from legacy v1 localStorage into encrypted IndexedDB store
        const legacy = readLegacyLocalStorageState();
        if (legacy) {
          vaultLocked = false;
          memState = legacy;
          hydrated = true;
          diagnostics.hydrated = true;
          await persistStateToDisk();
          scrubLegacyPlaintextLocalStorage();
          return getPersistedStateSnapshot();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[IPFLIX Storage] Hydration error:', msg);
      diagnostics.lastError = msg;
    }

    // Brand-new installation: initialize clean defaults in memory (do NOT clobber anything on disk!)
    const initialProfile = createDefaultProfile('Ana Profil');
    const guestProfile = createGuestProfile(loadBootLanguageHint());
    memState = normalizePersistedState({
      ...createEmptyPersistedState(),
      updatedAt: Date.now(),
      profiles: [initialProfile, guestProfile],
      activeProfileId: initialProfile.id,
      profileData: {
        [initialProfile.id]: normalizeProfileData(EMPTY_PROFILE_DATA),
        [guestProfile.id]: normalizeProfileData(EMPTY_PROFILE_DATA),
      },
    });
    migrateLegacyRecentSearchesIntoState(memState);
    hydrated = true;
    diagnostics.hydrated = true;
    notifyListeners();
    return getPersistedStateSnapshot();
  })();

  return hydratePromise;
}

/**
 * Re-attempts reading & decrypting the local encrypted vault (e.g. after transient OS keyring
 * lock or restoring a backup file) without modifying any stored files.
 */
export async function retryVaultRecovery(): Promise<PersistedAppState> {
  hydrated = false;
  hydratePromise = null;
  cachedDeviceKey = null;
  return hydratePersistentStorage();
}

/**
 * User-confirmed safe vault recovery: quarantines the unreadable encrypted vault copy so nothing
 * is permanently destroyed, initializes a fresh encrypted vault, and clears stale PIN/secret lock
 * markers while PRESERVING all profiles, favorites, watchlist, watch history, recent channels,
 * recent searches, IPTV server metadata, and settings.
 */
export async function resetLockedVaultSafely(): Promise<PersistedAppState> {
  if (isElectronStorageAvailable() && window.ipflixDesktop?.storage.resetLockedVault) {
    const res = await window.ipflixDesktop.storage.resetLockedVault();
    if (!res.ok) {
      throw new Error(res.error || 'Kasa kurtarma işlemi başarısız oldu.');
    }
    vaultLocked = false;
    if (res.state) {
      memState = normalizePersistedState(res.state as Partial<PersistedAppState>);
    } else {
      memState = normalizePersistedState({
        ...memState,
        updatedAt: Date.now(),
        playlists: memState.playlists.map((pl) => {
          const copy = { ...pl };
          delete copy.password;
          delete copy.m3uUrl;
          delete copy.epgUrl;
          delete copy.hasEncryptedSecrets;
          return copy;
        }),
        profiles: memState.profiles.map((prof) => ({
          ...prof,
          pin: undefined,
          hasPin: false,
        })),
      });
    }
    diagnostics = {
      ...diagnostics,
      hydrated: true,
      vaultLocked: false,
      vaultError: null,
      lastError: null,
      lastSavedAt: Date.now(),
    };
    hydrated = true;
    dirtyRevision = 0;
    persistedRevision = 0;
    notifyListeners();
    return getPersistedStateSnapshot();
  }

  // Browser / Android LAN HTTP recovery: quarantine unreadable records in IndexedDB first
  const stamp = Date.now();
  try {
    const primaryEnv = await idbGet<BrowserEncryptedEnvelope>(STORE_APP_STATE, APP_STATE_RECORD_KEY);
    if (primaryEnv) {
      await idbPut(STORE_APP_STATE, {
        ...primaryEnv,
        id: `${APP_STATE_QUARANTINE_PREFIX}${stamp}`,
      });
    }
    const backupEnv = await idbGet<BrowserEncryptedEnvelope>(STORE_APP_STATE, APP_STATE_BACKUP_KEY);
    if (backupEnv) {
      await idbPut(STORE_APP_STATE, {
        ...backupEnv,
        id: `${APP_STATE_QUARANTINE_PREFIX}${stamp}_bak`,
      });
    }
  } catch {
    // Best-effort quarantine
  }

  vaultLocked = false;
  memState = normalizePersistedState({
    ...memState,
    updatedAt: stamp,
    playlists: memState.playlists.map((pl) => {
      const copy = { ...pl };
      delete copy.password;
      delete copy.m3uUrl;
      delete copy.epgUrl;
      delete copy.hasEncryptedSecrets;
      return copy;
    }),
    profiles: memState.profiles.map((prof) => ({
      ...prof,
      pin: undefined,
      hasPin: false,
    })),
  });
  diagnostics = {
    ...diagnostics,
    hydrated: true,
    vaultLocked: false,
    vaultError: null,
    lastError: null,
  };
  hydrated = true;
  await persistStateToDisk();
  notifyListeners();
  return getPersistedStateSnapshot();
}

// ============================================================================
// Catalog Cache (Electron userData/catalogs/*.json OR Browser IndexedDB)
// ============================================================================
export async function saveCatalog(catalog: PlaylistCatalog): Promise<void> {
  if (isElectronStorageAvailable()) {
    const res = await window.ipflixDesktop!.storage.saveCatalog(catalog.playlistId, catalog);
    if (!res.ok) {
      console.error('[IPFLIX Storage] Failed to save desktop catalog:', res.error);
    }
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CATALOGS, 'readwrite');
      tx.objectStore(STORE_CATALOGS).put(catalog);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    if (!isElectronStorageAvailable()) {
      throw err;
    }
  }
}

export async function loadCatalog(playlistId: string): Promise<PlaylistCatalog | null> {
  if (isElectronStorageAvailable()) {
    try {
      const fromDisk = (await window.ipflixDesktop!.storage.loadCatalog(
        playlistId
      )) as PlaylistCatalog | null;
      if (fromDisk && fromDisk.playlistId) return fromDisk;
    } catch {
      // fall through to IndexedDB check for seamless upgrade from older Electron builds
    }
  }

  const fromIdb = await idbGet<PlaylistCatalog>(STORE_CATALOGS, playlistId);
  if (fromIdb && isElectronStorageAvailable()) {
    // Opportunistically persist into userData/catalogs so future port changes stay instant
    void window.ipflixDesktop!.storage.saveCatalog(playlistId, fromIdb);
  }
  return fromIdb;
}

export async function deleteCatalog(playlistId: string): Promise<void> {
  if (isElectronStorageAvailable()) {
    await window.ipflixDesktop!.storage.deleteCatalog(playlistId).catch(() => {});
  }
  await idbDelete(STORE_CATALOGS, playlistId);
}

// ============================================================================
// Synchronous State Accessors (Backed by Hydrated In-Memory Store + Atomic Disk Save)
// ============================================================================
export function loadBootLanguageHint(): AppSettings['language'] {
  try {
    const mirror = readLegacyLocalStorageJson<{ language?: string } | null>(LS_MIRROR_META, null);
    if (mirror?.language === 'en') return 'en';
    if (mirror?.language === 'tr') return 'tr';
    const legacy = readLegacyLocalStorageJson<{ language?: string } | null>(LS_SETTINGS, null);
    if (legacy?.language === 'en') return 'en';
  } catch {
    // ignore
  }
  return 'tr';
}

export function loadPlaylists(): PlaylistSource[] {
  return structuredClone(memState.playlists);
}

export function savePlaylists(playlists: PlaylistSource[]): void {
  const now = Date.now();
  const nextIds = new Set(playlists.map((p) => p.id));
  const deletedPlaylists = { ...memState.deletedPlaylists };

  for (const prev of memState.playlists) {
    if (prev.type !== 'demo' && !nextIds.has(prev.id)) {
      deletedPlaylists[prev.id] = now;
    }
  }
  for (const pl of playlists) {
    if (pl.id in deletedPlaylists) {
      delete deletedPlaylists[pl.id];
    }
  }

  memState = {
    ...memState,
    updatedAt: now,
    playlists: structuredClone(playlists),
    deletedPlaylists,
  };
  void persistStateToDisk();
}

export function loadActivePlaylistId(): string | null {
  return memState.activePlaylistId;
}

export function saveActivePlaylistId(id: string | null): void {
  if (memState.activePlaylistId === id && hydrated) return;
  memState = {
    ...memState,
    updatedAt: Date.now(),
    activePlaylistId: id,
  };
  void persistStateToDisk();
}

export function loadSettings(): AppSettings {
  if (!hydrated) {
    return normalizeSettings({ language: loadBootLanguageHint() });
  }
  return structuredClone(memState.settings);
}

export function saveSettings(settings: AppSettings): void {
  const now = Date.now();
  memState = {
    ...memState,
    updatedAt: now,
    settings: normalizeSettings(settings),
    settingsUpdatedAt: now,
  };
  void persistStateToDisk();
}

export function loadOnboardingCompleted(): boolean {
  if (memState.onboardingCompleted) return true;
  return memState.playlists.some((p) => p.type !== 'demo');
}

export function saveOnboardingCompleted(done: boolean): void {
  memState = {
    ...memState,
    updatedAt: Date.now(),
    onboardingCompleted: done,
  };
  void persistStateToDisk();
}

export function createDefaultProfile(name = 'Ana Profil'): UserProfile {
  const now = Date.now();
  return {
    id: DEFAULT_PROFILE_ID,
    name,
    avatarId: 'crimson',
    isKids: false,
    isGuest: false,
    hasPin: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function createGuestProfile(lang: AppSettings['language'] = 'tr'): UserProfile {
  const now = Date.now();
  return {
    id: GUEST_PROFILE_ID,
    name: lang === 'en' ? 'Guest' : 'Misafir',
    avatarId: 'teal',
    isKids: false,
    isGuest: true,
    hasPin: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function ensureGuestProfile(
  profiles: UserProfile[],
  lang: AppSettings['language'] = 'tr'
): { profiles: UserProfile[]; added: boolean } {
  if (profiles.some((p) => p.id === GUEST_PROFILE_ID || p.isGuest)) {
    return { profiles, added: false };
  }
  return {
    profiles: [...profiles, createGuestProfile(lang)],
    added: true,
  };
}

function normalizeServerEndpoint(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizePlaylistUrl(raw?: string): string {
  if (!raw) return '';
  return raw.trim().replace(/#.*$/, '');
}

/**
 * Matches an incoming IPTV login attempt against existing saved sources so signing out and
 * logging back into the SAME Xtream Codes / M3U account preserves the original `source.id`
 * and keeps all per-profile favorites & watch history seamlessly linked.
 */
export function findMatchingPlaylistId(
  playlists: PlaylistSource[],
  candidate: {
    type: PlaylistSource['type'];
    serverUrl?: string;
    resolvedServerUrl?: string;
    username?: string;
    m3uUrl?: string;
  }
): string | null {
  if (candidate.type === 'xtream') {
    const targetUser = (candidate.username || '').trim().toLowerCase();
    const targetHosts = new Set(
      [candidate.serverUrl, candidate.resolvedServerUrl]
        .map(normalizeServerEndpoint)
        .filter(Boolean)
    );
    if (!targetUser || targetHosts.size === 0) return null;
    const matched = playlists.find((pl) => {
      if (pl.type !== 'xtream' && !(pl.serverUrl && pl.username)) return false;
      const plUser = (pl.username || '').trim().toLowerCase();
      if (plUser !== targetUser) return false;
      const plHost1 = normalizeServerEndpoint(pl.serverUrl);
      const plHost2 = normalizeServerEndpoint(pl.resolvedServerUrl);
      return targetHosts.has(plHost1) || targetHosts.has(plHost2);
    });
    return matched?.id || null;
  }

  if (candidate.type === 'm3u_url') {
    const targetUrl = normalizePlaylistUrl(candidate.m3uUrl);
    if (!targetUrl) return null;
    const matched = playlists.find(
      (pl) => pl.type === 'm3u_url' && normalizePlaylistUrl(pl.m3uUrl) === targetUrl
    );
    return matched?.id || null;
  }

  return null;
}

export function loadProfiles(): UserProfile[] {
  if (memState.profiles.length > 0) {
    return structuredClone(memState.profiles);
  }
  const initial = [
    createDefaultProfile('Ana Profil'),
    createGuestProfile(memState.settings.language),
  ];
  memState = {
    ...memState,
    profiles: initial,
  };
  return structuredClone(initial);
}

export function saveProfiles(profiles: UserProfile[]): void {
  const now = Date.now();
  const nextIds = new Set(profiles.map((p) => p.id));
  const deletedProfiles = { ...memState.deletedProfiles };

  for (const prev of memState.profiles) {
    if (!nextIds.has(prev.id)) {
      deletedProfiles[prev.id] = now;
    }
  }
  for (const prof of profiles) {
    if (prof.id in deletedProfiles) {
      delete deletedProfiles[prof.id];
    }
  }

  const stamped = profiles.map((p) => ({
    ...p,
    isGuest: Boolean(p.isGuest) || p.id === GUEST_PROFILE_ID,
    hasPin: Boolean(p.pin && p.pin.length === 4) || (vaultLocked && Boolean(p.hasPin)),
    updatedAt: p.updatedAt || now,
  }));

  memState = {
    ...memState,
    updatedAt: now,
    profiles: structuredClone(stamped),
    deletedProfiles,
  };
  void persistStateToDisk();
}

export function loadActiveProfileId(): string | null {
  return memState.activeProfileId;
}

export function saveActiveProfileId(id: string | null): void {
  if (memState.activeProfileId === id && hydrated) return;
  memState = {
    ...memState,
    updatedAt: Date.now(),
    activeProfileId: id,
  };
  void persistStateToDisk();
}

export function loadProfileData(profileId: string): ProfileData {
  const existing = memState.profileData[profileId];
  return normalizeProfileData(existing);
}

function updateListTimestamps(
  prev: ProfileData,
  next: ProfileData,
  now: number
): Record<string, number> {
  const stamps: Record<string, number> = {
    ...(prev.listTimestamps || {}),
    ...(next.listTimestamps || {}),
  };

  const diffList = (listType: ProfileListType, prevItems: string[], nextItems: string[]) => {
    const prevSet = new Set(prevItems);
    const nextSet = new Set(nextItems);
    for (const item of nextItems) {
      if (!prevSet.has(item)) {
        stamps[`${listType}:${item}`] = now;
      }
    }
    for (const item of prevItems) {
      if (!nextSet.has(item)) {
        stamps[`${listType}:${item}`] = now;
      }
    }
    // For recent_channel, update the head channel timestamp even when re-tuned
    if (listType === 'recent_channel' && nextItems[0] && nextItems[0] !== prevItems[0]) {
      stamps[`recent_channel:${nextItems[0]}`] = now;
    }
  };

  diffList('favorite', prev.favorites, next.favorites);
  diffList('watchlist', prev.watchlist || [], next.watchlist || []);
  diffList('recent_channel', prev.recentChannels, next.recentChannels);
  diffList('hidden_channel', prev.hiddenChannels, next.hiddenChannels);

  return stamps;
}

export function saveProfileData(profileId: string, data: ProfileData): void {
  if (!profileId) return;
  const now = Date.now();
  const prev = normalizeProfileData(memState.profileData[profileId]);
  const normalizedNext = normalizeProfileData(data);
  normalizedNext.listTimestamps = updateListTimestamps(prev, normalizedNext, now);

  memState = {
    ...memState,
    updatedAt: now,
    profileData: {
      ...memState.profileData,
      [profileId]: normalizedNext,
    },
  };
  void persistStateToDisk();
}

export function deleteProfileData(profileId: string): void {
  if (!profileId || !(profileId in memState.profileData)) return;
  const nextMap = { ...memState.profileData };
  delete nextMap[profileId];
  memState = {
    ...memState,
    updatedAt: Date.now(),
    profileData: nextMap,
    deletedProfiles: {
      ...memState.deletedProfiles,
      [profileId]: Date.now(),
    },
  };
  void persistStateToDisk();
}

export function loadNotifications(): AppNotification[] {
  return structuredClone(memState.notifications);
}

export function saveNotifications(items: AppNotification[]): void {
  memState = {
    ...memState,
    updatedAt: Date.now(),
    notifications: structuredClone(items.slice(0, 30)),
  };
  void persistStateToDisk();
}

export async function clearAllUserData(): Promise<void> {
  scrubLegacyPlaintextLocalStorage();
  try {
    localStorage.removeItem(LS_MIRROR_META);
  } catch {
    // ignore
  }

  if (isElectronStorageAvailable()) {
    await window.ipflixDesktop!.storage.clearAllData();
  }

  cachedDeviceKey = null;
  vaultLocked = false;
  diagnostics = {
    ...diagnostics,
    vaultLocked: false,
    vaultError: null,
    lastError: null,
    recoveredFromBackup: false,
  };

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_CATALOGS, STORE_APP_STATE, STORE_CRYPTO_KEYS], 'readwrite');
      tx.objectStore(STORE_CATALOGS).clear();
      tx.objectStore(STORE_APP_STATE).clear();
      tx.objectStore(STORE_CRYPTO_KEYS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }

  const freshProfile = createDefaultProfile('Ana Profil');
  const guestProfile = createGuestProfile('tr');
  memState = normalizePersistedState({
    ...createEmptyPersistedState(),
    updatedAt: Date.now(),
    profiles: [freshProfile, guestProfile],
    activeProfileId: freshProfile.id,
    profileData: {
      [freshProfile.id]: normalizeProfileData(EMPTY_PROFILE_DATA),
      [guestProfile.id]: normalizeProfileData(EMPTY_PROFILE_DATA),
    },
  });
  hydrated = true;
  dirtyRevision = 0;
  persistedRevision = 0;
  notifyListeners();
}

export { EMPTY_PROFILE_DATA };
