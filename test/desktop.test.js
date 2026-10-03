import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installVisibleLifecycle, register } from '../camofox-browser-plugin/desktop/index.js';

class Page extends EventEmitter {
  closed = false;
  evaluations = 0;
  isClosed() { return this.closed; }
  async evaluate() { this.evaluations++; return 1; }
  close() { this.closed = true; this.emit('close'); }
}
class Context extends EventEmitter {
  list = [];
  pages() { return this.list.filter((p) => !p.closed); }
  addPage() { const page = new Page(); this.list.push(page); this.emit('page', page); return page; }
}
function setup() {
  const events = new EventEmitter();
  const notifications = [];
  const routes = new Map();
  const browser = new EventEmitter();
  browser.connected = true;
  browser.created = 0;
  browser.isConnected = () => browser.connected;
  browser.contexts = () => [];
  browser.newContext = async () => { browser.created++; return new Context(); };
  installVisibleLifecycle({ get: (url, handler) => routes.set(url, handler) }, { events, log() {} }, (m) => notifications.push(m));
  events.emit('browser:launching', { options: {} });
  events.emit('browser:launched', { browser });
  const context = new Context();
  events.emit('session:created', { context });
  const status = () => { let data; routes.get('/desktop/status')({}, { json: (v) => { data = v; } }); return data; };
  return { events, browser, context, notifications, status };
}

test('headed health probe evaluates existing page without opening/navigating/closing a window', async () => {
  const { browser, context, status } = setup();
  const existing = context.addPage();
  const probe = await browser.newContext();
  const page = await probe.newPage();
  await page.goto('about:blank', { timeout: 100 });
  await page.close(); await probe.close();
  assert.equal(browser.created, 0);
  assert.equal(existing.evaluations, 1);
  assert.equal(existing.closed, false);
  assert.equal(status().activeTabs, 1);
  await browser.newContext({ viewport: null });
  assert.equal(browser.created, 1, 'normal session creation still creates contexts');
});

test('closing last page latches shutdown immediately and blocks every relaunch', () => {
  const { events, browser, context, notifications, status } = setup();
  const first = context.addPage();
  const manualTab = context.addPage();
  first.close();
  assert.equal(status().closed, false);
  manualTab.close();
  assert.equal(notifications.length, 1);
  assert.equal(status().closed, true);
  assert.throws(() => events.emit('browser:launching', { options: {} }), /重新启动/);
  browser.emit('disconnected');
  assert.equal(notifications.length, 1, 'close and disconnect notify exactly once');
});

test('disconnect blocks recovery even while pages still exist', () => {
  const { browser, context, events, notifications } = setup();
  context.addPage(); browser.connected = false; browser.emit('disconnected');
  assert.equal(notifications[0].reason, 'browser_disconnected');
  assert.throws(() => events.emit('browser:launching', { options: {} }));
});

test('passive status and startup without pages do not trigger a shutdown', () => {
  const { status, notifications } = setup();
  assert.equal(status().activeTabs, 0);
  assert.equal(status().closed, false);
  assert.equal(notifications.length, 0);
});

test('normal server shutdown does not send another window-close notification', () => {
  const { events, context, notifications } = setup();
  const page = context.addPage();
  events.emit('server:shutdown'); page.close();
  assert.equal(notifications.length, 0);
});

test('hung passive probe times out without creating a window', async () => {
  const { browser, context } = setup();
  context.addPage().evaluate = () => new Promise(() => {});
  const probe = await browser.newContext(); const page = await probe.newPage();
  await assert.rejects(page.goto('about:blank', { timeout: 10 }), /timed out/);
  assert.equal(browser.created, 0);
});

test('plugin leaves headless browser lifecycle untouched', async () => {
  const previous = process.env.CAMOFOX_DESKTOP_DISPLAY;
  delete process.env.CAMOFOX_DESKTOP_DISPLAY;
  try {
    const events = new EventEmitter();
    await register({ get() { assert.fail('must not install headed routes'); } }, { events, log() {} });
    assert.equal(events.listenerCount('browser:launched'), 0);
  } finally {
    if (previous === undefined) delete process.env.CAMOFOX_DESKTOP_DISPLAY;
    else process.env.CAMOFOX_DESKTOP_DISPLAY = previous;
  }
});
