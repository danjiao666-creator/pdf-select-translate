import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const source = path.join(root, 'dist/desktop/win-unpacked');
await fs.access(path.join(source, 'PaperTranslator.exe'));
const destination = path.join(root, `dist/desktop/PaperTranslator-Portable-${metadata.version}-x64.zip`);
const temporary = destination + '.pending';
const zip = new yazl.ZipFile();
let entries = 0;
async function add(directory) {
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Refusing symbolic link in portable package: ' + filename);
    if (item.isDirectory()) await add(filename);
    else {
      zip.addFile(filename, 'PaperTranslator/' + path.relative(source, filename).replaceAll(path.sep, '/'));
      entries++;
    }
  }
}
await add(source);
const completed = new Promise((resolve, reject) => {
  const output = createWriteStream(temporary, { flags: 'w' });
  zip.outputStream.pipe(output);
  output.once('close', resolve); output.once('error', reject); zip.outputStream.once('error', reject);
});
zip.end({ forceZip64Format: false });
await completed;
await fs.rename(temporary, destination);
console.log(`Portable package: ${destination} (${entries} files, all under PaperTranslator/)`);
const checksums = [];
for (const filename of [destination, path.join(root, `dist/desktop/PaperTranslator-Setup-${metadata.version}-x64.exe`)]) {
  try { await fs.access(filename); } catch (_) { continue; }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  checksums.push(hash.digest('hex') + '  ' + path.basename(filename));
}
await fs.writeFile(path.join(root, 'dist/desktop/SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
