/**
 * Persisted GUI state: global settings + the profile list.
 *
 * One JSON file (~/.camofox-gui/config.json), written atomically. Runtime state
 * (process handles, logs, status) lives in the manager and is never persisted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, DATA_DIR, detectCamofoxDir, ensureDataDirs, profileDataDir } from './paths.js';
import { hasProxy, normalizeProxy, validateProxy } from './proxy.js';

/**
 * Identity of a proxy for de-duplication: everything except the generated id.
 * JSON-encoded rather than joined with a separator, so no field value can be
 * crafted to collide with another (and the source stays plain ASCII).
 */
function describeProxyKey(proxy) {
  const p = normalizeProxy(proxy);
  return JSON.stringify([p.scheme, p.host, p.port, p.username, p.password]);
}

export const MODES = ['visible', 'headless'];
export const PROXY_MODES = ['global', 'custom', 'none'];

const DEFAULT_START_URL = 'https://abrahamjuliot.github.io/creepjs/';

function defaultSettings() {
  return {
    camofoxDir: detectCamofoxDir(),
    basePort: 9400,
    startUrl: DEFAULT_START_URL,
    defaultMode: 'visible',
    // camofox-browser reports anonymized crashes to a relay by default; the GUI
    // opts out so a local desktop tool makes no unexpected network calls.
    crashReport: false,
    // A pool of saved proxies plus the one currently acting as "the global
    // proxy"; profiles with proxyMode 'global' follow whichever is selected.
    proxies: [],
    proxyId: '',
  };
}

function newId() {
  return `p${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function newProxyId() {
  return `x${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export class Store {
  constructor(file = CONFIG_FILE) {
    this.file = file;
    this.data = { version: 1, settings: defaultSettings(), profiles: [] };
    this.load();
  }

  load() {
    ensureDataDirs();
    let migrated = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        version: 1,
        settings: { ...defaultSettings(), ...(parsed.settings || {}) },
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles.map((p) => this.#normalizeProfile(p)) : [],
      };
      migrated = this.#migrateProxySettings(parsed.settings || {});
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Keep a copy rather than silently overwriting a config we failed to read.
        try {
          fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch { /* nothing to preserve */ }
      }
      this.save();
    }
    if (!this.data.settings.camofoxDir) {
      this.data.settings.camofoxDir = detectCamofoxDir();
    }
    if (migrated) this.save();
    return this.data;
  }

  save() {
    ensureDataDirs();
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Bring older configs forward: the single `settings.proxy` object became a
   * list plus a selected id. The old value is kept as the first entry and
   * stays active, so an upgrade never silently drops a working proxy.
   */
  #migrateProxySettings(rawSettings) {
    const settings = this.data.settings;
    let changed = false;

    settings.proxies = Array.isArray(settings.proxies)
      ? settings.proxies.map((entry) => ({ ...normalizeProxy(entry), id: entry?.id || newProxyId() }))
      : [];

    const legacy = normalizeProxy(rawSettings.proxy);
    if (hasProxy(legacy) && !settings.proxies.some((p) => describeProxyKey(p) === describeProxyKey(legacy))) {
      const entry = { ...legacy, id: newProxyId() };
      settings.proxies.unshift(entry);
      if (!settings.proxyId) settings.proxyId = entry.id;
      changed = true;
    }
    if ('proxy' in settings) {
      delete settings.proxy;
      changed = true;
    }
    if (settings.proxyId && !settings.proxies.some((p) => p.id === settings.proxyId)) {
      settings.proxyId = '';
      changed = true;
    }

    // Persist right away so the on-disk shape matches what the code expects,
    // instead of re-deriving it on every start.
    return changed;
  }

  get settings() {
    return this.data.settings;
  }

  /** The saved proxy currently acting as the global one, or null. */
  activeProxy() {
    const entry = this.data.settings.proxies.find((p) => p.id === this.data.settings.proxyId);
    return entry && hasProxy(entry) ? normalizeProxy(entry) : null;
  }

  /** @returns {{added: object[], duplicates: object[]}} — added excludes rows that already existed. */
  addProxies(inputs = []) {
    const added = [];
    const duplicates = [];
    for (const input of inputs) {
      const proxy = normalizeProxy(input);
      const error = validateProxy(proxy);
      if (error) throw new Error(error);
      const key = describeProxyKey(proxy);
      const existing = this.data.settings.proxies.find((p) => describeProxyKey(p) === key);
      if (existing) {
        duplicates.push(existing); // de-duplicate rather than pile up identical rows
        continue;
      }
      const entry = { ...proxy, id: newProxyId() };
      this.data.settings.proxies.push(entry);
      added.push(entry);
    }
    const first = added[0] || duplicates[0];
    if (!this.data.settings.proxyId && first) this.data.settings.proxyId = first.id;
    this.save();
    return { added, duplicates };
  }

  updateProxy(id, patch = {}) {
    const index = this.data.settings.proxies.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('代理不存在');
    const merged = normalizeProxy({ ...this.data.settings.proxies[index], ...patch });
    const error = validateProxy(merged);
    if (error) throw new Error(error);
    this.data.settings.proxies[index] = { ...merged, id };
    this.save();
    return this.data.settings.proxies[index];
  }

  deleteProxy(id) {
    const index = this.data.settings.proxies.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('代理不存在');
    const [removed] = this.data.settings.proxies.splice(index, 1);
    // Deleting the active proxy falls back to the first remaining one rather
    // than silently leaving every 'global' profile with no proxy at all.
    if (this.data.settings.proxyId === id) {
      this.data.settings.proxyId = this.data.settings.proxies[0]?.id || '';
    }
    this.save();
    return removed;
  }

  setActiveProxy(id) {
    if (id && !this.data.settings.proxies.some((p) => p.id === id)) throw new Error('代理不存在');
    this.data.settings.proxyId = id || '';
    this.save();
    return this.data.settings.proxyId;
  }

  get profiles() {
    return this.data.profiles;
  }

  updateSettings(patch = {}) {
    const next = { ...this.data.settings };
    if (typeof patch.camofoxDir === 'string') next.camofoxDir = patch.camofoxDir.trim();
    if (typeof patch.startUrl === 'string') {
      const startUrl = patch.startUrl.trim();
      // Same rule as per-profile start URLs: a scheme-less value here would
      // pass silently and then fail every profile that falls back to it,
      // but only after the browser has fully launched.
      if (startUrl && !/^https?:\/\//i.test(startUrl)) {
        throw new Error('默认起始网址必须以 http:// 或 https:// 开头');
      }
      next.startUrl = startUrl;
    }
    if (MODES.includes(patch.defaultMode)) next.defaultMode = patch.defaultMode;
    if (typeof patch.crashReport === 'boolean') next.crashReport = patch.crashReport;
    if (patch.basePort !== undefined) {
      const port = Number(patch.basePort);
      if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new Error('起始端口需在 1024-65000 之间');
      next.basePort = port;
    }
    if (patch.proxyId !== undefined) {
      const id = String(patch.proxyId || '');
      if (id && !next.proxies.some((p) => p.id === id)) throw new Error('代理不存在');
      next.proxyId = id;
    }
    this.data.settings = next;
    this.save();
    return next;
  }

  getProfile(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  /** Lowest free port at or above basePort, skipping ports already claimed. */
  allocatePort(taken = new Set()) {
    const used = new Set(this.data.profiles.map((p) => p.port).filter(Boolean));
    for (const port of taken) used.add(port);
    let port = this.data.settings.basePort;
    while (used.has(port)) port += 1;
    if (port > 65535) throw new Error('没有可用端口了');
    return port;
  }

  uniqueName(desired, taken = new Set()) {
    const base = String(desired || 'profile').trim() || 'profile';
    const used = new Set(this.data.profiles.map((p) => p.name));
    for (const name of taken) used.add(name);
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  /** Validate an explicitly requested port against range and existing claims. */
  #validatePort(value, exceptId = null, taken = new Set()) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需在 1024-65535 之间');
    const clash = this.data.profiles.some((p) => p.id !== exceptId && p.port === port) || taken.has(port);
    if (clash) throw new Error(`端口已被其他 profile 占用: ${port}`);
    return port;
  }

  #normalizeProfile(input, { port, name } = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    const proxyMode = PROXY_MODES.includes(raw.proxyMode) ? raw.proxyMode : 'global';
    return {
      id: raw.id || newId(),
      name: String(name ?? raw.name ?? '').trim() || 'profile',
      port: Number(port ?? raw.port) || 0,
      mode: MODES.includes(raw.mode) ? raw.mode : this.data.settings.defaultMode,
      proxyMode,
      proxy: normalizeProxy(raw.proxy),
      startUrl: String(raw.startUrl ?? '').trim(),
      note: String(raw.note ?? '').trim(),
      createdAt: raw.createdAt || new Date().toISOString(),
    };
  }

  #validateProfile(profile) {
    if (profile.proxyMode === 'custom') {
      const error = validateProxy(profile.proxy);
      if (error) throw new Error(`${profile.name}: ${error}`);
    }
    if (profile.startUrl && !/^https?:\/\//i.test(profile.startUrl)) {
      throw new Error(`${profile.name}: 起始网址必须以 http:// 或 https:// 开头`);
    }
  }

  createProfile(input = {}) {
    return this.createProfiles([input])[0];
  }

  /** Create many at once so batch imports get unique names/ports in one pass. */
  createProfiles(inputs = []) {
    const takenNames = new Set();
    const takenPorts = new Set();
    const created = inputs.map((input) => {
      const name = this.uniqueName(input.name, takenNames);
      takenNames.add(name);
      const port = input.port ? this.#validatePort(input.port, null, takenPorts) : this.allocatePort(takenPorts);
      takenPorts.add(port);
      const profile = this.#normalizeProfile(input, { port, name });
      this.#validateProfile(profile);
      return profile;
    });
    this.data.profiles.push(...created);
    this.save();
    return created;
  }

  updateProfile(id, patch = {}) {
    const index = this.data.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('profile 不存在');
    const current = this.data.profiles[index];
    const merged = { ...current, ...patch, id: current.id, createdAt: current.createdAt };

    if (patch.name !== undefined) {
      const desired = String(patch.name).trim();
      if (!desired) throw new Error('名称不能为空');
      const clash = this.data.profiles.some((p) => p.id !== id && p.name === desired);
      if (clash) throw new Error(`名称已存在: ${desired}`);
      merged.name = desired;
    }
    if (patch.port !== undefined) {
      merged.port = this.#validatePort(patch.port, id);
    }

    const profile = this.#normalizeProfile(merged, { port: merged.port, name: merged.name });
    this.#validateProfile(profile);
    this.data.profiles[index] = profile;
    this.save();
    return profile;
  }

  deleteProfile(id, { purge = false } = {}) {
    const index = this.data.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('profile 不存在');
    const [removed] = this.data.profiles.splice(index, 1);
    this.save();
    if (purge) {
      const dir = profileDataDir(removed.id);
      // Guard against a malformed id escaping the data directory.
      if (path.resolve(dir).startsWith(path.resolve(DATA_DIR) + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return removed;
  }

  /** The proxy a profile actually launches with, after resolving 'global'. */
  effectiveProxy(profile) {
    if (profile.proxyMode === 'none') return null;
    if (profile.proxyMode === 'custom') {
      return hasProxy(profile.proxy) ? normalizeProxy(profile.proxy) : null;
    }
    return this.activeProxy();
  }

  effectiveStartUrl(profile) {
    return profile.startUrl || this.data.settings.startUrl || DEFAULT_START_URL;
  }
}
