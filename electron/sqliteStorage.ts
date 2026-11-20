import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

function loadNodeSqlite(): NodeSqliteModule | null {
  try {
    const req =
      typeof require === 'function'
        ? require
        : createRequire(path.join(process.cwd(), 'package.json'));
    const mod = req('node:sqlite') as NodeSqliteModule;
    if (mod && typeof mod.DatabaseSync === 'function') {
      return mod;
    }
  } catch {
    // Fallback if runtime lacks built-in node:sqlite
  }
  return null;
}

export const SQLITE_SCHEMA_VERSION = 2;

export interface SqliteUpdateCacheRow {
  repo: string;
  etag: string | null;
  payloadJson: string;
  checkedAt: number;
}

/**
 * Parameterized, transactional SQLite persistence layer backed by `userData/ipflix-data/ipflix.db`.
 *
 * Security & durability guarantees:
 * - Uses WAL journaling + `BEGIN IMMEDIATE ... COMMIT` transactions so abrupt closures or
 *   power loss never corrupt user profiles, favorites, watch progress, or settings.
 * - Uses schema migrations (`schema_migrations`) so future app updates upgrade in-place
 *   without resetting or wiping existing records.
 * - Never stores plaintext IPTV passwords, M3U/EPG secret URLs, or 4-digit Profile PINs
 *   (those remain encrypted in DPAPI / AES-256-GCM `vault.bin`).
 */
export class IpflixSqliteStore {
  readonly dbPath: string;
  private db: SqliteDatabase | null = null;
  private available = false;

  constructor(storeDir: string) {
    this.dbPath = path.join(storeDir, 'ipflix.db');
  }

  init(): boolean {
    if (this.db) return this.available;
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      this.available = false;
      return false;
    }

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');

    this.runMigrations(db);
    this.db = db;
    this.available = true;
    return true;
  }

  isAvailable(): boolean {
    if (!this.db) {
      return this.init();
    }
    return this.available;
  }

  private runMigrations(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL
      );
    `);

    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
    const applied = new Set<number>(
      appliedRows.map((r) => Number(r.version)).filter((n) => Number.isFinite(n))
    );

    if (!applied.has(1)) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json_data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar_id TEXT NOT NULL,
            is_kids INTEGER NOT NULL DEFAULT 0,
            is_guest INTEGER NOT NULL DEFAULT 0,
            has_pin INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
          );

          CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            server_url TEXT,
            resolved_server_url TEXT,
            username TEXT,
            account_info_json TEXT,
            has_encrypted_secrets INTEGER NOT NULL DEFAULT 0,
            user_agent TEXT,
            live_format TEXT,
            channel_count INTEGER NOT NULL DEFAULT 0,
            movie_count INTEGER NOT NULL DEFAULT 0,
            series_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
          );

          CREATE TABLE IF NOT EXISTS profile_state (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
            last_live_channel_id TEXT,
            last_live_category TEXT,
            recent_searches_json TEXT NOT NULL DEFAULT '[]',
            list_timestamps_json TEXT NOT NULL DEFAULT '{}',
            cleared_history_at INTEGER
          );

          CREATE TABLE IF NOT EXISTS profile_favorites (
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            list_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (profile_id, list_type, item_id)
          );

          CREATE TABLE IF NOT EXISTS watch_progress (
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL,
            content_type TEXT NOT NULL,
            title TEXT NOT NULL,
            subtitle TEXT,
            poster TEXT,
            backdrop TEXT,
            position_sec REAL NOT NULL DEFAULT 0,
            duration_sec REAL NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            completed_at INTEGER,
            updated_at INTEGER NOT NULL,
            series_id TEXT,
            season_number INTEGER,
            episode_number INTEGER,
            episode_id TEXT,
            PRIMARY KEY (profile_id, item_id)
          );

          CREATE INDEX IF NOT EXISTS idx_watch_progress_profile_updated
            ON watch_progress (profile_id, updated_at DESC);

          CREATE INDEX IF NOT EXISTS idx_profile_favorites_lookup
            ON profile_favorites (profile_id, list_type, position ASC);

          CREATE TABLE IF NOT EXISTS tombstones (
            kind TEXT NOT NULL,
            target_id TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            PRIMARY KEY (kind, target_id)
          );

          CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            level TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            read INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0
          );
        `);

        db.prepare(
          'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
        ).run(1, Date.now(), 'Initial relational schema for profiles, playlists, favorites, and watch progress');
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }

    if (!applied.has(2)) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS update_cache (
            repo TEXT PRIMARY KEY,
            etag TEXT,
            payload_json TEXT NOT NULL,
            checked_at INTEGER NOT NULL
          );
        `);
        db.prepare(
          'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
        ).run(2, Date.now(), 'Persistent GitHub Releases update & ETag cache table');
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  hasPersistedState(): boolean {
    if (!this.isAvailable() || !this.db) return false;
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'updatedAt'").get();
    if (row) return true;
    const profileCount = this.db.prepare('SELECT COUNT(*) AS cnt FROM profiles').get();
    return Number(profileCount?.cnt || 0) > 0;
  }

  getAppliedSchemaVersion(): number {
    if (!this.isAvailable() || !this.db) return 0;
    const row = this.db.prepare('SELECT MAX(version) AS ver FROM schema_migrations').get();
    return Number(row?.ver || 0);
  }

  loadState(): Record<string, unknown> | null {
    if (!this.isAvailable() || !this.db) return null;
    if (!this.hasPersistedState()) return null;

    const metaRows = this.db.prepare('SELECT key, value FROM app_meta').all();
    const meta = new Map<string, string>();
    for (const r of metaRows) {
      meta.set(String(r.key), String(r.value));
    }

    const settingsRow = this.db
      .prepare('SELECT json_data, updated_at FROM app_settings WHERE id = 1')
      .get();
    let settings: Record<string, unknown> = {};
    if (settingsRow && typeof settingsRow.json_data === 'string') {
      try {
        settings = JSON.parse(settingsRow.json_data) as Record<string, unknown>;
      } catch {
        settings = {};
      }
    }

    const playlistRows = this.db
      .prepare('SELECT * FROM playlists ORDER BY sort_order ASC, created_at ASC')
      .all();
    const playlists = playlistRows.map((row) => {
      let accountInfo: unknown;
      if (typeof row.account_info_json === 'string' && row.account_info_json) {
        try {
          accountInfo = JSON.parse(row.account_info_json);
        } catch {
          accountInfo = undefined;
        }
      }
      return {
        id: String(row.id),
        name: String(row.name),
        type: String(row.type),
        isDefault: Number(row.is_default) === 1,
        ...(row.server_url ? { serverUrl: String(row.server_url) } : {}),
        ...(row.resolved_server_url ? { resolvedServerUrl: String(row.resolved_server_url) } : {}),
        ...(row.username ? { username: String(row.username) } : {}),
        ...(accountInfo ? { accountInfo } : {}),
        ...(Number(row.has_encrypted_secrets) === 1 ? { hasEncryptedSecrets: true } : {}),
        ...(row.user_agent ? { userAgent: String(row.user_agent) } : {}),
        ...(row.live_format ? { liveFormat: String(row.live_format) } : {}),
        channelCount: Number(row.channel_count || 0),
        movieCount: Number(row.movie_count || 0),
        seriesCount: Number(row.series_count || 0),
        createdAt: Number(row.created_at || Date.now()),
        updatedAt: Number(row.updated_at || Date.now()),
      };
    });

    const profileRows = this.db
      .prepare('SELECT * FROM profiles ORDER BY sort_order ASC, created_at ASC')
      .all();
    const profiles = profileRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      avatarId: String(row.avatar_id),
      isKids: Number(row.is_kids) === 1,
      isGuest: Number(row.is_guest) === 1,
      hasPin: Number(row.has_pin) === 1,
      createdAt: Number(row.created_at || Date.now()),
      updatedAt: Number(row.updated_at || Date.now()),
    }));

    const profileData: Record<string, Record<string, unknown>> = {};
    for (const prof of profiles) {
      profileData[prof.id] = {
        favorites: [] as string[],
        watchlist: [] as string[],
        watchProgress: {} as Record<string, unknown>,
        recentChannels: [] as string[],
        hiddenChannels: [] as string[],
        recentSearches: [] as string[],
        listTimestamps: {} as Record<string, number>,
      };
    }

    const profileStateRows = this.db.prepare('SELECT * FROM profile_state').all();
    for (const row of profileStateRows) {
      const pid = String(row.profile_id);
      if (!profileData[pid]) continue;
      if (row.last_live_channel_id) {
        profileData[pid].lastLiveChannelId = String(row.last_live_channel_id);
      }
      if (row.last_live_category) {
        profileData[pid].lastLiveCategory = String(row.last_live_category);
      }
      if (typeof row.recent_searches_json === 'string') {
        try {
          profileData[pid].recentSearches = JSON.parse(row.recent_searches_json);
        } catch {
          profileData[pid].recentSearches = [];
        }
      }
      if (typeof row.list_timestamps_json === 'string') {
        try {
          profileData[pid].listTimestamps = JSON.parse(row.list_timestamps_json);
        } catch {
          profileData[pid].listTimestamps = {};
        }
      }
      if (row.cleared_history_at !== null && row.cleared_history_at !== undefined) {
        profileData[pid].clearedHistoryAt = Number(row.cleared_history_at);
      }
    }

    const listRows = this.db
      .prepare('SELECT * FROM profile_favorites ORDER BY profile_id ASC, list_type ASC, position ASC')
      .all();
    for (const row of listRows) {
      const pid = String(row.profile_id);
      const bucket = profileData[pid];
      if (!bucket) continue;
      const listType = String(row.list_type);
      const itemId = String(row.item_id);
      if (listType === 'favorite') (bucket.favorites as string[]).push(itemId);
      else if (listType === 'watchlist') (bucket.watchlist as string[]).push(itemId);
      else if (listType === 'recent_channel') (bucket.recentChannels as string[]).push(itemId);
      else if (listType === 'hidden_channel') (bucket.hiddenChannels as string[]).push(itemId);
    }

    const progressRows = this.db.prepare('SELECT * FROM watch_progress').all();
    for (const row of progressRows) {
      const pid = String(row.profile_id);
      const bucket = profileData[pid];
      if (!bucket) continue;
      const wpMap = bucket.watchProgress as Record<string, unknown>;
      const itemId = String(row.item_id);
      wpMap[itemId] = {
        itemId,
        type: String(row.content_type),
        title: String(row.title || ''),
        ...(row.subtitle ? { subtitle: String(row.subtitle) } : {}),
        ...(row.poster ? { poster: String(row.poster) } : {}),
        ...(row.backdrop ? { backdrop: String(row.backdrop) } : {}),
        position: Number(row.position_sec || 0),
        duration: Number(row.duration_sec || 0),
        completed: Number(row.completed) === 1,
        ...(row.completed_at !== null && row.completed_at !== undefined
          ? { completedAt: Number(row.completed_at) }
          : {}),
        updatedAt: Number(row.updated_at || Date.now()),
        ...(row.series_id ? { seriesId: String(row.series_id) } : {}),
        ...(row.season_number !== null && row.season_number !== undefined
          ? { seasonNumber: Number(row.season_number) }
          : {}),
        ...(row.episode_number !== null && row.episode_number !== undefined
          ? { episodeNumber: Number(row.episode_number) }
          : {}),
        ...(row.episode_id ? { episodeId: String(row.episode_id) } : {}),
      };
    }

    const tombstoneRows = this.db.prepare('SELECT * FROM tombstones').all();
    const deletedPlaylists: Record<string, number> = {};
    const deletedProfiles: Record<string, number> = {};
    for (const row of tombstoneRows) {
      const kind = String(row.kind);
      const id = String(row.target_id);
      const ts = Number(row.deleted_at || 0);
      if (kind === 'playlist') deletedPlaylists[id] = ts;
      else if (kind === 'profile') deletedProfiles[id] = ts;
    }

    const notifRows = this.db
      .prepare('SELECT * FROM notifications ORDER BY sort_order ASC, timestamp DESC')
      .all();
    const notifications = notifRows.map((row) => ({
      id: String(row.id),
      title: String(row.title || ''),
      message: String(row.message || ''),
      level: String(row.level || 'info'),
      timestamp: Number(row.timestamp || 0),
      read: Number(row.read) === 1,
    }));

    return {
      schemaVersion: Number(meta.get('schemaVersion') || 3),
      updatedAt: Number(meta.get('updatedAt') || Date.now()),
      onboardingCompleted: meta.get('onboardingCompleted') === '1',
      activePlaylistId: meta.get('activePlaylistId') || null,
      activeProfileId: meta.get('activeProfileId') || null,
      settings,
      settingsUpdatedAt: Number(meta.get('settingsUpdatedAt') || settingsRow?.updated_at || 0),
      playlists,
      deletedPlaylists,
      profiles,
      deletedProfiles,
      profileData,
      notifications,
    };
  }

  saveState(sanitizedState: Record<string, unknown>): void {
    if (!this.isAvailable() || !this.db) return;
    const db = this.db;
    const now = Date.now();

    db.exec('BEGIN IMMEDIATE;');
    try {
      const metaStmt = db.prepare(
        'INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)'
      );
      metaStmt.run('schemaVersion', String(sanitizedState.schemaVersion ?? 3));
      metaStmt.run('updatedAt', String(sanitizedState.updatedAt ?? now));
      metaStmt.run('onboardingCompleted', sanitizedState.onboardingCompleted ? '1' : '0');
      metaStmt.run(
        'activePlaylistId',
        typeof sanitizedState.activePlaylistId === 'string' ? sanitizedState.activePlaylistId : ''
      );
      metaStmt.run(
        'activeProfileId',
        typeof sanitizedState.activeProfileId === 'string' ? sanitizedState.activeProfileId : ''
      );
      metaStmt.run('settingsUpdatedAt', String(sanitizedState.settingsUpdatedAt ?? now));

      db.prepare(
        'INSERT OR REPLACE INTO app_settings (id, json_data, updated_at) VALUES (1, ?, ?)'
      ).run(
        JSON.stringify(sanitizedState.settings || {}),
        Number(sanitizedState.settingsUpdatedAt || now)
      );

      // Clear & re-populate normalized collections cleanly inside the single atomic transaction
      db.exec('DELETE FROM profile_favorites;');
      db.exec('DELETE FROM watch_progress;');
      db.exec('DELETE FROM profile_state;');
      db.exec('DELETE FROM profiles;');
      db.exec('DELETE FROM playlists;');
      db.exec('DELETE FROM tombstones;');
      db.exec('DELETE FROM notifications;');

      const insertPlaylist = db.prepare(`
        INSERT INTO playlists (
          id, name, type, is_default, server_url, resolved_server_url, username,
          account_info_json, has_encrypted_secrets, user_agent, live_format,
          channel_count, movie_count, series_count, created_at, updated_at, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const playlists = Array.isArray(sanitizedState.playlists)
        ? (sanitizedState.playlists as Array<Record<string, unknown>>)
        : [];
      playlists.forEach((pl, idx) => {
        if (!pl || typeof pl.id !== 'string') return;
        insertPlaylist.run(
          pl.id,
          String(pl.name || 'IPTV'),
          String(pl.type || 'xtream'),
          pl.isDefault ? 1 : 0,
          typeof pl.serverUrl === 'string' ? pl.serverUrl : null,
          typeof pl.resolvedServerUrl === 'string' ? pl.resolvedServerUrl : null,
          typeof pl.username === 'string' ? pl.username : null,
          pl.accountInfo ? JSON.stringify(pl.accountInfo) : null,
          pl.hasEncryptedSecrets ? 1 : 0,
          typeof pl.userAgent === 'string' ? pl.userAgent : null,
          typeof pl.liveFormat === 'string' ? pl.liveFormat : null,
          Number(pl.channelCount || 0),
          Number(pl.movieCount || 0),
          Number(pl.seriesCount || 0),
          Number(pl.createdAt || now),
          Number(pl.updatedAt || now),
          idx
        );
      });

      const insertProfile = db.prepare(`
        INSERT INTO profiles (
          id, name, avatar_id, is_kids, is_guest, has_pin, created_at, updated_at, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const profiles = Array.isArray(sanitizedState.profiles)
        ? (sanitizedState.profiles as Array<Record<string, unknown>>)
        : [];
      const validProfileIds = new Set<string>();
      profiles.forEach((prof, idx) => {
        if (!prof || typeof prof.id !== 'string') return;
        validProfileIds.add(prof.id);
        insertProfile.run(
          prof.id,
          String(prof.name || 'Profil'),
          String(prof.avatarId || 'crimson'),
          prof.isKids ? 1 : 0,
          prof.isGuest ? 1 : 0,
          prof.hasPin ? 1 : 0,
          Number(prof.createdAt || now),
          Number(prof.updatedAt || now),
          idx
        );
      });

      const insertProfileState = db.prepare(`
        INSERT INTO profile_state (
          profile_id, last_live_channel_id, last_live_category, recent_searches_json, list_timestamps_json, cleared_history_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertFavorite = db.prepare(`
        INSERT OR IGNORE INTO profile_favorites (
          profile_id, list_type, item_id, position, added_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const insertProgress = db.prepare(`
        INSERT OR REPLACE INTO watch_progress (
          profile_id, item_id, content_type, title, subtitle, poster, backdrop,
          position_sec, duration_sec, completed, completed_at, updated_at,
          series_id, season_number, episode_number, episode_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const profileDataMap =
        sanitizedState.profileData && typeof sanitizedState.profileData === 'object'
          ? (sanitizedState.profileData as Record<string, Record<string, unknown>>)
          : {};

      for (const [pid, pdata] of Object.entries(profileDataMap)) {
        if (!validProfileIds.has(pid) || !pdata || typeof pdata !== 'object') continue;
        const listTimestamps =
          pdata.listTimestamps && typeof pdata.listTimestamps === 'object'
            ? (pdata.listTimestamps as Record<string, number>)
            : {};

        insertProfileState.run(
          pid,
          typeof pdata.lastLiveChannelId === 'string' ? pdata.lastLiveChannelId : null,
          typeof pdata.lastLiveCategory === 'string' ? pdata.lastLiveCategory : null,
          JSON.stringify(Array.isArray(pdata.recentSearches) ? pdata.recentSearches : []),
          JSON.stringify(listTimestamps),
          typeof pdata.clearedHistoryAt === 'number' ? pdata.clearedHistoryAt : null
        );

        const pushList = (listType: string, rawArr: unknown) => {
          if (!Array.isArray(rawArr)) return;
          rawArr.forEach((rawId, idx) => {
            if (typeof rawId !== 'string' || !rawId.trim()) return;
            const addedAt = Number(listTimestamps[`${listType}:${rawId}`] || now);
            insertFavorite.run(pid, listType, rawId, idx, addedAt);
          });
        };
        pushList('favorite', pdata.favorites);
        pushList('watchlist', pdata.watchlist);
        pushList('recent_channel', pdata.recentChannels);
        pushList('hidden_channel', pdata.hiddenChannels);

        const wpMap =
          pdata.watchProgress && typeof pdata.watchProgress === 'object'
            ? (pdata.watchProgress as Record<string, Record<string, unknown>>)
            : {};
        for (const [key, entry] of Object.entries(wpMap)) {
          if (!entry || typeof entry !== 'object') continue;
          const itemId = typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : key;
          insertProgress.run(
            pid,
            itemId,
            String(entry.type || 'movie'),
            String(entry.title || ''),
            typeof entry.subtitle === 'string' ? entry.subtitle : null,
            typeof entry.poster === 'string' ? entry.poster : null,
            typeof entry.backdrop === 'string' ? entry.backdrop : null,
            Number(entry.position || 0),
            Number(entry.duration || 0),
            entry.completed ? 1 : 0,
            typeof entry.completedAt === 'number' ? entry.completedAt : null,
            Number(entry.updatedAt || now),
            typeof entry.seriesId === 'string' ? entry.seriesId : null,
            typeof entry.seasonNumber === 'number' ? entry.seasonNumber : null,
            typeof entry.episodeNumber === 'number' ? entry.episodeNumber : null,
            typeof entry.episodeId === 'string' ? entry.episodeId : null
          );
        }
      }

      const insertTombstone = db.prepare(
        'INSERT OR REPLACE INTO tombstones (kind, target_id, deleted_at) VALUES (?, ?, ?)'
      );
      if (sanitizedState.deletedPlaylists && typeof sanitizedState.deletedPlaylists === 'object') {
        for (const [id, ts] of Object.entries(
          sanitizedState.deletedPlaylists as Record<string, number>
        )) {
          insertTombstone.run('playlist', id, Number(ts || now));
        }
      }
      if (sanitizedState.deletedProfiles && typeof sanitizedState.deletedProfiles === 'object') {
        for (const [id, ts] of Object.entries(
          sanitizedState.deletedProfiles as Record<string, number>
        )) {
          insertTombstone.run('profile', id, Number(ts || now));
        }
      }

      const insertNotif = db.prepare(`
        INSERT OR REPLACE INTO notifications (
          id, title, message, level, timestamp, read, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const notifs = Array.isArray(sanitizedState.notifications)
        ? (sanitizedState.notifications as Array<Record<string, unknown>>)
        : [];
      notifs.slice(0, 30).forEach((n, idx) => {
        if (!n || typeof n.id !== 'string') return;
        insertNotif.run(
          n.id,
          String(n.title || ''),
          String(n.message || ''),
          String(n.level || 'info'),
          Number(n.timestamp || now),
          n.read ? 1 : 0,
          idx
        );
      });

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  getUpdateCache(repo: string): SqliteUpdateCacheRow | null {
    if (!this.isAvailable() || !this.db) return null;
    const row = this.db
      .prepare('SELECT repo, etag, payload_json, checked_at FROM update_cache WHERE repo = ?')
      .get(repo);
    if (!row || typeof row.payload_json !== 'string') return null;
    return {
      repo: String(row.repo),
      etag: typeof row.etag === 'string' ? row.etag : null,
      payloadJson: row.payload_json,
      checkedAt: Number(row.checked_at || 0),
    };
  }

  saveUpdateCache(repo: string, etag: string | null, payloadJson: string, checkedAt: number): void {
    if (!this.isAvailable() || !this.db) return;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO update_cache (repo, etag, payload_json, checked_at) VALUES (?, ?, ?, ?)'
      )
      .run(repo, etag, payloadJson, checkedAt);
  }

  checkpoint(): void {
    if (!this.db) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore transient checkpoint warning
    }
  }

  clearAll(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
      this.available = false;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${this.dbPath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }
  }
}
