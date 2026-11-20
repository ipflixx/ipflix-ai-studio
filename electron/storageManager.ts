import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IpflixSqliteStore, SQLITE_SCHEMA_VERSION } from './sqliteStorage';

interface EncryptedVaultPayload {
  version: number;
  playlistSecrets: Record<
    string,
    {
      password?: string;
      m3uUrl?: string;
      epgUrl?: string;
    }
  >;
  profilePins: Record<string, string>;
  cloudVaultKeys: Record<string, string>;
}

interface StoredPlaylistRecord extends Record<string, unknown> {
  id: string;
  password?: string;
  m3uUrl?: string;
  epgUrl?: string;
  hasEncryptedSecrets?: boolean;
}

interface StoredProfileRecord extends Record<string, unknown> {
  id: string;
  pin?: string;
  hasPin?: boolean;
}

export interface StoredAppStatePayload extends Record<string, unknown> {
  schemaVersion: number;
  updatedAt: number;
  playlists?: StoredPlaylistRecord[];
  profiles?: StoredProfileRecord[];
}

export interface StorageRuntimeInfo {
  userDataDir: string;
  storeDir: string;
  safeStorageAvailable: boolean;
  hasPersistedState: boolean;
  sqliteEnabled: boolean;
  sqlitePath: string;
  schemaVersion: number;
}

export interface LoadStateResult {
  ok: boolean;
  exists: boolean;
  state: StoredAppStatePayload | null;
  recoveredFromBackup?: boolean;
  vaultRecoveredFromBackup?: boolean;
  vaultLocked?: boolean;
  vaultError?: string;
  error?: string;
}

interface VaultReadResult {
  status: 'ok' | 'missing' | 'recovered_from_backup' | 'decrypt_failed';
  vault: EncryptedVaultPayload;
  error?: string;
}

const EMPTY_VAULT: EncryptedVaultPayload = {
  version: 1,
  playlistSecrets: {},
  profilePins: {},
  cloudVaultKeys: {},
};

function sanitizeFileId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  if (cleaned) return cleaned;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Durable, crash-safe Electron storage manager strictly backed by `app.getPath('userData')`.
 *
 * - Never writes inside the app installation directory or `resources/`.
 * - Uses atomic write + fsync + `.bak` recovery so power loss or crashes never corrupt data.
 * - Encrypts IPTV provider passwords, M3U/EPG credential URLs, profile PINs, and cloud vault keys
 *   with Electron `safeStorage` (Windows DPAPI) before writing `vault.bin`.
 */
export class ElectronStorageManager {
  private readonly userDataDir: string;
  private readonly storeDir: string;
  private readonly catalogsDir: string;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly vaultPath: string;
  private readonly vaultBackupPath: string;
  private readonly fallbackKeyPath: string;
  private readonly sqlite: IpflixSqliteStore;

  private writeQueue: Promise<unknown> = Promise.resolve();
  private vaultLocked = false;
  private vaultError: string | null = null;
  private quarantinedCorruptVault = false;

  constructor(customUserDataDir?: string) {
    this.userDataDir = customUserDataDir || app.getPath('userData');
    this.storeDir = path.join(this.userDataDir, 'ipflix-data');
    this.catalogsDir = path.join(this.storeDir, 'catalogs');
    this.statePath = path.join(this.storeDir, 'state.json');
    this.stateBackupPath = path.join(this.storeDir, 'state.json.bak');
    this.vaultPath = path.join(this.storeDir, 'vault.bin');
    this.vaultBackupPath = path.join(this.storeDir, 'vault.bin.bak');
    this.fallbackKeyPath = path.join(this.storeDir, '.vault.key');
    this.sqlite = new IpflixSqliteStore(this.storeDir);
  }

  getSqliteStore(): IpflixSqliteStore {
    this.sqlite.init();
    return this.sqlite;
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    fs.mkdirSync(this.catalogsDir, { recursive: true });
  }

  private isSafeStorageReady(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  getInfo(): StorageRuntimeInfo {
    const sqliteEnabled = this.sqlite.init();
    const hasPersistedState =
      this.sqlite.hasPersistedState() ||
      fs.existsSync(this.statePath) ||
      fs.existsSync(this.stateBackupPath);
    return {
      userDataDir: this.userDataDir,
      storeDir: this.storeDir,
      safeStorageAvailable: this.isSafeStorageReady(),
      hasPersistedState,
      sqliteEnabled,
      sqlitePath: this.sqlite.dbPath,
      schemaVersion: this.sqlite.getAppliedSchemaVersion() || SQLITE_SCHEMA_VERSION,
    };
  }

  /**
   * Crash-safe atomic write with fsync, backup preservation, and Windows rename retries
   * (handles transient EPERM/EBUSY when Windows Defender scans newly created temp files).
   */
  private atomicWriteBuffer(targetPath: string, backupPath: string | null, data: Buffer): void {
    this.ensureDirs();
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;

    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, data, 0, data.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (backupPath && fs.existsSync(targetPath)) {
      try {
        fs.copyFileSync(targetPath, backupPath);
      } catch {
        // Best-effort backup copy before atomic swap
      }
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.renameSync(tmpPath, targetPath);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          const waitUntil = Date.now() + 25 * (attempt + 1);
          while (Date.now() < waitUntil) {
            // brief synchronous retry backoff for Windows file lock release
          }
          continue;
        }
        break;
      }
    }

    // Cleanup orphaned temp file if rename failed
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw lastErr instanceof Error ? lastErr : new Error('Atomic file write failed');
  }

  private getOrCreateFallbackKey(): Buffer {
    this.ensureDirs();
    if (fs.existsSync(this.fallbackKeyPath)) {
      const existing = fs.readFileSync(this.fallbackKeyPath);
      if (existing.length === 32) return existing;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.fallbackKeyPath, key, { mode: 0o600 });
    return key;
  }

  private encryptVault(payload: EncryptedVaultPayload): Buffer {
    const plaintext = JSON.stringify(payload);
    if (this.isSafeStorageReady()) {
      const encrypted = safeStorage.encryptString(plaintext);
      return Buffer.concat([Buffer.from('SS01', 'ascii'), encrypted]);
    }

    // Encrypted AES-256-GCM fallback when OS keyring is unavailable (never plaintext)
    const key = this.getOrCreateFallbackKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from('AG01', 'ascii'), iv, tag, ct]);
  }

  private decryptVaultBuffer(buf: Buffer): EncryptedVaultPayload | null {
    if (buf.length < 8) return null;
    const magic = buf.subarray(0, 4).toString('ascii');
    const body = buf.subarray(4);

    if (magic === 'SS01') {
      if (!this.isSafeStorageReady()) return null;
      const json = safeStorage.decryptString(body);
      return JSON.parse(json) as EncryptedVaultPayload;
    }

    if (magic === 'AG01') {
      if (body.length < 28) return null;
      const key = this.getOrCreateFallbackKey();
      const iv = body.subarray(0, 12);
      const tag = body.subarray(12, 28);
      const ct = body.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      return JSON.parse(json) as EncryptedVaultPayload;
    }

    return null;
  }

  private quarantineCorruptVaultFiles(): void {
    if (this.quarantinedCorruptVault) return;
    this.quarantinedCorruptVault = true;
    const stamp = Date.now();
    try {
      if (fs.existsSync(this.vaultPath)) {
        fs.copyFileSync(this.vaultPath, path.join(this.storeDir, `vault.corrupt.${stamp}.bin`));
      }
      if (fs.existsSync(this.vaultBackupPath)) {
        fs.copyFileSync(
          this.vaultBackupPath,
          path.join(this.storeDir, `vault.corrupt.${stamp}.bin.bak`)
        );
      }
    } catch {
      // Best-effort quarantine copy
    }
  }

  private readVaultDetailed(): VaultReadResult {
    const mainExists = fs.existsSync(this.vaultPath);
    const bakExists = fs.existsSync(this.vaultBackupPath);

    if (!mainExists && !bakExists) {
      return {
        status: 'missing',
        vault: { version: 1, playlistSecrets: {}, profilePins: {}, cloudVaultKeys: {} },
      };
    }

    if (mainExists) {
      try {
        const buf = fs.readFileSync(this.vaultPath);
        const parsed = this.decryptVaultBuffer(buf);
        if (parsed && typeof parsed === 'object') {
          return {
            status: 'ok',
            vault: {
              version: 1,
              playlistSecrets: parsed.playlistSecrets || {},
              profilePins: parsed.profilePins || {},
              cloudVaultKeys: parsed.cloudVaultKeys || {},
            },
          };
        }
      } catch {
        // Primary vault unreadable — attempt backup recovery below
      }
    }

    if (bakExists) {
      try {
        const buf = fs.readFileSync(this.vaultBackupPath);
        const parsed = this.decryptVaultBuffer(buf);
        if (parsed && typeof parsed === 'object') {
          const recoveredVault: EncryptedVaultPayload = {
            version: 1,
            playlistSecrets: parsed.playlistSecrets || {},
            profilePins: parsed.profilePins || {},
            cloudVaultKeys: parsed.cloudVaultKeys || {},
          };
          // Quarantine corrupt primary before restoring from healthy backup
          if (mainExists) {
            try {
              fs.copyFileSync(
                this.vaultPath,
                path.join(this.storeDir, `vault.corrupt.${Date.now()}.bin`)
              );
            } catch {
              // ignore
            }
          }
          try {
            const encrypted = this.encryptVault(recoveredVault);
            this.atomicWriteBuffer(this.vaultPath, null, encrypted);
          } catch {
            // Even if restore write fails, we still hold the decrypted backup in memory
          }
          return {
            status: 'recovered_from_backup',
            vault: recoveredVault,
          };
        }
      } catch {
        // Backup also unreadable
      }
    }

    this.quarantineCorruptVaultFiles();
    return {
      status: 'decrypt_failed',
      vault: { version: 1, playlistSecrets: {}, profilePins: {}, cloudVaultKeys: {} },
      error:
        'Şifreli kasa (vault.bin) çözülemedi. Kayıtlı IPTV parolalarınız ve profil PIN kilitleriniz koruma altına alındı; mevcut verilerinizin üzerine yazılmayacaktır.',
    };
  }

  private writeVault(vault: EncryptedVaultPayload): void {
    const encrypted = this.encryptVault(vault);
    this.atomicWriteBuffer(this.vaultPath, this.vaultBackupPath, encrypted);
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => {});
    this.sqlite.checkpoint();
  }

  async loadState(): Promise<LoadStateResult> {
    return this.enqueue(() => {
      const sqliteReady = this.sqlite.init();
      let parsed: StoredAppStatePayload | null = null;
      let recoveredFromBackup = false;
      let importedFromLegacyJson = false;

      if (sqliteReady) {
        try {
          const sqliteState = this.sqlite.loadState() as StoredAppStatePayload | null;
          if (sqliteState && typeof sqliteState === 'object') {
            parsed = sqliteState;
          }
        } catch {
          parsed = null;
        }
      }

      const mainExists = fs.existsSync(this.statePath);
      const bakExists = fs.existsSync(this.stateBackupPath);

      if (!parsed && !mainExists && !bakExists) {
        return { ok: true, exists: false, state: null };
      }

      if (!parsed && mainExists) {
        try {
          const raw = fs.readFileSync(this.statePath, 'utf8');
          const obj = JSON.parse(raw) as StoredAppStatePayload;
          if (obj && typeof obj === 'object') {
            parsed = obj;
            importedFromLegacyJson = sqliteReady;
          }
        } catch {
          parsed = null;
        }
      }

      if (!parsed && bakExists) {
        try {
          const raw = fs.readFileSync(this.stateBackupPath, 'utf8');
          const obj = JSON.parse(raw) as StoredAppStatePayload;
          if (obj && typeof obj === 'object') {
            parsed = obj;
            recoveredFromBackup = true;
            importedFromLegacyJson = sqliteReady;
          }
        } catch {
          parsed = null;
        }
      }

      if (!parsed) {
        // Quarantine corrupt file instead of silently wiping user data
        try {
          if (mainExists) {
            fs.copyFileSync(
              this.statePath,
              path.join(this.storeDir, `state.corrupt.${Date.now()}.json`)
            );
          }
        } catch {
          // ignore quarantine error
        }
        return {
          ok: false,
          exists: true,
          state: null,
          error: 'Yerel veri dosyası okunamadı. Güvenlik için bozuk dosya yedeklendi.',
        };
      }

      // One-time seamless import of legacy state.json into SQLite without losing any user data
      if (importedFromLegacyJson && sqliteReady) {
        try {
          this.sqlite.saveState(parsed);
        } catch {
          // Keep parsed state working even if SQLite import fails transiently
        }
      }

      // Re-hydrate encrypted secrets from OS-protected vault into in-memory state.
      // NEVER silently unlock PINs or allow destructive overwrite when vault decryption fails!
      const expectsSecrets =
        (Array.isArray(parsed.playlists) && parsed.playlists.some((pl) => Boolean(pl.hasEncryptedSecrets))) ||
        (Array.isArray(parsed.profiles) && parsed.profiles.some((prof) => Boolean(prof.hasPin)));

      const vaultRes = this.readVaultDetailed();
      if (
        vaultRes.status === 'decrypt_failed' ||
        (vaultRes.status === 'missing' && expectsSecrets)
      ) {
        this.vaultLocked = true;
        this.vaultError =
          vaultRes.error ||
          'Şifreli kasa dosyası bulunamadı veya çözülemedi. Kayıtlı IPTV parolalarınız ve profil PIN kilitleriniz koruma altına alındı.';

        // Preserve hasEncryptedSecrets and hasPin flags untouched so locked profiles stay locked
        return {
          ok: true,
          exists: true,
          state: parsed,
          recoveredFromBackup,
          vaultLocked: true,
          vaultError: this.vaultError,
        };
      }

      this.vaultLocked = false;
      this.vaultError = null;
      const vault = vaultRes.vault;

      if (Array.isArray(parsed.playlists)) {
        parsed.playlists = parsed.playlists.map((pl) => {
          const secret = vault.playlistSecrets[pl.id];
          const hydrated: StoredPlaylistRecord = { ...pl };
          if (secret) {
            if (secret.password !== undefined) hydrated.password = secret.password;
            if (secret.m3uUrl !== undefined) hydrated.m3uUrl = secret.m3uUrl;
            if (secret.epgUrl !== undefined) hydrated.epgUrl = secret.epgUrl;
            hydrated.hasEncryptedSecrets = true;
          } else {
            delete hydrated.hasEncryptedSecrets;
          }
          return hydrated;
        });
      }

      if (Array.isArray(parsed.profiles)) {
        parsed.profiles = parsed.profiles.map((prof) => {
          const pin = vault.profilePins[prof.id];
          const hydrated: StoredProfileRecord = { ...prof };
          if (pin) {
            hydrated.pin = pin;
            hydrated.hasPin = true;
          }
          return hydrated;
        });
      }

      return {
        ok: true,
        exists: true,
        state: parsed,
        recoveredFromBackup,
        vaultRecoveredFromBackup: vaultRes.status === 'recovered_from_backup',
        vaultLocked: false,
      };
    });
  }

  private saveStateInternal(
    incomingState: StoredAppStatePayload
  ): { ok: boolean; savedAt: number; vaultLocked?: boolean; error?: string } {
    // CRITICAL SAFETY GUARD: Never overwrite vault.bin or state.json while vault decryption is failed/locked!
    if (this.vaultLocked) {
      return {
        ok: false,
        savedAt: 0,
        vaultLocked: true,
        error:
          this.vaultError ||
          'Şifreli kasa kilitli olduğu için mevcut parolalarınızın ve PIN kilitlerinizin üzerine yazılmadı.',
      };
    }

    try {
      this.ensureDirs();
      const savedAt = Date.now();
      const existingVaultRes = this.readVaultDetailed();
      if (existingVaultRes.status === 'decrypt_failed') {
        this.vaultLocked = true;
        this.vaultError = existingVaultRes.error || 'Şifreli kasa çözülemedi.';
        return {
          ok: false,
          savedAt: 0,
          vaultLocked: true,
          error: this.vaultError,
        };
      }
      const existingVault = existingVaultRes.vault;

      const nextPlaylistSecrets: EncryptedVaultPayload['playlistSecrets'] = {};
      const sanitizedPlaylists = Array.isArray(incomingState.playlists)
        ? incomingState.playlists.map((pl) => {
            const copy: StoredPlaylistRecord = { ...pl };
            const secretEntry: { password?: string; m3uUrl?: string; epgUrl?: string } = {};
            let hasSecret = false;

            if (typeof copy.password === 'string' && copy.password.length > 0) {
              secretEntry.password = copy.password;
              hasSecret = true;
            }
            if (typeof copy.m3uUrl === 'string' && copy.m3uUrl.length > 0) {
              secretEntry.m3uUrl = copy.m3uUrl;
              hasSecret = true;
            }
            if (typeof copy.epgUrl === 'string' && copy.epgUrl.length > 0) {
              secretEntry.epgUrl = copy.epgUrl;
              hasSecret = true;
            }

            // Strictly strip plaintext IPTV credentials before writing state.json
            delete copy.password;
            delete copy.m3uUrl;
            delete copy.epgUrl;
            if (hasSecret) {
              copy.hasEncryptedSecrets = true;
              nextPlaylistSecrets[pl.id] = secretEntry;
            } else {
              delete copy.hasEncryptedSecrets;
            }
            return copy;
          })
        : [];

      const nextProfilePins: EncryptedVaultPayload['profilePins'] = {};
      const sanitizedProfiles = Array.isArray(incomingState.profiles)
        ? incomingState.profiles.map((prof) => {
            const copy: StoredProfileRecord = { ...prof };
            if (typeof copy.pin === 'string' && copy.pin.length === 4) {
              nextProfilePins[prof.id] = copy.pin;
              copy.hasPin = true;
            } else {
              copy.hasPin = false;
            }
            // Strictly strip plaintext profile PIN from state.json
            delete copy.pin;
            return copy;
          })
        : [];

      const nextVault: EncryptedVaultPayload = {
        version: 1,
        playlistSecrets: nextPlaylistSecrets,
        profilePins: nextProfilePins,
        cloudVaultKeys: existingVault.cloudVaultKeys || {},
      };

      const sanitizedState: StoredAppStatePayload = {
        ...incomingState,
        updatedAt: incomingState.updatedAt || savedAt,
        playlists: sanitizedPlaylists,
        profiles: sanitizedProfiles,
      };

      // Write encrypted vault first, then commit atomically to SQLite AND atomic state.json backup mirror
      this.writeVault(nextVault);
      if (this.sqlite.init()) {
        this.sqlite.saveState(sanitizedState);
      }
      const stateBuf = Buffer.from(JSON.stringify(sanitizedState, null, 2), 'utf8');
      this.atomicWriteBuffer(this.statePath, this.stateBackupPath, stateBuf);

      return { ok: true, savedAt };
    } catch (err) {
      return {
        ok: false,
        savedAt: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private lastSyncSavedUpdatedAt = 0;

  async saveState(
    incomingState: StoredAppStatePayload
  ): Promise<{ ok: boolean; savedAt: number; vaultLocked?: boolean; error?: string }> {
    return this.enqueue(() => {
      if (
        this.lastSyncSavedUpdatedAt > 0 &&
        typeof incomingState.updatedAt === 'number' &&
        incomingState.updatedAt < this.lastSyncSavedUpdatedAt
      ) {
        return { ok: true, savedAt: Date.now() };
      }
      return this.saveStateInternal(incomingState);
    });
  }

  /**
   * Synchronous atomic write for abrupt window close / OS shutdown (`beforeunload`).
   */
  saveStateSync(
    incomingState: StoredAppStatePayload
  ): { ok: boolean; savedAt: number; vaultLocked?: boolean; error?: string } {
    const res = this.saveStateInternal(incomingState);
    if (res.ok && typeof incomingState.updatedAt === 'number') {
      this.lastSyncSavedUpdatedAt = Math.max(this.lastSyncSavedUpdatedAt, incomingState.updatedAt);
    }
    return res;
  }

  /**
   * Explicit user-confirmed recovery when vault decryption permanently fails:
   * backs up existing vault/state files into a timestamped recovery folder, initializes
   * a fresh empty encrypted vault, clears stale hasPin/hasEncryptedSecrets flags so the
   * user can re-enter IPTV credentials & profile PINs WITHOUT losing profiles, favorites,
   * watch history, or settings.
   */
  async resetLockedVault(): Promise<LoadStateResult> {
    return this.enqueue(() => {
      try {
        this.ensureDirs();
        const backupDir = path.join(this.storeDir, `recovery-backup-${Date.now()}`);
        fs.mkdirSync(backupDir, { recursive: true });
        for (const p of [
          this.statePath,
          this.stateBackupPath,
          this.vaultPath,
          this.vaultBackupPath,
        ]) {
          if (fs.existsSync(p)) {
            fs.copyFileSync(p, path.join(backupDir, path.basename(p)));
          }
        }

        // Write clean encrypted vault so future saves succeed cleanly
        this.writeVault({
          version: 1,
          playlistSecrets: {},
          profilePins: {},
          cloudVaultKeys: {},
        });
        this.vaultLocked = false;
        this.vaultError = null;
        this.quarantinedCorruptVault = false;

        let parsed: StoredAppStatePayload | null = null;
        for (const candidate of [this.statePath, this.stateBackupPath]) {
          try {
            if (!fs.existsSync(candidate)) continue;
            const obj = JSON.parse(fs.readFileSync(candidate, 'utf8')) as StoredAppStatePayload;
            if (obj && typeof obj === 'object') {
              parsed = obj;
              break;
            }
          } catch {
            // try backup
          }
        }

        if (!parsed) {
          return { ok: true, exists: false, state: null, vaultLocked: false };
        }

        if (Array.isArray(parsed.playlists)) {
          parsed.playlists = parsed.playlists.map((pl) => {
            const copy: StoredPlaylistRecord = { ...pl };
            delete copy.password;
            delete copy.m3uUrl;
            delete copy.epgUrl;
            delete copy.hasEncryptedSecrets;
            return copy;
          });
        }

        if (Array.isArray(parsed.profiles)) {
          parsed.profiles = parsed.profiles.map((prof) => {
            const copy: StoredProfileRecord = { ...prof };
            delete copy.pin;
            copy.hasPin = false;
            return copy;
          });
        }

        parsed.updatedAt = Date.now();
        if (this.sqlite.init()) {
          this.sqlite.saveState(parsed);
        }
        const stateBuf = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8');
        this.atomicWriteBuffer(this.statePath, this.stateBackupPath, stateBuf);

        return {
          ok: true,
          exists: true,
          state: parsed,
          vaultLocked: false,
        };
      } catch (err) {
        return {
          ok: false,
          exists: true,
          state: null,
          vaultLocked: this.vaultLocked,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  async loadCatalog(playlistId: string): Promise<unknown | null> {
    return this.enqueue(() => {
      const target = path.join(this.catalogsDir, `${sanitizeFileId(playlistId)}.json`);
      const backup = `${target}.bak`;
      for (const candidate of [target, backup]) {
        try {
          if (!fs.existsSync(candidate)) continue;
          return JSON.parse(fs.readFileSync(candidate, 'utf8'));
        } catch {
          // try backup
        }
      }
      return null;
    });
  }

  async saveCatalog(
    playlistId: string,
    catalog: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue(() => {
      try {
        this.ensureDirs();
        const target = path.join(this.catalogsDir, `${sanitizeFileId(playlistId)}.json`);
        const backup = `${target}.bak`;
        const buf = Buffer.from(JSON.stringify(catalog), 'utf8');
        this.atomicWriteBuffer(target, backup, buf);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async deleteCatalog(playlistId: string): Promise<{ ok: boolean }> {
    return this.enqueue(() => {
      const target = path.join(this.catalogsDir, `${sanitizeFileId(playlistId)}.json`);
      for (const p of [target, `${target}.bak`]) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
      return { ok: true };
    });
  }

  async clearAllData(): Promise<{ ok: boolean }> {
    return this.enqueue(() => {
      try {
        this.lastSyncSavedUpdatedAt = 0;
        this.vaultLocked = false;
        this.vaultError = null;
        this.quarantinedCorruptVault = false;
        this.sqlite.clearAll();
        for (const p of [
          this.statePath,
          this.stateBackupPath,
          this.vaultPath,
          this.vaultBackupPath,
        ]) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (fs.existsSync(this.catalogsDir)) {
          fs.rmSync(this.catalogsDir, { recursive: true, force: true });
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    });
  }
}

export { EMPTY_VAULT };
