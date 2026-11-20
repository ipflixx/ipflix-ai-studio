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
const gradleBin = process.env.GRADLE_BIN || '/opt/gradle/gradle-8.9/bin/gradle';
const buildToolsDir = path.join(sdkDir, 'build-tools', '34.0.0');
const zipalignBin = path.join(buildToolsDir, 'zipalign');

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

// 4. Compile Phone & TV APKs (Release signable + Debug testable)
console.log('[android-build] Running Gradle for phone & tv flavors...');
execFileSync(
  gradleBin,
  ['assemblePhoneRelease', 'assemblePhoneDebug', 'assembleTvRelease', 'assembleTvDebug', '--no-daemon'],
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

fs.mkdirSync(releaseDir, { recursive: true });

const artifacts = [
  {
    src: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'phone', 'release', 'app-phone-release-unsigned.apk'),
    dest: path.join(releaseDir, 'IPFlix-Android-v1.0.0-unsigned.apk'),
    align: true,
  },
  {
    src: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'phone', 'debug', 'app-phone-debug.apk'),
    dest: path.join(releaseDir, 'IPFlix-Android-v1.0.0-debug.apk'),
    align: false,
  },
  {
    src: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'tv', 'release', 'app-tv-release-unsigned.apk'),
    dest: path.join(releaseDir, 'IPFlix-Android-TV-v1.0.0-unsigned.apk'),
    align: true,
  },
  {
    src: path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'tv', 'debug', 'app-tv-debug.apk'),
    dest: path.join(releaseDir, 'IPFlix-Android-TV-v1.0.0-debug.apk'),
    align: false,
  },
];

for (const art of artifacts) {
  if (!fs.existsSync(art.src)) {
    throw new Error(`Expected APK not found at ${art.src}`);
  }
  if (fs.existsSync(art.dest)) {
    fs.unlinkSync(art.dest);
  }
  if (art.align && fs.existsSync(zipalignBin)) {
    execFileSync(zipalignBin, ['-f', '-p', '4', art.src, art.dest], { stdio: 'inherit' });
  } else {
    fs.copyFileSync(art.src, art.dest);
  }
  const buf = fs.readFileSync(art.dest);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(`${art.dest}.sha256`, `${sha}  ${path.basename(art.dest)}\n`, 'utf8');
  console.log(
    `[android-build] Built ${art.dest} (${buf.length} bytes / ${(buf.length / (1024 * 1024)).toFixed(2)} MB) sha256=${sha}`
  );
}
