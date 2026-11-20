import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-electron');

const mode = process.argv.includes('--main-only') ? 'main-only' : 'all';

fs.mkdirSync(OUT_DIR, { recursive: true });

async function build() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'info',
  };

  // 1. Electron Main Process
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT_DIR, 'electron', 'main.ts')],
    outfile: path.join(OUT_DIR, 'main.cjs'),
    external: ['electron', 'node:sqlite'],
  });

  // 2. Electron Preload Bridge
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT_DIR, 'electron', 'preload.ts')],
    outfile: path.join(OUT_DIR, 'preload.cjs'),
    external: ['electron'],
  });

  // 3. Self-contained Production Express Backend (vite stays external & unused in production)
  if (mode === 'all') {
    await esbuild.build({
      ...common,
      entryPoints: [path.join(ROOT_DIR, 'server.ts')],
      outfile: path.join(OUT_DIR, 'server.cjs'),
      external: ['vite'],
      define: {
        'import.meta.url': '""',
      },
    });
  }
}

build().catch((err) => {
  console.error('Electron build failed:', err);
  process.exit(1);
});
