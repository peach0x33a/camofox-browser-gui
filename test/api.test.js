import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-api-test-'));
const previous = process.env.CAMOFOX_GUI_DATA_DIR;
process.env.CAMOFOX_GUI_DATA_DIR = root;
const { Store } = await import('../src/store.js');
const { Manager } = await import('../src/manager.js');
const { createApi } = await import('../src/api.js');
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CAMOFOX_GUI_DATA_DIR; else process.env.CAMOFOX_GUI_DATA_DIR = previous;
});

async function setup(t) {
  const store = new Store(path.join(root, 'config-' + Math.random() + '.json'));
  const manager = new Manager(store); const api = createApi({ store, manager });
  const server = http.createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { manager.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const request = async (method, route, body, status = 200) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  return { store, request };
}

test('per-profile front proxy round-trips, masks passwords and survives unrelated edits', async (t) => {
  const { store, request } = await setup(t);
  let data = await request('POST', '/api/profiles', { name: 'front', proxyMode: 'none', upstreamProxy: {
    enabled: true, scheme: 'socks5', host: '127.0.0.1', port: '1080', username: 'user', password: 'test-only-secret',
  } });
  const id = data.profile.id;
  assert.equal(data.profile.upstreamProxy.password, '••••••');
  assert.ok(!JSON.stringify(data).includes('test-only-secret'));
  assert.equal(store.getProfile(id).upstreamProxy.password, 'test-only-secret');
  data = await request('PATCH', '/api/profiles/' + id, { name: 'renamed', upstreamProxy: { ...data.profile.upstreamProxy, port: '1081' } });
  assert.equal(store.getProfile(id).upstreamProxy.password, 'test-only-secret');
  assert.equal(new Store(store.file).getProfile(id).upstreamProxy.port, '1081');
  await request('PATCH', '/api/profiles/' + id, { note: 'keep front' });
  assert.equal(store.getProfile(id).upstreamProxy.enabled, true);
  await request('PATCH', '/api/profiles/' + id, { upstreamProxy: { ...data.profile.upstreamProxy, enabled: false } });
  assert.equal(store.getProfile(id).upstreamProxy.enabled, false);
});

test('new and legacy profiles default to disabled front proxy; invalid enabled settings are rejected', async (t) => {
  const { store, request } = await setup(t);
  const data = await request('POST', '/api/profiles', { name: 'legacy' });
  assert.equal(data.profile.upstreamProxy.enabled, false);
  delete store.getProfile(data.profile.id).upstreamProxy; store.save();
  assert.equal(new Store(store.file).getProfile(data.profile.id).upstreamProxy.enabled, false);
  await request('POST', '/api/profiles', { name: 'invalid', upstreamProxy: { enabled: true, host: '', port: '0' } }, 400);
  assert.equal(store.profiles.length, 1);
});

test('independent ordered chains can nest and copy, with visibility, dependency and cycle guards', async (t) => {
  const { store, request } = await setup(t);
  const create = async (name, showInList = true) => (await request('POST', '/api/proxies', {
    node: { name, showInList, scheme: 'http', host: `${name.toLowerCase()}.example`, port: '8080', username: 'u', password: 'node-secret' },
  })).state.settings.proxies.at(-1);
  const a = await create('A', false);
  const b = await create('B');
  const c = await create('C');
  const link = (type, id) => ({ type, id });
  const first = (await request('POST', '/api/chains', {
    name: 'A-B', showInList: false, items: [link('node', a.id), link('node', b.id)],
  })).state.settings.chains.at(-1);
  const nested = (await request('POST', '/api/chains', {
    name: 'A-B-C', items: [link('chain', first.id), link('node', c.id)],
  })).state.settings.chains.at(-1);
  assert.deepEqual(nested.route, ['A', 'B', 'C']);
  assert.ok(!JSON.stringify(await request('GET', '/api/state')).includes('node-secret'));
  await request('POST', '/api/profiles', { name: 'hidden-node', proxyNodeId: a.id }, 400);
  await request('POST', '/api/profiles', { name: 'hidden-chain', proxyChainId: first.id }, 400);
  const profile = (await request('POST', '/api/profiles', { name: 'nested', proxyChainId: nested.id })).profile;
  assert.equal(profile.proxyLabel, 'A → B → C');
  assert.equal(profile.proxyMode, 'chain');
  await request('PATCH', '/api/chains/' + nested.id, { showInList: false }, 400);
  await request('PATCH', '/api/chains/' + first.id, { items: [link('chain', nested.id)] }, 400);
  await request('POST', '/api/chains', { name: 'missing', items: [link('node', 'missing')] }, 400);
  await request('DELETE', '/api/proxies/' + a.id, undefined, 400);
  await request('DELETE', '/api/chains/' + first.id, undefined, 400);
  await request('DELETE', '/api/chains/' + nested.id, undefined, 400);
  const changed = await request('PATCH', '/api/proxies/' + b.id, { name: 'B2', password: '••••••' });
  assert.equal(store.settings.proxies.find((p) => p.id === b.id).password, 'node-secret');
  assert.deepEqual(changed.state.settings.chains.find((p) => p.id === nested.id).route, ['A', 'B2', 'C']);
  assert.equal(new Store(store.file).resolveChain(nested.id).length, 3);
  const copies = await request('POST', `/api/chains/${nested.id}/copy`, { count: 2 });
  assert.equal(copies.created, 2);
  assert.deepEqual(copies.state.settings.chains.at(-1).route, ['A', 'B2', 'C']);
  assert.equal((await request('POST', `/api/proxies/${a.id}/copy`, { count: 3 })).created, 3);
  await request('POST', `/api/proxies/${a.id}/copy`, { count: 201 }, 400);
  await request('PATCH', `/api/proxies/${a.id}`, { upstreamId: b.id }, 400);
});

test('version 2 node upstream paths migrate to explicit chains and keep selected routes', async (t) => {
  const file = path.join(root, 'v2-' + Math.random() + '.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, settings: { proxies: [
    { id: 'xa', name: 'A', scheme: 'http', host: 'a.example', port: '8080', username: 'u', password: 'secret' },
    { id: 'xb', name: 'B', scheme: 'socks5', host: 'b.example', port: '1080', upstreamId: 'xa' },
  ] }, profiles: [{ id: 'p1', name: 'old', proxyMode: 'node', proxyNodeId: 'xb' }] }));
  const store = new Store(file);
  const profile = store.getProfile('p1');
  assert.equal(profile.proxyMode, 'chain');
  assert.deepEqual(store.effectiveProxyChain(profile).map((node) => node.name), ['A', 'B']);
  assert.equal(new Store(file).effectiveProxyChain(profile)[0].password, 'secret');
  assert.ok(!store.settings.proxies.some((node) => node.upstreamId));
});

test('URL presets persist, normalize scheme-less URLs and reject unsafe schemes', async (t) => {
  const { store, request } = await setup(t);
  const data = await request('POST', '/api/url-presets', { url: 'chatgpt.com' });
  assert.equal(data.url, 'https://chatgpt.com/');
  assert.deepEqual(new Store(store.file).settings.urlPresets, ['https://chatgpt.com/']);
  await request('POST', '/api/url-presets', { url: 'javascript:alert(1)' }, 400);
  await request('POST', '/api/url-presets', { url: 'https://user:pass@example.com' }, 400);
  await request('DELETE', '/api/url-presets?url=https%3A%2F%2Fchatgpt.com%2F');
  assert.deepEqual(store.settings.urlPresets, []);
});

test('old profile proxy and front proxy migrate to linked nodes without losing credentials', async (t) => {
  const file = path.join(root, 'legacy-' + Math.random() + '.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { proxies: [{ id: 'xglobal', scheme: 'http', host: 'global.example', port: '8888' }], proxyId: 'xglobal' }, profiles: [
    { id: 'p1', name: 'old-global', proxyMode: 'global', upstreamProxy: { enabled: true, scheme: 'socks5', host: 'front.example', port: '1080', username: 'u', password: 'front-secret' } },
    { id: 'p2', name: 'old-custom', proxyMode: 'custom', proxy: { scheme: 'https', host: 'exit.example', port: '443', password: 'exit-secret', username: 'u' } },
  ] }));
  const store = new Store(file);
  assert.deepEqual(store.effectiveProxyChain(store.getProfile('p1')).map((p) => p.host), ['front.example', 'global.example']);
  assert.deepEqual(store.effectiveProxyChain(store.getProfile('p2')).map((p) => p.host), ['exit.example']);
  assert.equal(store.effectiveProxyChain(store.getProfile('p1'))[0].password, 'front-secret');
  assert.equal(new Store(file).effectiveProxyChain(store.getProfile('p2'))[0].password, 'exit-secret');
});
