import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronStorageInfo {
  userDataDir: string;
  storeDir: string;
  safeStorageAvailable: boolean;
  hasPersistedState: boolean;
  sqliteEnabled?: boolean;
  sqlitePath?: string;
  schemaVersion?: number;
}

export interface ElectronLoadStateResult {
  ok: boolean;
  exists: boolean;
  state: Record<string, unknown> | null;
  recoveredFromBackup?: boolean;
  vaultRecoveredFromBackup?: boolean;
  vaultLocked?: boolean;
  vaultError?: string;
  error?: string;
}

export interface ElectronSaveResult {
  ok: boolean;
  savedAt?: number;
  vaultLocked?: boolean;
  error?: string;
}

export interface IpflixDesktopStorageBridge {
  getInfo: () => Promise<ElectronStorageInfo>;
  loadState: () => Promise<ElectronLoadStateResult>;
  saveState: (state: Record<string, unknown>) => Promise<ElectronSaveResult>;
  saveStateSync: (state: Record<string, unknown>) => ElectronSaveResult;
  resetLockedVault: () => Promise<ElectronLoadStateResult>;
  loadCatalog: (playlistId: string) => Promise<unknown | null>;
  saveCatalog: (playlistId: string, catalog: unknown) => Promise<ElectronSaveResult>;
  deleteCatalog: (playlistId: string) => Promise<{ ok: boolean }>;
  clearAllData: () => Promise<{ ok: boolean }>;
}

export interface IpflixDesktopUpdatesBridge {
  check: (force?: boolean) => Promise<unknown>;
  downloadAndVerify: (params: {
    downloadUrl: string;
    expectedSha256: string;
    assetName: string;
  }) => Promise<{ ok: boolean; filePath?: string; sha256?: string; error?: string }>;
  install: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  onProgress: (listener: (event: unknown) => void) => () => void;
}

export interface IpflixDesktopBridge {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  getVersion: () => Promise<string>;
  toggleFullscreen: () => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  storage: IpflixDesktopStorageBridge;
  updates: IpflixDesktopUpdatesBridge;
}

const desktopBridge: IpflixDesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('ipflix:get-version'),
  toggleFullscreen: () => ipcRenderer.invoke('ipflix:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('ipflix:is-fullscreen'),
  storage: {
    getInfo: () => ipcRenderer.invoke('ipflix:storage:info'),
    loadState: () => ipcRenderer.invoke('ipflix:storage:load-state'),
    saveState: (state) => ipcRenderer.invoke('ipflix:storage:save-state', state),
    saveStateSync: (state) => ipcRenderer.sendSync('ipflix:storage:save-state-sync', state),
    resetLockedVault: () => ipcRenderer.invoke('ipflix:storage:reset-locked-vault'),
    loadCatalog: (playlistId) => ipcRenderer.invoke('ipflix:storage:load-catalog', playlistId),
    saveCatalog: (playlistId, catalog) =>
      ipcRenderer.invoke('ipflix:storage:save-catalog', playlistId, catalog),
    deleteCatalog: (playlistId) => ipcRenderer.invoke('ipflix:storage:delete-catalog', playlistId),
    clearAllData: () => ipcRenderer.invoke('ipflix:storage:clear-all'),
  },
  updates: {
    check: (force = false) => ipcRenderer.invoke('ipflix:updates:check', Boolean(force)),
    downloadAndVerify: (params) => ipcRenderer.invoke('ipflix:updates:download', params),
    install: (filePath) => ipcRenderer.invoke('ipflix:updates:install', filePath),
    onProgress: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on('ipflix:updates:progress', wrapped);
      return () => {
        ipcRenderer.removeListener('ipflix:updates:progress', wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld('ipflixDesktop', desktopBridge);
