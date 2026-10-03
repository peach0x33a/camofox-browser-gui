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
import { describeProxy, hasProxy, normalizeProxy, validateProxy } from './proxy.js';

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
export const PROXY_MODES = ['global', 'custom', 'none', 'node', 'chain'];

const DEFAULT_START_URL = 'https://abrahamjuliot.github.io/creepjs/';

export function normalizeOpenUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('请输入网址');
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error('网址格式不正确'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('只支持不含账号密码的 HTTP/HTTPS 网址');
  }
  return parsed.href;
}

function defaultSettings() {
  return {
    camofoxDir: detectCamofoxDir(),
    basePort: 9400,
    startUrl: DEFAULT_START_URL,
    defaultMode: 'visible',
    urlPresets: [],
    // camofox-browser reports anonymized crashes to a relay by default; the GUI
    // opts out so a local desktop tool makes no unexpected network calls.
    crashReport: false,
    proxies: [],
    chains: [],
    proxyId: '',
  };
}

function newId() {
  return `p${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function newProxyId() {
  return `x${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function newChainId() {
  return `c${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export class Store {
  constructor(file = CONFIG_FILE) {
    this.file = file;
    this.data = { version: 3, settings: defaultSettings(), profiles: [] };
    this.load();
  }

  load() {
    ensureDataDirs();
    let migrated = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        version: 3,
        settings: { ...defaultSettings(), ...(parsed.settings || {}) },
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles.map((p) => this.#normalizeProfile(p)) : [],
      };
      this.data.settings.urlPresets = Array.isArray(this.data.settings.urlPresets)
        ? [...new Set(this.data.settings.urlPresets.flatMap((url) => {
          try { return [normalizeOpenUrl(url)]; } catch { return []; }
        }))]
        : [];
      migrated = this.#migrateProxySettings(parsed.settings || {});
      if ((parsed.version || 1) < 2) {
        this.#migrateProfileNodes();
        migrated = true;
      }
      if ((parsed.version || 1) < 3) {
        this.#migrateLegacyChains();
        migrated = true;
      } else {
        this.data.settings.chains = Array.isArray(this.data.settings.chains) ? this.data.settings.chains : [];
        this.data.settings.proxies = this.data.settings.proxies.map(({ upstreamId, ...node }) => node);
      }
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
   * Bring older configs forward, preserving their saved proxy credentials.
   */
  #migrateProxySettings(rawSettings) {
    const settings = this.data.settings;
    let changed = false;

    settings.proxies = Array.isArray(settings.proxies)
      ? settings.proxies.map((entry) => ({
        ...normalizeProxy(entry), id: entry?.id || newProxyId(),
        name: String(entry?.name || describeProxy(entry)).trim(),
        upstreamId: String(entry?.upstreamId || ''),
        showInList: entry?.showInList !== false,
      }))
      : [];

    const legacy = normalizeProxy(rawSettings.proxy);
    if (hasProxy(legacy) && !settings.proxies.some((p) => describeProxyKey(p) === describeProxyKey(legacy))) {
      const entry = { ...legacy, id: newProxyId(), name: describeProxy(legacy), upstreamId: '', showInList: true };
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

  /** Preserve old inline and per-instance front proxies as editable nodes. */
  #migrateProfileNodes() {
    const nodes = this.data.settings.proxies;
    const ensure = (proxy, upstreamId = '', name = '') => {
      const key = describeProxyKey(proxy);
      const existing = nodes.find((p) => describeProxyKey(p) === key && p.upstreamId === upstreamId);
      if (existing) return existing.id;
      const node = { ...normalizeProxy(proxy), id: newProxyId(), name: name || describeProxy(proxy), upstreamId, showInList: true };
      nodes.push(node);
      return node.id;
    };
    for (const profile of this.data.profiles) {
      const front = hasProxy(profile.upstreamProxy) ? ensure(profile.upstreamProxy) : '';
      const exit = profile.proxyMode === 'custom' ? profile.proxy :
        profile.proxyMode === 'global' ? this.activeProxy() : null;
      profile.proxyNodeId = exit && hasProxy(exit)
        ? ensure(exit, front, profile.name + ' · 代理') : front;
      profile.proxyMode = profile.proxyNodeId ? 'node' : 'none';
      profile.proxy = normalizeProxy({ enabled: false });
      profile.upstreamProxy = { ...normalizeProxy({ enabled: false }), enabled: false };
    }
  }

  /** Turn the old per-node upstream pointers into explicit, independently editable chains. */
  #migrateLegacyChains() {
    const settings = this.data.settings;
    settings.chains = [];
    const oldNodes = settings.proxies.map((node) => ({ ...node }));
    const byId = new Map(oldNodes.map((node) => [node.id, node]));
    const migrated = new Map();
    const pathTo = (id, seen = new Set()) => {
      if (seen.has(id)) throw new Error('旧代理节点存在环路');
      const node = byId.get(id);
      if (!node) throw new Error('旧代理链路引用了不存在的节点');
      return node.upstreamId ? [...pathTo(node.upstreamId, new Set([...seen, id])), id] : [id];
    };
    for (const node of oldNodes) {
      if (node.upstreamId) {
        const chain = {
          id: newChainId(), name: `${node.name} · 旧链路`,
          showInList: node.showInList, items: pathTo(node.id).map((id) => ({ type: 'node', id })),
        };
        settings.chains.push(chain);
        migrated.set(node.id, chain.id);
      }
    }
    settings.proxies = settings.proxies.map(({ upstreamId, ...node }) => node);
    for (const profile of this.data.profiles) {
      if (profile.proxyMode === 'node' && migrated.has(profile.proxyNodeId)) {
        profile.proxyChainId = migrated.get(profile.proxyNodeId);
        profile.proxyMode = 'chain';
        profile.proxyNodeId = '';
      }
    }
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
      const entry = { ...proxy, id: newProxyId(), name: describeProxy(proxy), showInList: true };
      this.data.settings.proxies.push(entry);
      added.push(entry);
    }
    const first = added[0] || duplicates[0];
    if (!this.data.settings.proxyId && first) this.data.settings.proxyId = first.id;
    this.save();
    return { added, duplicates };
  }

  addProxyNode(input = {}) {
    const proxy = normalizeProxy(input);
    const error = validateProxy(proxy);
    if (error) throw new Error(error);
    const name = String(input.name || '').trim();
    if (!name) throw new Error('节点名称不能为空');
    if (input.upstreamId !== undefined) throw new Error('请在代理链路中组合节点');
    const entry = {
      ...proxy, id: newProxyId(), name,
      showInList: input.showInList !== false,
    };
    this.data.settings.proxies.push(entry);
    this.save();
    return entry;
  }

  updateProxy(id, patch = {}) {
    const index = this.data.settings.proxies.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('代理不存在');
    const previous = this.data.settings.proxies[index];
    const merged = normalizeProxy({ ...previous, ...patch });
    const error = validateProxy(merged);
    if (error) throw new Error(error);
    const name = String(patch.name ?? previous.name).trim();
    if (!name) throw new Error('节点名称不能为空');
    if (patch.upstreamId !== undefined) throw new Error('请在代理链路中组合节点');
    const showInList = patch.showInList === undefined ? previous.showInList !== false : patch.showInList === true;
    if (!showInList && this.data.profiles.some((p) => p.proxyMode === 'node' && p.proxyNodeId === id)) {
      throw new Error('已有实例使用此节点，请先切换实例代理再隐藏');
    }
    const candidate = { ...merged, id, name, showInList };
    this.data.settings.proxies[index] = candidate;
    this.save();
    return this.data.settings.proxies[index];
  }

  deleteProxy(id) {
    const index = this.data.settings.proxies.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('代理不存在');
    if (this.data.settings.chains.some((c) => c.items.some((item) => item.type === 'node' && item.id === id))) throw new Error('此节点已被链路使用，请先调整链路');
    if (this.data.profiles.some((p) => p.proxyMode === 'node' && p.proxyNodeId === id)) throw new Error('已有实例使用此节点，请先切换实例代理');
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

  resolveProxyChain(id) {
    if (!id) return [];
    const node = this.data.settings.proxies.find((p) => p.id === id);
    if (!node) throw new Error('代理节点不存在');
    const error = validateProxy(node);
    if (error) throw new Error(`${node.name}: ${error}`);
    return [node];
  }

  resolveChain(id, chains = this.data.settings.chains, seen = new Set()) {
    if (seen.has(id)) throw new Error('代理链路不能形成环路');
    const chain = chains.find((entry) => entry.id === id);
    if (!chain) throw new Error('代理链路不存在');
    if (!Array.isArray(chain.items) || !chain.items.length) throw new Error('代理链路至少需要一个节点或链路');
    const next = new Set([...seen, id]);
    const route = chain.items.flatMap((item) => {
      if (item.type === 'node') return this.resolveProxyChain(item.id);
      if (item.type === 'chain') return this.resolveChain(item.id, chains, next);
      throw new Error('代理链路组件类型无效');
    });
    if (route.length > 32) throw new Error('展开后的链路不能超过 32 个节点');
    return route;
  }

  #chainInput(input, id = newChainId()) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('链路名称不能为空');
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('请至少添加一个节点或链路');
    if (input.items.length > 32) throw new Error('链路最多包含 32 个组件');
    const items = input.items.map((item) => ({ type: item?.type, id: String(item?.id || '') }));
    if (items.some((item) => !['node', 'chain'].includes(item.type) || !item.id)) throw new Error('链路组件无效');
    return { id, name, items, showInList: input.showInList !== false };
  }

  addChain(input = {}) {
    const chain = this.#chainInput(input);
    this.resolveChain(chain.id, [...this.data.settings.chains, chain]);
    this.data.settings.chains.push(chain);
    this.save();
    return chain;
  }

  updateChain(id, patch = {}) {
    const index = this.data.settings.chains.findIndex((c) => c.id === id);
    if (index < 0) throw new Error('代理链路不存在');
    const previous = this.data.settings.chains[index];
    const chain = this.#chainInput({ ...previous, ...patch }, id);
    if (!chain.showInList && this.data.profiles.some((p) => p.proxyMode === 'chain' && p.proxyChainId === id)) {
      throw new Error('已有实例使用此链路，请先切换实例代理再隐藏');
    }
    const chains = [...this.data.settings.chains];
    chains[index] = chain;
    for (const entry of chains) this.resolveChain(entry.id, chains);
    this.data.settings.chains[index] = chain;
    this.save();
    return chain;
  }

  deleteChain(id) {
    const index = this.data.settings.chains.findIndex((c) => c.id === id);
    if (index < 0) throw new Error('代理链路不存在');
    if (this.data.settings.chains.some((c) => c.items.some((item) => item.type === 'chain' && item.id === id))) throw new Error('此链路已被其他链路使用');
    if (this.data.profiles.some((p) => p.proxyMode === 'chain' && p.proxyChainId === id)) throw new Error('已有实例使用此链路');
    const [removed] = this.data.settings.chains.splice(index, 1);
    this.save();
    return removed;
  }

  copyProxy(id, count) {
    return this.#copyItems('proxies', id, count);
  }

  copyChain(id, count) {
    return this.#copyItems('chains', id, count);
  }

  #copyItems(kind, id, count) {
    const quantity = Number(count);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) throw new Error('复制数量需在 1-200 之间');
    const items = this.data.settings[kind];
    const source = items.find((item) => item.id === id);
    if (!source) throw new Error('对象不存在');
    const created = [];
    const names = new Set(items.map((item) => item.name));
    for (let index = 0; index < quantity; index++) {
      let suffix = 2;
      while (names.has(`${source.name} (${suffix})`)) suffix++;
      const name = `${source.name} (${suffix})`;
      names.add(name);
      created.push({ ...source, id: kind === 'chains' ? newChainId() : newProxyId(), name,
        ...(kind === 'chains' ? { items: source.items.map((item) => ({ ...item })) } : {}) });
    }
    items.push(...created);
    this.save();
    return created;
  }

  /** Snapshot the full ordered route at launch. Hidden components remain usable inside chains. */
  effectiveProxyChain(profile) {
    if (profile.proxyMode === 'node') return this.resolveProxyChain(profile.proxyNodeId);
    if (profile.proxyMode === 'chain') return this.resolveChain(profile.proxyChainId);
    const front = hasProxy(profile.upstreamProxy) ? [normalizeProxy(profile.upstreamProxy)] : [];
    const exit = this.effectiveProxy(profile);
    return exit ? [...front, exit] : front;
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

  addUrlPreset(value) {
    const url = normalizeOpenUrl(value);
    if (!this.data.settings.urlPresets.includes(url)) {
      if (this.data.settings.urlPresets.length >= 50) throw new Error('最多保存 50 个网址预设');
      this.data.settings.urlPresets.push(url);
      this.save();
    }
    return url;
  }

  removeUrlPreset(value) {
    const url = normalizeOpenUrl(value);
    this.data.settings.urlPresets = this.data.settings.urlPresets.filter((item) => item !== url);
    this.save();
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
      proxyNodeId: String(raw.proxyNodeId || ''),
      proxyChainId: String(raw.proxyChainId || ''),
      proxy: normalizeProxy(raw.proxy),
      upstreamProxy: { ...normalizeProxy(raw.upstreamProxy), enabled: raw.upstreamProxy?.enabled === true },
      startUrl: String(raw.startUrl ?? '').trim(),
      note: String(raw.note ?? '').trim(),
      createdAt: raw.createdAt || new Date().toISOString(),
    };
  }

  #validateProfile(profile) {
    if (profile.proxyMode === 'node') {
      const selected = this.data.settings.proxies.find((p) => p.id === profile.proxyNodeId);
      if (!selected || !selected.showInList) throw new Error(`${profile.name}: 请选择列表中展示的代理节点`);
      this.resolveProxyChain(selected.id);
    }
    if (profile.proxyMode === 'chain') {
      const selected = this.data.settings.chains.find((c) => c.id === profile.proxyChainId);
      if (!selected || !selected.showInList) throw new Error(`${profile.name}: 请选择列表中展示的代理链路`);
      this.resolveChain(selected.id);
    }
    if (profile.upstreamProxy.enabled) {
      const error = validateProxy(profile.upstreamProxy);
      if (error) throw new Error(profile.name + ': 前置代理 ' + error);
    }
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
    if (profile.proxyMode === 'node') return this.resolveProxyChain(profile.proxyNodeId).at(-1) || null;
    if (profile.proxyMode === 'chain') return this.resolveChain(profile.proxyChainId).at(-1) || null;
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
