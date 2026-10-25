// Builds dist/SoundKami-win32-x64 (portable folder) and a zip of it.
// Works on Windows, Linux and macOS — no Wine needed: the exe's icon and
// version info are written with resedit.
'use strict';

const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');
const ResEdit = require('resedit');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

async function main() {
  const helper = path.join(root, 'native', 'sk-capture.exe');
  if (!fs.existsSync(helper)) throw new Error('native/sk-capture.exe is missing — build it first (see README).');

  const [appDir] = await packager({
    dir: root,
    name: 'SoundKami',
    executableName: 'SoundKami',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    extraResource: [helper],
    appVersion: pkg.version,
    appCopyright: `© ${new Date().getFullYear()} SoundKami`,
    ignore: [
      /^\/dist($|\/)/,
      /^\/scripts($|\/)/,
      /^\/native($|\/)/,
      /^\/\.github($|\/)/,
      /^\/docs($|\/)/,
      /^\/src\/dev-shot\.js$/,
      /\.md$/,
    ],
  });

  // Icon + version resources
  const exePath = path.join(appDir, 'SoundKami.exe');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: 'SoundKami',
    FileDescription: 'SoundKami',
    ProductName: 'SoundKami',
    InternalName: 'SoundKami',
    OriginalFilename: 'SoundKami.exe',
    LegalCopyright: `© ${new Date().getFullYear()} SoundKami`,
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // Remove locales we don't need to keep the download small (English only UI).
  const locales = path.join(appDir, 'locales');
  for (const f of fs.readdirSync(locales)) if (!/^en-(US|GB)\.pak$/.test(f)) fs.rmSync(path.join(locales, f));

  const zipPath = path.join(root, 'dist', `SoundKami-${pkg.version}-win-x64-portable.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(appDir, 'SoundKami');
  zip.writeZip(zipPath);
  console.log('Built', appDir);
  console.log('Zipped', zipPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
