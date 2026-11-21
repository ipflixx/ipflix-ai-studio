import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const version = String(pkg.version || '1.0.0').trim();
const parts = version.split('.').map((n) => parseInt(n, 10) || 0);
const versionCode = (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);

if (!fs.existsSync(releaseDir)) {
  throw new Error(`Release directory missing: ${releaseDir}`);
}

const files = fs
  .readdirSync(releaseDir)
  .filter((f) => /\.(exe|apk)$/i.test(f))
  .sort();

if (files.length === 0) {
  throw new Error(`No .exe or .apk artifacts found in ${releaseDir}`);
}

const checksums = {};
const sumLines = [];

for (const file of files) {
  const fullPath = path.join(releaseDir, file);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
  checksums[file] = hash;
  sumLines.push(`${hash}  ${file}`);
  fs.writeFileSync(`${fullPath}.sha256`, `${hash}  ${file}\n`, 'utf8');
}

fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${sumLines.join('\n')}\n`, 'utf8');

const manifest = {
  version,
  versionCode,
  releaseDate: new Date().toISOString(),
  minimumSupportedVersion: '1.0.0',
  mandatoryUpdate: false,
  changelog: `IPFLIX v${version} — Windows (NSIS Setup), Android Telefon ve Android TV dağıtım sürümü.`,
  checksums,
};

fs.writeFileSync(
  path.join(releaseDir, 'ipflix-release.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

console.log(`[release-checksums] Generated SHA256SUMS.txt and ipflix-release.json for ${files.length} artifacts.`);
