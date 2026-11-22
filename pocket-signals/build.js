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
