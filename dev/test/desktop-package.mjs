import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'dist/desktop');
const archive = path.join(output, 'win-unpacked/resources/app.asar');
const entries = asar.listPackage(archive).map((name) => name.replace(/^[/\\]+/, '').replaceAll('\\', '/'));
let checked = 0;

for (const name of entries) {
  assert.ok(!/^(?:dev|docs|node_modules|\.git)\//.test(name), 'Unexpected development content: ' + name);
  assert.ok(!/(?:^|\/)config\.local\.json$|\.pdf$|\.pem$|\.test-bak$/.test(name), 'Private/test file in application: ' + name);
}
for (const name of entries.filter((name) => /^(?:src|vendor)\//.test(name) || /^desktop\/[^/]+\.(?:cjs|mjs|txt)$/.test(name) || ['icons/icon.ico', 'icons/icon128.png', 'LICENSE', 'manifest.json'].includes(name))) {
  const nativeName = name.split('/').join(path.sep);
  const stat = asar.statFile(archive, nativeName);
  if (stat.files) continue;
  const actual = asar.extractFile(archive, nativeName);
  const expected = await fs.readFile(path.join(root, name));
  assert.ok(actual.equals(expected), 'Packaged file differs from final source: ' + name);
  checked++;
}
const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
const manifest = JSON.parse(asar.extractFile(archive, 'manifest.json').toString('utf8'));
assert.equal(packagedMetadata.version, packageMetadata.version);
assert.equal(manifest.version, packageMetadata.version);
assert.equal(packagedMetadata.main, 'desktop/main.cjs');
try {
  const local = JSON.parse(await fs.readFile(path.join(root, 'config.local.json'), 'utf8'));
  if (typeof local.apiKey === 'string' && local.apiKey.length > 8) {
    assert.ok(!(await fs.readFile(archive)).includes(Buffer.from(local.apiKey, 'utf8')), 'Local credential found in packaged application');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(`PASS application package: ${checked} source/resource files match, version ${packageMetadata.version}, no private config/test documents/key`);

for (const filename of ['win-unpacked/PaperTranslator.exe', `PaperTranslator-Setup-${packageMetadata.version}-x64.exe`]) {
  const handle = await fs.open(path.join(output, filename), 'r');
  try {
    const header = Buffer.alloc(4096);
    await handle.read(header, 0, header.length, 0);
    assert.equal(header.toString('ascii', 0, 2), 'MZ');
    const offset = header.readUInt32LE(0x3c);
    assert.equal(header.toString('ascii', offset, offset + 4), 'PE\u0000\u0000');
    if (filename.includes('win-unpacked')) assert.equal(header.readUInt16LE(offset + 4), 0x8664);
  } finally { await handle.close(); }
}
console.log('PASS Windows executables: native PE application (x64) and NSIS installer');

const zipPath = path.join(output, `PaperTranslator-Portable-${packageMetadata.version}-x64.zip`);
const handle = await fs.open(zipPath, 'r');
try {
  const size = (await handle.stat()).size;
  const tail = Buffer.alloc(Math.min(size, 65557));
  await handle.read(tail, 0, tail.length, size - tail.length);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = tail.readUInt16LE(end + 10), bytes = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
  const index = Buffer.alloc(bytes);
  await handle.read(index, 0, bytes, start);
  let position = 0;
  const names = [];
  for (let entry = 0; entry < count; entry++) {
    assert.equal(index.readUInt32LE(position), 0x02014b50);
    const length = index.readUInt16LE(position + 28), extra = index.readUInt16LE(position + 30), comment = index.readUInt16LE(position + 32);
    const name = index.toString('utf8', position + 46, position + 46 + length);
    assert.ok(name.startsWith('PaperTranslator/') && !name.includes('..') && !name.includes('\\'), name);
    assert.ok(!(index.readUInt16LE(position + 8) & 1), 'Archive unexpectedly encrypted');
    names.push(name);
    position += 46 + length + extra + comment;
  }
  assert.equal(position, bytes);
  assert.ok(names.includes('PaperTranslator/PaperTranslator.exe'));
  assert.ok(names.includes('PaperTranslator/resources/app.asar'));
  console.log(`PASS portable ZIP: ${names.length} safe entries, ASCII PaperTranslator/ top-level folder`);
} finally { await handle.close(); }
