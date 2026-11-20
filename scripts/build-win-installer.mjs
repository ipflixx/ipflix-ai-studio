import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = String(pkg.version || '1.0.0').trim();

const releaseDir = path.join(projectRoot, 'release');
const unpackedDir = path.join(releaseDir, 'win-unpacked');
const nsiScript = path.join(projectRoot, 'electron', 'installer.nsi');
const iconFile = path.join(projectRoot, 'electron', 'assets', 'icon.ico');
const outExe = path.join(releaseDir, 'IPFlix-Windows-Setup.exe');

if (!fs.existsSync(path.join(unpackedDir, 'IPFLIX.exe'))) {
  throw new Error(
    `Missing unpacked Windows app at ${unpackedDir}. Run "npm run electron:pack" first.`
  );
}

fs.mkdirSync(releaseDir, { recursive: true });
if (fs.existsSync(outExe)) {
  fs.unlinkSync(outExe);
}

console.log(`[win-installer] Compiling NSIS setup executable via makensis for IPFLIX v${version}...`);
execFileSync(
  'makensis',
  [
    `-DAPP_VERSION=${version}`,
    `-DSOURCE_DIR=${unpackedDir}`,
    `-DOUT_FILE=${outExe}`,
    `-DICON_FILE=${iconFile}`,
    nsiScript,
  ],
  { stdio: 'inherit' }
);

if (!fs.existsSync(outExe)) {
  throw new Error(`Expected NSIS output EXE not found at ${outExe}`);
}

const stat = fs.statSync(outExe);
const hash = crypto.createHash('sha256').update(fs.readFileSync(outExe)).digest('hex');
fs.writeFileSync(`${outExe}.sha256`, `${hash}  ${path.basename(outExe)}\n`, 'utf8');

console.log(
  `[win-installer] Built ${outExe} (${stat.size} bytes / ${(stat.size / (1024 * 1024)).toFixed(2)} MB)\n[win-installer] SHA-256: ${hash}`
);
