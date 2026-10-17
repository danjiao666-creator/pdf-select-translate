import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resourcePath, trustedPage, externalUrl, boundedMessage, safeFilename } = require('../../desktop/security.cjs');
const { SecureStore } = require('../../desktop/secure-store.cjs');
const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...value].reverse().join('')),
  decryptString: (buffer) => [...buffer.toString()].reverse().join('')
};

test('desktop resource protocol restricts origin and workspace paths', () => {
  const root = path.resolve('test-app-root');
  assert.equal(resourcePath(root, 'pdf-translator://app/src/viewer.html'), path.join(root, 'src', 'viewer.html'));
  assert.equal(resourcePath(root, 'pdf-translator://app/vendor/cmaps/Adobe-GB1-UCS2.bcmap'), path.join(root, 'vendor', 'cmaps', 'Adobe-GB1-UCS2.bcmap'));
  for (const value of [
    'pdf-translator://app/config.local.json', 'pdf-translator://app/package.json',
    'pdf-translator://app/desktop/main.cjs', 'pdf-translator://app/src/%252e%252e/config.local.json',
    'pdf-translator://app/src/%2e%2e/config.local.json', 'pdf-translator://app/src/foo%5csecret.js',
    'pdf-translator://other/src/viewer.html', 'file:///src/viewer.html',
    'pdf-translator://attacker@app/src/viewer.html', 'pdf-translator://app/src/%00.js'
  ]) assert.equal(resourcePath(root, value), null, value);
});

test('desktop message sender and external links have strict boundaries', () => {
  assert.equal(trustedPage('pdf-translator://app/src/viewer.html?document=abc#page=2'), true);
  assert.equal(trustedPage('pdf-translator://app/src/options.html'), true);
  for (const value of ['pdf-translator://evil/src/viewer.html', 'https://app/src/viewer.html', 'pdf-translator://app/src/viewer.html.evil', 'pdf-translator://app/src/background.js']) assert.equal(trustedPage(value), false);
  for (const value of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'data:text/html,hello', 'https://key:secret@example.com/', 'https://example.com/\nfoo']) assert.equal(externalUrl(value), null);
  assert.equal(externalUrl('https://example.com/paper.pdf'), 'https://example.com/paper.pdf');
  assert.equal(externalUrl('mailto:reader@example.com'), 'mailto:reader@example.com');
  assert.throws(() => boundedMessage({ type: 'readFile', filename: 'secret' }));
  assert.throws(() => boundedMessage({ type: 'chat', text: 'x'.repeat(3 * 1024 * 1024) }));
  assert.equal(boundedMessage({ type: 'chatCancel', requestId: 'a' }).requestId, 'a');
});

test('download filenames cannot escape folders or use device names', () => {
  assert.equal(safeFilename('../../article.pdf'), 'article.pdf');
  assert.equal(safeFilename('NUL.pdf'), 'document.pdf');
  assert.equal(safeFilename('CON'), 'document.pdf');
  assert.equal(safeFilename('paper:translated?.pdf'), 'paper_translated_.pdf');
});

async function withDirectory(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-desktop-unit-'));
  try { await action(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('paper-desktop-unit-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('desktop storage encrypts credentials and redacts renderer reads and notifications', async () => withDirectory(async (directory) => {
  const storage = new SecureStore(directory, fakeEncryption);
  await storage.load();
  const changes = await storage.set({ settings: { theme: 'dark', custom: { apiKey: 'test-secret-do-not-package', baseUrl: 'https://example.com' } } });
  const disk = await fs.readFile(storage.filename, 'utf8');
  assert.ok(!disk.includes('test-secret-do-not-package'));
  assert.equal(JSON.parse(disk).data.settings.custom.apiKey, undefined);
  assert.equal(storage.get('settings').settings.custom.apiKey, 'test-secret-do-not-package');
  assert.equal(storage.get('settings', true).settings.custom.apiKey, '');
  assert.equal(storage.get('settings', true).settings.custom.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(storage.publicChanges(changes)).includes('test-secret-do-not-package'));
  const reloaded = new SecureStore(directory, fakeEncryption);
  await reloaded.load();
  assert.equal(reloaded.get('settings').settings.custom.apiKey, 'test-secret-do-not-package');
  await reloaded.set({ settings: { custom: { apiKey: '' } } });
  assert.equal(JSON.parse(await fs.readFile(reloaded.filename, 'utf8')).credential, '');
}));

test('desktop storage refuses plaintext fallback and serializes concurrent writes', async () => withDirectory(async (directory) => {
  const storage = new SecureStore(directory, { ...fakeEncryption, isEncryptionAvailable: () => false });
  await storage.load();
  await assert.rejects(storage.set({ settings: { custom: { apiKey: 'never-plaintext' } } }), /安全存储/);
  assert.deepEqual(storage.get(null), {});
  const secure = new SecureStore(directory, fakeEncryption);
  await secure.load();
  await Promise.all([secure.set({ settings: { theme: 'light' } }), secure.set({ engineHealth: { lastGood: 'youdao' } })]);
  const parsed = JSON.parse(await fs.readFile(secure.filename, 'utf8'));
  assert.equal(parsed.data.settings.theme, 'light');
  assert.equal(parsed.data.engineHealth.lastGood, 'youdao');
}));

test('corrupt settings are preserved without touching document-library files', async () => withDirectory(async (directory) => {
  const storage = new SecureStore(directory, fakeEncryption);
  await fs.writeFile(storage.filename, '{broken');
  await fs.writeFile(path.join(directory, 'library-evidence.bin'), 'untouched');
  await storage.load();
  assert.match(storage.warning, /副本/);
  assert.ok((await fs.readdir(directory)).some((name) => name.startsWith('preferences.json.unreadable-')));
  assert.equal(await fs.readFile(path.join(directory, 'library-evidence.bin'), 'utf8'), 'untouched');
}));
