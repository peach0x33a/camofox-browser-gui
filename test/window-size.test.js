import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWindowToDisplay, parseXrandr, readDisplaySize } from '../camofox-browser-plugin/desktop/window-size.js';

test('desktop size fits the smallest connected monitor, not the combined desktop', () => {
  assert.deepEqual(parseXrandr(`Screen 0: current 3200 x 1080\nHDMI-1 connected primary 1920x1080+1280+0\neDP-1 connected 1280x800+0+0\n`), { width: 1280, height: 800 });
  assert.deepEqual(parseXrandr('Screen 0: current 1024 x 768\n'), { width: 1024, height: 768 });
  assert.equal(parseXrandr('unknown'), null);
});

test('desktop size falls back to X root when Xrandr gives no monitor size', () => {
  const result = readDisplaySize(':99', (command, args, options) => {
    assert.equal(options.env.DISPLAY, ':99');
    if (command === 'xrandr') return 'no available outputs';
    assert.deepEqual(args, ['-root']);
    return '  Width: 1280\n  Height: 800\n';
  });
  assert.deepEqual(result, { width: 1280, height: 800 });
});

test('visible window dimensions and exposed fingerprint fit the monitor', () => {
  const config = {
    'screen.width': 2560, 'screen.height': 1440,
    'screen.availWidth': 2560, 'screen.availHeight': 1400,
    'window.outerWidth': 2200, 'window.outerHeight': 1300,
    'window.innerWidth': 2200, 'window.innerHeight': 1244,
    'window.screenX': 99, 'window.screenY': 80,
    'navigator.userAgent': 'sample',
  };
  const encoded = JSON.stringify(config);
  const options = { env: { CAMOU_CONFIG_1: encoded.slice(0, 60), CAMOU_CONFIG_2: encoded.slice(60) } };
  assert.deepEqual(fitWindowToDisplay(options, { width: 1280, height: 800 }), { width: 1200, height: 720 });
  const updated = JSON.parse(Object.keys(options.env).sort().map((key) => options.env[key]).join(''));
  assert.equal(updated['window.outerWidth'], 1200);
  assert.equal(updated['window.outerHeight'], 720);
  assert.equal(updated['window.innerHeight'], 664);
  assert.equal(updated['screen.width'], 1280);
  assert.equal(updated['screen.height'], 800);
  assert.equal(updated['navigator.userAgent'], 'sample');
  assert.equal(options.env.CAMOU_CONFIG_2, undefined);
});

test('unusable display or absent fingerprint leaves launch options untouched', () => {
  const options = { env: { CAMOU_CONFIG_1: '{not json' } };
  assert.equal(fitWindowToDisplay(options, { width: 1280, height: 800 }), null);
  assert.deepEqual(options.env, { CAMOU_CONFIG_1: '{not json' });
  assert.equal(fitWindowToDisplay(options, { width: 1, height: 1 }), null);
});
