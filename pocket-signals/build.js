// Builds dist/bookmarklet.txt from pocket-signals.user.js.
// Usage: npm install && npm run build
'use strict';
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'pocket-signals.user.js'), 'utf8');
  const out = await minify(src, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false, ascii_only: true },
  });
  if (!out.code) throw new Error('minify produced no code');
  // encodeURI keeps the code readable/short; '#' must be escaped or it would start a URL fragment.
  const bookmarklet = 'javascript:' + encodeURI(out.code).replace(/#/g, '%23');
  const dist = path.join(__dirname, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'bookmarklet.txt'), bookmarklet + '\n');
  fs.writeFileSync(path.join(dist, 'pocket-signals.min.js'), out.code + '\n');
  console.log(`bookmarklet: ${bookmarklet.length.toLocaleString('en')} chars -> dist/bookmarklet.txt`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Unpacked browser extension (Brave/Chrome/Edge): dist/pocket-signals-extension.zip
(async () => {
  const { execFileSync } = require('child_process');
  const dir = path.join(__dirname, 'dist', 'extension');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'extension', 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.copyFileSync(path.join(__dirname, 'pocket-signals.user.js'), path.join(dir, 'pocket-signals.js'));
  const zip = path.join(__dirname, 'dist', 'pocket-signals-extension.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', zip.replace(/\.zip$/, ''), dir]);
  console.log('extension -> dist/pocket-signals-extension.zip');
})();
