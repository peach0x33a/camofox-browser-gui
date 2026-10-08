import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Manager } from '../src/manager.js';
import { mockProxy } from './helpers/proxies.js';

async function fixture(t, { mode = 'visible', front = null, exit = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-manager-test-'));
  for (const dir of ['lib', 'node_modules', 'plugins/desktop']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib/config.js'), '');
  fs.writeFileSync(path.join(root, 'plugins/desktop/index.js'), '// fake plugin');
  fs.writeFileSync(path.join(root, 'plugins/desktop/plugin.json'), '{"guiProtocol":3}');
  fs.writeFileSync(path.join(root, 'plugins/desktop/window-size.js'), '');
  fs.writeFileSync(path.join(root, 'plugins/desktop/lifecycle.js'), '// fake lifecycle');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('./fixtures/fake-browser-server.js', import.meta.url), path.join(root, 'server.js'));
  const previous = process.env.CAMOUFOX_EXECUTABLE; process.env.CAMOUFOX_EXECUTABLE = process.execPath;
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const profile = { id: 'ptest', name: 'fixture', mode, port, upstreamProxy: front };
  const store = {
    profiles: [profile], settings: { camofoxDir: root, basePort: port, crashReport: false },
    getProfile: () => profile, effectiveProxy: () => null, effectiveStartUrl: () => 'https://example.com',
    effectiveProxyChain: () => front ? [front, exit].filter(Boolean) : [],
    updateProfile: (_, patch) => Object.assign(profile, patch),
  };
  const manager = new Manager(store);
  t.after(async () => {
    manager.dispose(); await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CAMOUFOX_EXECUTABLE; else process.env.CAMOUFOX_EXECUTABLE = previous;
  });
  const requests = () => fs.readFileSync(path.join(root, 'requests.log'), 'utf8').trim().split('\n');
  return { manager, profile, requests, port, root };
}
async function waitUntil(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) assert.fail('condition timed out'); await new Promise((r) => setTimeout(r, 10)); }
}

test('window-close IPC stops process without health recovery or session-close requests', { timeout: 10000 }, async (t) => {
  const { manager, profile, requests, port } = await fixture(t);
  await manager.start(profile.id);
  // Editing config must not change the lifetime policy of an already running instance.
  profile.mode = 'headless';
  await fetch('http://127.0.0.1:' + port + '/control/close');
  await waitUntil(() => manager.statusOf(profile.id).status === 'stopped');
  assert.equal(manager.runner(profile.id).proc, null);
  assert.ok(requests().includes('GET /desktop/status'));
  assert.ok(!requests().some((r) => r.includes('/health') || r.startsWith('DELETE')));
});

test('passive poll catches close without IPC and never calls recovering health endpoint', { timeout: 10000 }, async (t) => {
  const { manager, profile, requests, port } = await fixture(t);
  await manager.start(profile.id);
  await fetch('http://127.0.0.1:' + port + '/control/noipc');
  await waitUntil(() => manager.statusOf(profile.id).status === 'stopped', 6500);
  assert.ok(!requests().some((r) => r.includes('/health') || r.startsWith('DELETE')));
});

test('headless stop checkpoints session and releases its per-launch relay', { timeout: 10000 }, async (t) => {
  const front = await mockProxy(t, 'http');
  const exit = await mockProxy(t, 'socks5');
  const { manager, profile, requests, port } = await fixture(t, { mode: 'headless', front: front.proxy, exit: exit.proxy });
  await manager.start(profile.id);
  const relay = manager.runner(profile.id).proxyRelay;
  assert.ok(relay);
  const env = await (await fetch('http://127.0.0.1:' + port + '/env')).json();
  assert.equal(env.host, '127.0.0.1'); assert.equal(env.port, relay.proxy.port);
  await Promise.all([manager.stop(profile.id), manager.stop(profile.id)]);
  assert.equal(requests().filter((r) => r.startsWith('DELETE /sessions/')).length, 1);
  assert.equal(manager.runner(profile.id).proxyRelay, null);
  await assert.rejects(fetch('http://127.0.0.1:' + relay.proxy.port));
});

test('one selected node launches directly without a local relay', { timeout: 10000 }, async (t) => {
  const node = await mockProxy(t, 'http');
  const { manager, profile, port } = await fixture(t, { mode: 'headless', front: node.proxy });
  await manager.start(profile.id);
  assert.equal(manager.runner(profile.id).proxyRelay, null);
  const env = await (await fetch('http://127.0.0.1:' + port + '/env')).json();
  assert.equal(env.host, node.proxy.host);
  assert.equal(env.port, node.proxy.port);
});

test('stop during launch cancels it and permits a clean restart', { timeout: 10000 }, async (t) => {
  const { manager, profile } = await fixture(t);
  const starting = manager.start(profile.id);
  const rejected = assert.rejects(starting, /取消/);
  await waitUntil(() => manager.runner(profile.id).proc !== null);
  await manager.stop(profile.id); await rejected;
  assert.equal(manager.statusOf(profile.id).status, 'stopped');
  assert.equal(manager.runner(profile.id).proc, null);
  await manager.start(profile.id); assert.equal(manager.statusOf(profile.id).status, 'running');
});

test('spawn failure releases resources without waiting for an exit event that never arrives', { timeout: 5000 }, async (t) => {
  const { manager, profile, root } = await fixture(t);
  manager.once('status', () => fs.renameSync(root, root + '-moved'));
  try {
    await assert.rejects(manager.start(profile.id), /ENOENT/);
    assert.equal(manager.statusOf(profile.id).status, 'error');
    assert.equal(manager.runner(profile.id).proc, null);
  } finally {
    if (fs.existsSync(root + '-moved')) fs.renameSync(root + '-moved', root);
  }
});
