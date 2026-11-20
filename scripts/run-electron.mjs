import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Resolve platform-appropriate Electron executable path safely on Windows, macOS, and Linux
const electronBinary = require('electron');

const mode = process.argv[2] === 'prod' ? 'prod' : 'dev';

async function runBuildMain(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'scripts', 'build-electron.mjs'), ...args], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron main build exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  if (mode === 'dev') {
    await runBuildMain(['--main-only']);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  if (mode === 'dev') {
    env.IPFLIX_ELECTRON_DEV = '1';
  } else {
    env.IPFLIX_ELECTRON_DEV = '0';
    env.NODE_ENV = 'production';
  }

  const child = spawn(String(electronBinary), ['.'], {
    cwd: ROOT_DIR,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error('Failed to launch Electron:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
