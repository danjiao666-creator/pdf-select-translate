'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function redacted(value) {
  if (value === undefined) return undefined;
  const data = structuredClone(value);
  if (data?.custom && typeof data.custom === 'object') {
    data.custom.apiKeyConfigured = Boolean(data.custom.apiKey);
    data.custom.apiKey = '';
    if (data.custom.apiKeyConfigured) data.custom.apiKeySource = 'desktop';
  }
  return data;
}

class SecureStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.filename = path.join(directory, 'preferences.json');
    this.safeStorage = safeStorage;
    this.data = {};
    this.pending = Promise.resolve();
    this.warning = '';
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    let stored;
    try { stored = JSON.parse(await fs.readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      const backup = this.filename + '.unreadable-' + Date.now();
      await fs.copyFile(this.filename, backup);
      this.warning = '设置文件损坏，已保留副本。文档库不受影响，请重新检查设置。';
      return;
    }
    if (stored.version !== 1 || !stored.data || typeof stored.data !== 'object' || Array.isArray(stored.data)) {
      throw new Error('设置文件版本不受支持，未覆盖原文件');
    }
    this.data = stored.data;
    if (this.data.settings?.custom) delete this.data.settings.custom.apiKey;
    if (stored.credential) {
      try {
        if (!this.safeStorage.isEncryptionAvailable()) throw new Error('system encryption unavailable');
        const key = this.safeStorage.decryptString(Buffer.from(stored.credential, 'base64'));
        this.data.settings ||= {};
        this.data.settings.custom ||= {};
        this.data.settings.custom.apiKey = key;
      } catch (_) {
        this.warning = '无法解密原有 API Key，可能更换了 Windows 账户。请在设置中重新输入；文档库不受影响。';
      }
    }
  }

  get(keys, publicOnly = false) {
    const selected = {};
    if (keys == null) Object.assign(selected, this.data);
    else if (typeof keys === 'string') selected[keys] = this.data[keys];
    else if (Array.isArray(keys)) for (const key of keys) selected[key] = this.data[key];
    else for (const [key, fallback] of Object.entries(keys)) selected[key] = this.data[key] ?? fallback;
    const output = structuredClone(selected);
    if (publicOnly && output.settings) output.settings = redacted(output.settings);
    return output;
  }

  set(patch) {
    const task = this.pending.then(async () => {
      const next = { ...this.data, ...structuredClone(patch) };
      const data = structuredClone(next);
      const key = data.settings?.custom?.apiKey || '';
      if (data.settings?.custom) delete data.settings.custom.apiKey;
      let credential = '';
      if (key) {
        if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，不能安全保存 API Key');
        credential = this.safeStorage.encryptString(key).toString('base64');
      }
      const serialized = JSON.stringify({ version: 1, data, credential });
      const temporary = this.filename + '.pending';
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.filename);
      const changes = {};
      for (const name of Object.keys(patch)) changes[name] = { oldValue: this.data[name], newValue: next[name] };
      this.data = next;
      return structuredClone(changes);
    });
    this.pending = task.catch(() => {});
    return task;
  }

  publicChanges(changes) {
    const output = structuredClone(changes);
    if (output.settings) {
      output.settings.oldValue = redacted(output.settings.oldValue);
      output.settings.newValue = redacted(output.settings.newValue);
    }
    return output;
  }
}

module.exports = { SecureStore, redacted };
