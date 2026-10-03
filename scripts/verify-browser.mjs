#!/usr/bin/env node
/** Optional integration check using the companion checkout's browser dependencies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, detectCamofoxDir, camoufoxCacheDir } from '../src/paths.js';
import { register } from '../camofox-browser-plugin/desktop/index.js';
import { createProxyRelay } from '../src/proxy-chain.js';
import { listen, mockProxy } from '../test/helpers/proxies.js';

const upstream = detectCamofoxDir();
assert.ok(upstream, 'Set CAMOFOX_DIR to a camofox-browser checkout with installed dependencies');
const { chromium, firefox } = await import(pathToFileURL(path.join(upstream, 'node_modules/playwright-core/index.mjs')));
const { launchOptions } = await import(pathToFileURL(path.join(upstream, 'node_modules/camoufox-js/dist/index.js')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-browser-verify-'));
const captures = path.join(ROOT_DIR, '.impeccable', 'review'); fs.mkdirSync(captures, { recursive: true });
const cleanup = [];
const t = { after: (fn) => cleanup.push(fn) };
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise((r) => probe.close(r));
const gui = spawn(process.execPath, [path.join(ROOT_DIR, 'src/main.js'), '--port', String(port), '--no-open'], {
  env: { ...process.env, CAMOFOX_GUI_DATA_DIR: dataDir, CAMOFOX_DIR: upstream }, stdio: ['ignore', 'pipe', 'pipe'],
});
const guiExit = once(gui, 'exit');
let guiOutput = ''; gui.stdout.on('data', (c) => { guiOutput += c; }); gui.stderr.on('data', (c) => { guiOutput += c; });
let uiBrowser; let camoufox; let relay;
try {
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (gui.exitCode !== null) throw new Error(guiOutput);
    try { await fetch(base + '/api/state', { signal: AbortSignal.timeout(500) }); ready = true; break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, 'GUI startup');
  uiBrowser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await uiBrowser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  assert.equal(await page.locator('#tabProfiles').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#panelProfiles').isVisible(), true);
  assert.equal(await page.locator('#panelProxy').isHidden(), true);
  assert.equal(await page.locator('#panelChain').isHidden(), true);
  assert.equal(await page.locator('#panelTools').isHidden(), true);
  await page.screenshot({ path: path.join(captures, 'desktop-profiles.png'), fullPage: true });
  await page.locator('#tabProfiles').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tabProxy').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tabChain').getAttribute('aria-selected'), 'true');
  await page.locator('#tabProxy').click();
  await page.locator('#btnProxyAdd').click();
  await page.locator('#pxName').fill('前置 A');
  await page.locator('#pxShow').uncheck();
  await page.locator('#pxPaste').fill('socks5://fixture-user:fixture-password@127.0.0.1:1080');
  await page.locator('#pxPaste').press('Tab');
  await page.waitForFunction(() => document.getElementById('pxHost').value === '127.0.0.1');
  await page.locator('#btnSaveProxy').click();
  await page.locator('#proxyModal').waitFor({ state: 'hidden' });
  let state = await (await fetch(base + '/api/state')).json();
  const frontId = state.settings.proxies[0].id;
  assert.equal(state.settings.proxies[0].password, '••••••');
  await page.locator('#btnProxyAdd').click();
  await page.locator('#pxName').fill('出口 B');
  await page.locator('#pxHost').fill('127.0.0.1');
  await page.locator('#pxPort').fill('8080');
  await page.locator('#btnSaveProxy').click();
  await page.locator('#proxyModal').waitFor({ state: 'hidden' });
  state = await (await fetch(base + '/api/state')).json();
  const exitId = state.settings.proxies[1].id;
  await page.locator('#tabChain').click();
  await page.locator('#btnChainAdd').click();
  await page.locator('#chainName').fill('A → B');
  await page.locator('#btnChainItemNode').click();
  await page.locator('#chainItems select').nth(0).selectOption(frontId);
  await page.locator('#btnChainItemNode').click();
  await page.locator('#chainItems select').nth(1).selectOption(exitId);
  await page.locator('#btnSaveChain').click();
  await page.locator('#chainModal').waitFor({ state: 'hidden' });
  state = await (await fetch(base + '/api/state')).json();
  const firstChainId = state.settings.chains[0].id;
  assert.deepEqual(state.settings.chains[0].route, ['前置 A', '出口 B']);
  await page.locator('#btnChainAdd').click();
  await page.locator('#chainName').fill('嵌套链路');
  await page.locator('#btnChainItemChain').click();
  await page.locator('#chainItems select').first().selectOption(firstChainId);
  await page.locator('#btnSaveChain').click();
  await page.locator('#chainModal').waitFor({ state: 'hidden' });
  state = await (await fetch(base + '/api/state')).json();
  const nestedId = state.settings.chains[1].id;
  assert.deepEqual(state.settings.chains[1].route, ['前置 A', '出口 B']);
  await page.locator('#chainBody tr').nth(1).getByRole('button', { name: '复制' }).click();
  await page.locator('#copyCount').fill('2');
  await page.locator('#btnConfirmCopy').click();
  await page.locator('#copyModal').waitFor({ state: 'hidden' });
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.chains.length, 4);
  await page.locator('#tabProfiles').click();
  await page.locator('#btnNew').click();
  assert.equal(await page.locator('#pfProxyNode option').count(), 6); // none, B, four chains; A hidden
  await page.locator('#pfName').fill('验证实例');
  await page.locator('#pfProxyNode').selectOption(`chain:${nestedId}`);
  await page.locator('#btnSaveProfile').click();
  await page.locator('#profileModal').waitFor({ state: 'hidden' });
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.profiles[0].proxyLabel, '前置 A → 出口 B');
  assert.equal(state.profiles[0].proxyChainId, nestedId);
  await page.locator('#profileBody').getByRole('button', { name: '打开网址' }).click();
  await page.locator('#openUrlInput').fill('chatgpt.com');
  await page.locator('#btnSaveUrlPreset').click();
  await page.waitForFunction(() => document.querySelector('#openUrlPreset').value === 'https://chatgpt.com/');
  assert.equal(await page.locator('#openUrlPreset option').count(), 2);
  await page.locator('#openUrlModal [data-close-modal]').click();
  await page.locator('#tabTools').click();
  await page.evaluate(() => {
    window.originalNow = Date.now;
    window.totpTestNow = 59000;
    Date.now = () => window.totpTestNow;
  });
  await page.locator('#totpSecret').fill('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await page.waitForFunction(() => document.getElementById('totpCode').textContent === '287082');
  await page.locator('#btnAccountsImport').click();
  await page.locator('#accountsInput').fill('ellis@example.com----2r*nQ&XUnb&+39----4D77LPR63T4VAO7CZJK32NJNK3UKLPG7');
  await page.locator('#btnParseAccounts').click();
  assert.equal(await page.locator('#accountsBody tr').count(), 1);
  assert.equal(await page.locator('#panelTools progress').count(), 1);
  await page.waitForFunction(() => document.querySelector('#accountsBody td:last-child progress')?.value === 1);
  const previousAccountCode = await page.locator('#accountsBody td:last-child span').textContent();
  await page.evaluate(() => { window.totpTestNow = 60000; });
  await page.waitForFunction((previous) => document.querySelector('#accountsBody td:last-child progress')?.value === 30 && document.querySelector('#accountsBody td:last-child span').textContent !== previous, previousAccountCode);
  await page.evaluate(() => { Date.now = window.originalNow; });
  assert.equal(await page.locator('#accountsBody tr td').nth(1).locator('span').textContent(), '2r*nQ&XUnb&+39');
  await page.locator('#accountsBody tr td').nth(1).getByRole('button', { name: '复制' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '2r*nQ&XUnb&+39');
  await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('#accountsBody tr td:last-child span').textContent));
  await page.screenshot({ path: path.join(captures, 'desktop-tools.png'), fullPage: true });
  await page.locator('#tabChain').click();
  await page.screenshot({ path: path.join(captures, 'desktop-chain.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(captures, 'mobile-chain.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#tabTools').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.settings.proxies.find((p) => p.id === frontId).password, 'fixture-password');
  assert.equal(persisted.settings.urlPresets[0], 'https://chatgpt.com/');
  console.log('PASS UI: independent nested chains, copies, hidden nodes, URL presets, TOTP, account parser and responsive layout');
  await uiBrowser.close(); uiBrowser = null;

  const front = await mockProxy(t, 'socks5'); const exit = await mockProxy(t, 'http');
  const originPort = await listen(t, http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html'); res.end('<title>Local chain verification</title><p>Local-only fixture</p>');
  }));
  relay = await createProxyRelay({ upstreamProxy: front.proxy, proxy: exit.proxy });
  const options = await launchOptions({
    executable_path: process.env.CAMOUFOX_EXECUTABLE || path.join(camoufoxCacheDir(), 'camoufox-bin'),
    headless: !process.env.DISPLAY, virtual_display: process.env.DISPLAY,
    geoip: false, exclude_addons: ['UBO'],
  });
  const events = new EventEmitter(); let inspect;
  const previousDisplayFlag = process.env.CAMOFOX_DESKTOP_DISPLAY;
  process.env.CAMOFOX_DESKTOP_DISPLAY = '1';
  await register({ get: (_, handler) => { inspect = handler; } }, { events, log() {} }, { hostDisplay: true });
  if (previousDisplayFlag === undefined) delete process.env.CAMOFOX_DESKTOP_DISPLAY;
  else process.env.CAMOFOX_DESKTOP_DISPLAY = previousDisplayFlag;
  events.emit('browser:launching', { options });
  camoufox = await firefox.launch({ ...options, timeout: 60000,
    proxy: { server: 'http://127.0.0.1:' + relay.proxy.port },
    firefoxUserPrefs: { ...options.firefoxUserPrefs, 'network.proxy.allow_hijacking_localhost': true },
  });
  events.emit('browser:launched', { browser: camoufox });
  const context = await camoufox.newContext({ viewport: null }); events.emit('session:created', { context });
  const tab = await context.newPage();
  const target = 'http://127.0.0.1:' + originPort + '/verified';
  await tab.goto(target);
  if (process.env.DISPLAY) {
    const size = await tab.evaluate(() => ({ width: outerWidth, height: outerHeight, screenWidth: screen.width, screenHeight: screen.height }));
    assert.deepEqual(size, { width: 1200, height: 720, screenWidth: 1280, screenHeight: 800 });
  }
  await tab.evaluate(() => { window.verificationMarker = 42; });
  assert.equal(await tab.title(), 'Local chain verification');
  assert.ok(front.calls.some((call) => call.port === Number(exit.proxy.port)));
  assert.ok(exit.calls.some((call) => call.port === originPort));
  const count = camoufox.contexts().length;
  for (let i = 0; i < 3; i++) {
    const probeContext = await camoufox.newContext(); const probePage = await probeContext.newPage();
    await probePage.goto('about:blank', { timeout: 5000 }); await probePage.close(); await probeContext.close();
  }
  assert.equal(camoufox.contexts().length, count); assert.equal(context.pages().length, 1);
  assert.equal(tab.url(), target); assert.equal(await tab.evaluate(() => window.verificationMarker), 42);
  const manualTab = await context.newPage(); await tab.close();
  await manualTab.close();
  let status; inspect({}, { json: (value) => { status = value; } });
  assert.equal(status.closed, true);
  await assert.rejects(context.newPage(), /重新启动/);
  await assert.rejects(camoufox.newContext({}), /重新启动/);
  assert.throws(() => events.emit('browser:launching', { options: {} }), /重新启动/);
  console.log('PASS real Camoufox: proxy chain, three passive probes, manual tab tracking, final-page closure and relaunch block; headed=' + !!process.env.DISPLAY);
} finally {
  await uiBrowser?.close(); await camoufox?.close(); await relay?.close();
  for (const close of cleanup.reverse()) await close();
  if (gui.exitCode === null) gui.kill('SIGTERM');
  const timer = setTimeout(() => gui.kill('SIGKILL'), 5000); await guiExit; clearTimeout(timer);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
