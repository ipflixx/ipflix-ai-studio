import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const androidDir = path.join(projectRoot, 'android');
const distDir = path.join(projectRoot, 'dist');
const assetsWwwDir = path.join(androidDir, 'app', 'src', 'main', 'assets', 'www');
const resDir = path.join(androidDir, 'app', 'src', 'main', 'res');
const releaseDir = path.join(projectRoot, 'release');

const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/opt/android-sdk';
const gradleBin = process.env.GRADLE_BIN || 'gradle';
const buildToolsDir = path.join(sdkDir, 'build-tools', '34.0.0');
const zipalignBin = path.join(buildToolsDir, 'zipalign');
const apksignerBin = path.join(buildToolsDir, 'apksigner');

const releaseOnly = process.argv.includes('--release-only');
const requireSigning =
  process.env.IPFLIX_REQUIRE_SIGNING === 'true' || releaseOnly;

const hasSigningEnv =
  Boolean(process.env.IPFLIX_KEYSTORE_PATH && fs.existsSync(process.env.IPFLIX_KEYSTORE_PATH)) &&
  Boolean(process.env.IPFLIX_KEYSTORE_PASSWORD) &&
  Boolean(process.env.IPFLIX_KEY_ALIAS) &&
  Boolean(process.env.IPFLIX_KEY_PASSWORD);

if (requireSigning && !hasSigningEnv) {
  throw new Error(
    'Release signing credentials are missing. Provide IPFLIX_KEYSTORE_PATH, IPFLIX_KEYSTORE_PASSWORD, IPFLIX_KEY_ALIAS, and IPFLIX_KEY_PASSWORD.'
  );
}

if (!fs.existsSync(distDir)) {
  throw new Error('dist/ directory missing. Run "npm run build" first.');
}

// 1. Copy production Vite dist/ into android/app/src/main/assets/www/
fs.rmSync(assetsWwwDir, { recursive: true, force: true });
fs.mkdirSync(assetsWwwDir, { recursive: true });
fs.cpSync(distDir, assetsWwwDir, { recursive: true, force: true });

// 2. Ensure launcher icon mipmap exists from electron/assets/icon.png
const srcIcon = path.join(projectRoot, 'electron', 'assets', 'icon.png');
if (fs.existsSync(srcIcon)) {
  for (const density of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
    const dDir = path.join(resDir, density);
    fs.mkdirSync(dDir, { recursive: true });
    fs.copyFileSync(srcIcon, path.join(dDir, 'ic_launcher.png'));
  }
}

// 3. Write android/local.properties pointing to installed SDK
fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${sdkDir}\n`, 'utf8');

// 4. Compile Phone & TV APKs sequentially to keep memory usage predictable
const gradleVariants = releaseOnly
  ? ['assemblePhoneRelease', 'assembleTvRelease']
  : ['assemblePhoneRelease', 'assemblePhoneDebug', 'assembleTvRelease', 'assembleTvDebug'];

for (const variant of gradleVariants) {
  console.log(`[android-build] Running Gradle :app:${variant}...`);
  execFileSync(
    gradleBin,
    [variant, '--no-daemon', '--max-workers=1'],
    {
      cwd: androidDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ANDROID_HOME: sdkDir,
        ANDROID_SDK_ROOT: sdkDir,
      },
    }
  );
}

fs.mkdirSync(releaseDir, { recursive: true });

function pickExisting(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const phoneSignedSrc = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'phone', 'release', 'app-phone-release.apk');
const phoneUnsignedSrc = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'phone', 'release', 'app-phone-release-unsigned.apk');
const tvSignedSrc = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'tv', 'release', 'app-tv-release.apk');
const tvUnsignedSrc = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'tv', 'release', 'app-tv-release-unsigned.apk');

const artifacts = [];

const resolvedPhoneRelease = pickExisting([phoneSignedSrc, phoneUnsignedSrc]);
if (!resolvedPhoneRelease) {
  throw new Error('Phone release APK output not found.');
}
const phoneIsSigned = resolvedPhoneRelease === phoneSignedSrc;
if (requireSigning && !phoneIsSigned) {
  throw new Error('Phone release APK is unsigned despite signing requirement.');
}
artifacts.push({
  src: resolvedPhoneRelease,
  dest: path.join(releaseDir, phoneIsSigned ? 'IPFlix-Android-Phone.apk' : 'IPFlix-Android-Phone-unsigned.apk'),
  needsZipalign: !phoneIsSigned,
  verifySignature: phoneIsSigned,
});

const resolvedTvRelease = pickExisting([tvSignedSrc, tvUnsignedSrc]);
if (!resolvedTvRelease) {
  throw new Error('TV release APK output not found.');
}
const tvIsSigned = resolvedTvRelease === tvSignedSrc;
if (requireSigning && !tvIsSigned) {
  throw new Error('TV release APK is unsigned despite signing requirement.');
}
artifacts.push({
  src: resolvedTvRelease,
  dest: path.join(releaseDir, tvIsSigned ? 'IPFlix-Android-TV.apk' : 'IPFlix-Android-TV-unsigned.apk'),
  needsZipalign: !tvIsSigned,
  verifySignature: tvIsSigned,
});

if (!releaseOnly) {
  const phoneDebug = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'phone', 'debug', 'app-phone-debug.apk');
  const tvDebug = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'tv', 'debug', 'app-tv-debug.apk');
  if (fs.existsSync(phoneDebug)) {
    artifacts.push({
      src: phoneDebug,
      dest: path.join(releaseDir, 'IPFlix-Android-Phone-debug.apk'),
      needsZipalign: false,
      verifySignature: false,
    });
  }
  if (fs.existsSync(tvDebug)) {
    artifacts.push({
      src: tvDebug,
      dest: path.join(releaseDir, 'IPFlix-Android-TV-debug.apk'),
      needsZipalign: false,
      verifySignature: false,
    });
  }
}

for (const art of artifacts) {
  if (fs.existsSync(art.dest)) {
    fs.unlinkSync(art.dest);
  }
  if (art.needsZipalign && fs.existsSync(zipalignBin)) {
    execFileSync(zipalignBin, ['-f', '-p', '4', art.src, art.dest], { stdio: 'inherit' });
  } else {
    fs.copyFileSync(art.src, art.dest);
  }
  if (art.verifySignature && fs.existsSync(apksignerBin)) {
    execFileSync(apksignerBin, ['verify', '--verbose', '--print-certs', art.dest], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(art.dest);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(`${art.dest}.sha256`, `${sha}  ${path.basename(art.dest)}\n`, 'utf8');
  console.log(
    `[android-build] Built ${art.dest} (${buf.length} bytes / ${(buf.length / (1024 * 1024)).toFixed(2)} MB) sha256=${sha}`
  );
}
