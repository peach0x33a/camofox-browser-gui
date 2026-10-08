import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { camoufoxCacheDir } from '../src/paths.js';
import { browserOpenCommand } from '../src/platform.js';
import { installPlugin } from '../scripts/install-plugin.mjs';
import { register } from '../camofox-browser-plugin/desktop/index.js';
import { fitWindowToDisplay, readDisplaySize } from '../camofox-browser-plugin/desktop/window-size.js';

test('cache discovery follows macOS and Windows layout including redirected LOCALAPPDATA', () => {
  assert.equal(camoufoxCacheDir('darwin', {}, '/home/user'), path.join('/home/user', 'Library/Caches/camoufox'));
  assert.equal(camoufoxCacheDir('win32', { LOCALAPPDATA: '/redirected' }, '/home/user'), path.join('/redirected', 'camoufox/camoufox/Cache'));
  assert.equal(camoufoxCacheDir('win32', {}, '/home/user'), path.join('/home/user', 'AppData/Local/camoufox/camoufox/Cache'));
  const url = 'http://127.0.0.1:8790';
  assert.deepEqual(browserOpenCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserOpenCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} visible launch overrides upstream headless without needing an X display`, async () => {
    const events = new EventEmitter();
    let factoryCalls = 0;
    const ctx = { events, log() {}, createVirtualDisplay() { factoryCalls++; } };
    await register({ get() {} }, ctx, { hostDisplay: true }, platform);
    const options = { headless: true, env: { DISPLAY: ':99' } };
    events.emit('browser:launching', { options });
    assert.equal(options.headless, false);
    assert.equal(options.env.DISPLAY, undefined);
    assert.equal(factoryCalls, 0);
  });
  test(`${platform} monitor discovery fails safely and parses native screen dimensions`, () => {
    assert.deepEqual(readDisplaySize(null, (cmd, args) => {
      assert.equal(cmd, platform === 'darwin' ? 'osascript' : 'powershell.exe');
      assert.ok(args.length > 0);
      return '{"width":1440,"height":900}';
    }, platform), { width: 1440, height: 900 });
    assert.equal(readDisplaySize(null, () => { throw new Error('unavailable'); }, platform), null);
  });
}

test('Windows fingerprint stays intact across 2047-character environment chunks', () => {
  const config = { 'window.outerWidth': 2000, 'window.outerHeight': 1000, marker: 'x'.repeat(10000) };
  const options = { env: { CAMOU_CONFIG_1: JSON.stringify(config), KEEP: 'yes' } };
  fitWindowToDisplay(options, { width: 1280, height: 800 }, 'win32');
  const chunks = Object.keys(options.env).filter((k) => k.startsWith('CAMOU_CONFIG_'))
    .sort((a, b) => Number(a.slice(13)) - Number(b.slice(13))).map((k) => options.env[k]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2047));
  const result = JSON.parse(chunks.join(''));
  assert.equal(result.marker, config.marker);
  assert.equal(result['window.outerWidth'], 1200);
  assert.equal(options.env.KEEP, 'yes');
});

test('portable installer upgrades files, preserves other plugins and backs up once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox plugin spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.js'), '');
  const file = path.join(root, 'camofox.config.json');
  const raw = '{"plugins":{"persistence":{"enabled":true},"desktop":{"enabled":false,"custom":42}},"other":1}';
  fs.writeFileSync(file, raw);
  const installed = installPlugin(root);
  installPlugin(root);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), raw);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.plugins.desktop, { enabled: true, custom: 42 });
  assert.equal(config.plugins.persistence.enabled, true);
  assert.equal(config.other, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).guiProtocol, 3);
  fs.writeFileSync(file, '{"plugins":["persistence"]}');
  installPlugin(root); installPlugin(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins, ['persistence', 'desktop']);
});

test('server IPC shutdown runs upstream cleanup even if requested during import', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox shutdown spaces '));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'server.js'), `import fs from 'node:fs';
    await new Promise(r => setTimeout(r, 50));
    process.on('SIGTERM', () => { fs.writeFileSync('checkpoint', 'saved'); process.exit(0); });
    setInterval(() => {}, 1000);`);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../scripts/browser-server.mjs', import.meta.url))], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (proc.exitCode === null) proc.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const exited = once(proc, 'exit');
  proc.send({ type: 'camofox-gui-shutdown' });
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'checkpoint'), 'utf8'), 'saved');
});
