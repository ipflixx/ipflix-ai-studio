import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { ElectronStorageManager, type StoredAppStatePayload } from './storageManager';
import { ElectronUpdaterService } from './updater';

// Stable loopback desktop port so IndexedDB/localStorage (IPTV playlists, profiles,
// PINs, favorites, watch history) stay bound to the same origin across restarts.
// Falls back cleanly if occupied so there is never an EADDRINUSE port conflict.
const DEFAULT_PROD_PORT = 34710;
const DEFAULT_DEV_PORT = 3000;
const BACKEND_HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 30_000;

const isDev = !app.isPackaged && process.env.IPFLIX_ELECTRON_DEV === '1';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendManagedByElectron = false;
let backendOrigin = '';
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;
let storageManager: ElectronStorageManager | null = null;
let updaterService: ElectronUpdaterService | null = null;

function getStorageManager(): ElectronStorageManager {
  if (!storageManager) {
    storageManager = new ElectronStorageManager();
  }
  return storageManager;
}

function getUpdaterService(): ElectronUpdaterService {
  if (!updaterService) {
    updaterService = new ElectronUpdaterService({
      storageManager: getStorageManager(),
      onProgress: (evt) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipflix:updates:progress', evt);
        }
      },
      onQuitForInstaller: () => {
        app.quit();
      },
    });
  }
  return updaterService;
}

// Windows taskbar icon & grouping identity
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ipflix.desktop');
}

// Enable smooth autoplay for Live TV / VOD playback and IPFLIX intro sound
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Single-instance lock: launching IPFLIX again focuses the running desktop window
// instead of spawning a second conflicting server or duplicate window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function getAppIconPath(): string | undefined {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'assets', iconFile),
        path.join(app.getAppPath(), 'electron', 'assets', iconFile),
      ]
    : [path.resolve(__dirname, '..', 'electron', 'assets', iconFile)];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function getProductionPaths(): { serverEntry: string; distDir: string } {
  if (app.isPackaged) {
    return {
      serverEntry: path.join(process.resourcesPath, 'backend', 'server.cjs'),
      distDir: path.join(process.resourcesPath, 'dist'),
    };
  }
  const projectRoot = path.resolve(__dirname, '..');
  return {
    serverEntry: path.join(projectRoot, 'dist-electron', 'server.cjs'),
    distDir: path.join(projectRoot, 'dist'),
  };
}

/**
 * Builds a minimal, sanitized environment for the embedded Express backend.
 * Explicitly avoids forwarding sensitive .env secrets (such as API keys) into
 * the desktop runtime while keeping Windows/OS system paths intact.
 */
function buildSanitizedBackendEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allowList = [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'ProgramFiles',
    'PROGRAMFILES(X86)',
    'ProgramFiles(x86)',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'IPFLIX_FFMPEG_PATH',
    'IPFLIX_FFPROBE_PATH',
    'IPFLIX_CURL_PATH',
    'DISABLE_HMR',
  ];

  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const key of allowList) {
    const val = process.env[key];
    if (val !== undefined) {
      cleanEnv[key] = val;
    }
  }

  return {
    ...cleanEnv,
    ...extra,
  };
}

function isPortAvailable(port: number, host = BACKEND_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function allocateBackendPort(preferredPort: number): Promise<number> {
  if (Number.isInteger(preferredPort) && preferredPort > 1024 && preferredPort < 65535) {
    if (await isPortAvailable(preferredPort)) {
      return preferredPort;
    }
    for (let offset = 1; offset <= 25; offset++) {
      const candidate = preferredPort + offset;
      if (candidate < 65535 && (await isPortAvailable(candidate))) {
        return candidate;
      }
    }
  }

  // Fallback to an OS-assigned free loopback port
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, BACKEND_HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const freePort = addr.port;
        srv.close(() => resolve(freePort));
      } else {
        srv.close(() => reject(new Error('Failed to allocate loopback port')));
      }
    });
  });
}

function checkBackendHealth(origin: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${origin}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 2048) body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const parsed = JSON.parse(body) as { ok?: boolean };
          resolve(parsed.ok === true);
        } catch {
          resolve(false);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function waitForBackendReady(
  origin: string,
  child: ChildProcess | null,
  getExitError: () => string | null,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (err) reject(err);
      else resolve();
    };

    if (child) {
      child.once('exit', (code, signal) => {
        if (!settled) {
          const detail = getExitError();
          finish(
            new Error(
              detail ||
                `IPFLIX backend process exited prematurely (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`
            )
          );
        }
      });
    }

    const poll = async () => {
      if (settled) return;
      const exitErr = getExitError();
      if (exitErr) {
        finish(new Error(exitErr));
        return;
      }

      const healthy = await checkBackendHealth(origin);
      if (healthy) {
        finish();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        finish(new Error(`IPFLIX local backend did not become ready within ${timeoutMs / 1000}s.`));
        return;
      }

      pollTimer = setTimeout(poll, 160);
    };

    void poll();
  });
}

async function startBackendServer(): Promise<string> {
  // Development mode: reuse an explicitly specified or already-running dev server if healthy
  if (isDev) {
    const explicitUrl = process.env.ELECTRON_START_URL?.trim();
    if (explicitUrl) {
      const normalized = explicitUrl.replace(/\/+$/, '');
      await waitForBackendReady(normalized, null, () => null, HEALTH_TIMEOUT_MS);
      backendManagedByElectron = false;
      return normalized;
    }

    const preferredDevPort = Number(process.env.IPFLIX_DEV_PORT || process.env.PORT || DEFAULT_DEV_PORT);
    const existingOrigin = `http://${BACKEND_HOST}:${preferredDevPort}`;
    if (await checkBackendHealth(existingOrigin, 800)) {
      backendManagedByElectron = false;
      return existingOrigin;
    }

    const devPort = await allocateBackendPort(preferredDevPort);
    const projectRoot = path.resolve(__dirname, '..');
    const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serverTs = path.join(projectRoot, 'server.ts');

    if (!fs.existsSync(tsxCli) || !fs.existsSync(serverTs)) {
      throw new Error('Development server files (tsx / server.ts) were not found.');
    }

    let stderrTail = '';
    const child = spawn(process.execPath, [tsxCli, serverTs], {
      cwd: projectRoot,
      env: buildSanitizedBackendEnv({
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'development',
        HOST: BACKEND_HOST,
        PORT: String(devPort),
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    backendProcess = child;
    backendManagedByElectron = true;

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[IPFLIX Backend] ${chunk.toString('utf8')}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const txt = chunk.toString('utf8');
      stderrTail = (stderrTail + txt).slice(-1500);
      process.stderr.write(`[IPFLIX Backend] ${txt}`);
    });

    const origin = `http://${BACKEND_HOST}:${devPort}`;
    await waitForBackendReady(origin, child, () =>
      child.exitCode !== null ? stderrTail.trim() || `Backend exited with code ${child.exitCode}` : null
    );
    return origin;
  }

  // Production mode (Packaged IPFLIX Setup.exe or local electron:preview)
  const { serverEntry, distDir } = getProductionPaths();
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Missing production backend bundle: ${serverEntry}`);
  }
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`Missing production web assets: ${distDir}`);
  }

  const preferredProdPort = Number(process.env.IPFLIX_PORT || DEFAULT_PROD_PORT);
  const prodPort = await allocateBackendPort(preferredProdPort);

  let stderrTail = '';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.dirname(serverEntry),
    env: buildSanitizedBackendEnv({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: BACKEND_HOST,
      PORT: String(prodPort),
      IPFLIX_DIST_DIR: distDir,
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  backendProcess = child;
  backendManagedByElectron = true;

  let resolvedPort = prodPort;
  child.on('message', (msg) => {
    if (msg && typeof msg === 'object') {
      const payload = msg as { type?: string; port?: number };
      if (payload.type === 'ready' && typeof payload.port === 'number' && payload.port > 0) {
        resolvedPort = payload.port;
      }
    }
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    if (!app.isPackaged) {
      process.stdout.write(`[IPFLIX Backend] ${chunk.toString('utf8')}`);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const txt = chunk.toString('utf8');
    stderrTail = (stderrTail + txt).slice(-1500);
    if (!app.isPackaged) {
      process.stderr.write(`[IPFLIX Backend] ${txt}`);
    }
  });

  const origin = `http://${BACKEND_HOST}:${resolvedPort}`;
  await waitForBackendReady(origin, child, () =>
    child.exitCode !== null ? stderrTail.trim() || `Backend exited with code ${child.exitCode}` : null
  );
  return `http://${BACKEND_HOST}:${resolvedPort}`;
}

function forceKillProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already terminated
    }
    resolve();
  });
}

function stopBackendServer(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  const proc = backendProcess;
  if (!proc || !backendManagedByElectron || proc.exitCode !== null) {
    backendProcess = null;
    return Promise.resolve();
  }

  shutdownPromise = new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      backendProcess = null;
      resolve();
    };

    const pid = proc.pid;
    const hardKillTimer = setTimeout(async () => {
      if (pid) {
        await forceKillProcessTree(pid);
      }
      done();
    }, 2500);

    proc.once('exit', () => {
      clearTimeout(hardKillTimer);
      done();
    });

    // Prefer clean IPC shutdown first so Windows runs Express + FFmpeg cleanup reliably
    try {
      if (proc.connected) {
        proc.send({ type: 'shutdown' });
      }
    } catch {
      // fallback to signal below
    }

    if (process.platform !== 'win32') {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  });

  return shutdownPromise;
}

function buildStartupSplashDataUrl(): string {
  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <title>IPFLIX</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: #08090D;
      color: #F5F7FA;
      font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; user-select: none;
    }
    .wrap { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 18px; }
    .wordmark {
      font-size: 38px; font-weight: 800; letter-spacing: 0.16em;
      color: #FFFFFF;
    }
    .wordmark span { color: #E50914; }
    .bar {
      width: 168px; height: 3px; border-radius: 999px;
      background: rgba(255,255,255,0.1); overflow: hidden;
    }
    .bar::after {
      content: ""; display: block; width: 45%; height: 100%;
      background: #E50914; border-radius: 999px;
      animation: slide 1.1s ease-in-out infinite;
    }
    .hint { font-size: 12px; color: #8B93A4; letter-spacing: 0.04em; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(300%); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="wordmark"><span>IP</span>FLIX</div>
    <div class="bar"></div>
    <div class="hint">Başlatılıyor...</div>
  </div>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function configureApplicationMenu(): void {
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'IPFLIX',
      submenu: [
        { label: 'Yenile', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Tam Ekran', accelerator: 'F11', role: 'togglefullscreen' },
        ...(isDev
          ? [
              { type: 'separator' as const },
              { label: 'Geliştirici Araçları', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' as const },
            ]
          : []),
        { type: 'separator' },
        { label: 'Çıkış', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'IPFLIX',
    width: 1360,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#08090D',
    autoHideMenuBar: true,
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: isDev,
    },
  });

  // Never launch external OS browsers or popup windows from inside Electron
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Keep top-level navigation and redirects strictly within the exact local IPFLIX backend origin
  const isAllowedElectronNavigation = (targetUrl: string): boolean => {
    if (targetUrl.startsWith('data:text/html')) return true;
    if (!backendOrigin) return false;
    try {
      const targetParsed = new URL(targetUrl);
      const expectedParsed = new URL(backendOrigin);
      return targetParsed.origin === expectedParsed.origin;
    } catch {
      return false;
    }
  };

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedElectronNavigation(targetUrl)) {
      event.preventDefault();
    }
  });

  win.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowedElectronNavigation(targetUrl)) {
      event.preventDefault();
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    if (isDev && process.env.IPFLIX_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

ipcMain.handle('ipflix:get-version', () => app.getVersion());
ipcMain.handle('ipflix:toggle-fullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
ipcMain.handle('ipflix:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));

// Persistent userData + DPAPI safeStorage IPC handlers
ipcMain.handle('ipflix:storage:info', () => getStorageManager().getInfo());
ipcMain.handle('ipflix:storage:load-state', () => getStorageManager().loadState());
ipcMain.handle('ipflix:storage:save-state', (_event, state: StoredAppStatePayload) =>
  getStorageManager().saveState(state)
);
ipcMain.on('ipflix:storage:save-state-sync', (event, state: StoredAppStatePayload) => {
  event.returnValue = getStorageManager().saveStateSync(state);
});
ipcMain.handle('ipflix:storage:reset-locked-vault', () =>
  getStorageManager().resetLockedVault()
);
ipcMain.handle('ipflix:storage:load-catalog', (_event, playlistId: string) =>
  getStorageManager().loadCatalog(String(playlistId || ''))
);
ipcMain.handle('ipflix:storage:save-catalog', (_event, playlistId: string, catalog: unknown) =>
  getStorageManager().saveCatalog(String(playlistId || ''), catalog)
);
ipcMain.handle('ipflix:storage:delete-catalog', (_event, playlistId: string) =>
  getStorageManager().deleteCatalog(String(playlistId || ''))
);
ipcMain.handle('ipflix:storage:clear-all', () => getStorageManager().clearAllData());

// Multi-platform GitHub Releases auto-update IPC handlers
ipcMain.handle('ipflix:updates:check', (_event, force?: boolean) =>
  getUpdaterService().checkForUpdates(Boolean(force))
);
ipcMain.handle(
  'ipflix:updates:download',
  (
    _event,
    params: { downloadUrl: string; expectedSha256: string; assetName: string }
  ) => getUpdaterService().downloadAndVerifyInstaller(params)
);
ipcMain.handle('ipflix:updates:install', (_event, filePath: string) =>
  getUpdaterService().installVerifiedInstaller(String(filePath || ''))
);

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    configureApplicationMenu();
    mainWindow = createMainWindow();

    // Show lightweight obsidian loading state only until local backend passes /api/health
    await mainWindow.loadURL(buildStartupSplashDataUrl());

    try {
      backendOrigin = await startBackendServer();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(backendOrigin);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox(
        'IPFLIX Başlatılamadı',
        `Yerel medya sunucusu başlatılırken bir hata oluştu.\n\nDetay: ${message}`
      );
      await stopBackendServer();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendOrigin) {
      mainWindow = createMainWindow();
      void mainWindow.loadURL(backendOrigin);
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    const tasks: Promise<unknown>[] = [];
    if (storageManager) {
      tasks.push(storageManager.flush());
    }
    if (backendProcess && backendManagedByElectron && backendProcess.exitCode === null) {
      tasks.push(stopBackendServer());
    }
    void Promise.allSettled(tasks).finally(() => {
      app.quit();
    });
  });

  app.on('will-quit', () => {
    void stopBackendServer();
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void stopBackendServer().finally(() => app.quit());
    });
  }
}
