import test from 'node:test';
import assert from 'node:assert/strict';

import { visibleWindowClosed } from '../src/manager.js';

const visibleProfile = { mode: 'visible' };

test('visible window closure destroys only visible instances', () => {
  assert.equal(
    visibleWindowClosed(visibleProfile, { browserConnected: false }, null),
    true,
  );
  assert.equal(
    visibleWindowClosed(visibleProfile, { browserConnected: true }, { activeTabs: 0 }),
    true,
  );
  assert.equal(
    visibleWindowClosed(visibleProfile, { browserConnected: true }, { activeTabs: 1 }),
    false,
  );
  assert.equal(
    visibleWindowClosed({ mode: 'headless' }, { browserConnected: false }, null),
    false,
  );
  assert.equal(
    visibleWindowClosed(visibleProfile, { browserConnected: true }, { browserRunning: false, activeTabs: 1 }),
    true,
  );
});
