import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sourceExecutable = require('electron');
const version = require('electron/package.json').version;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PaperTranslatorDev');
const runtime = path.join(development, 'runtime-' + version);
const marker = path.join(runtime, '.paper-translator-runtime');
await fs.mkdir(development, { recursive: true });
let existing = false;
try { existing = (await fs.readFile(marker, 'utf8')).trim() === version; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!existing) {
  try {
    await fs.access(runtime);
    throw new Error('开发运行目录已存在但不是本工具创建的缓存，未覆盖：' + runtime);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await fs.mkdtemp(path.join(development, 'preparing-' + version + '-'));
  await fs.cp(path.dirname(sourceExecutable), staging, { recursive: true });
  await fs.writeFile(path.join(staging, '.paper-translator-runtime'), version + '\n', 'utf8');
  await fs.rename(staging, runtime);
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(runtime, path.basename(sourceExecutable)), [root, '--app-data-dir=' + path.join(development, 'profile'), ...process.argv.slice(2)], {
  env: environment, stdio: 'inherit', windowsHide: true
});
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code || 0; });
process.once('SIGINT', () => child.kill());
process.once('SIGTERM', () => child.kill());
