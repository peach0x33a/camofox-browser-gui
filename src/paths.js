/**
 * Filesystem layout for camofox-gui.
 *
 * Everything the GUI owns lives under DATA_DIR (default ~/.camofox-gui) so the
 * camofox-browser checkout stays clean and profiles survive a GUI reinstall.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export const DATA_DIR = process.env.CAMOFOX_GUI_DATA_DIR
  ? path.resolve(process.env.CAMOFOX_GUI_DATA_DIR)
  : path.join(os.homedir(), '.camofox-gui');

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

/** Per-profile data root: storage state, cookies, traces, downloads. */
export function profileDataDir(profileId) {
  return path.join(PROFILES_DIR, profileId);
}

export const LOCK_FILE = path.join(DATA_DIR, 'gui.lock');

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Claim the data directory for this process.
 *
 * config.json is rewritten wholesale from memory, so two GUIs sharing a data
 * directory would silently clobber each other's profiles (and fight over
 * ports). Refuse to start instead. Returns a release function.
 */
export function acquireDataDirLock() {
  ensureDataDirs();
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const pid = Number(JSON.parse(raw).pid);
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0); // signal 0 = liveness probe only
        throw new Error(
          `另一个 camofox-gui 实例（PID ${pid}）正在使用 ${DATA_DIR}。` +
          `先关掉它，或用 CAMOFOX_GUI_DATA_DIR 指定另一个数据目录。`
        );
      } catch (err) {
        // ESRCH = the recorded process is gone, so the lock is stale.
        if (err?.code !== 'ESRCH') throw err;
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return function release() {
    try {
      const current = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (Number(current.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch { /* already gone */ }
  };
}

/** True when dir looks like a camofox-browser checkout we can spawn. */
export function isCamofoxDir(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'lib', 'config.js'));
  } catch {
    return false;
  }
}

/**
 * Where camoufox-js keeps the downloaded browser bundle. Mirrors
 * camofox-browser's lib/config.js so the GUI can warn before launching.
 */
export function camoufoxCacheDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'camoufox');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'camoufox', 'camoufox', 'Cache');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'camoufox');
}

/** True when a usable Camoufox bundle is available (downloaded or external). */
export function camoufoxInstalled() {
  const external = (
    process.env.CAMOUFOX_EXECUTABLE ||
    process.env.CAMOUFOX_EXECUTABLE_PATH ||
    process.env.CAMOFOX_EXECUTABLE_PATH ||
    ''
  ).trim();
  if (external) return fs.existsSync(external);
  const caches = [camoufoxCacheDir()];
  // camoufox-js 0.10.2 uses the home directory even if LOCALAPPDATA is redirected.
  if (process.platform === 'win32') caches.push(path.join(os.homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache'));
  return caches.some((cache) => fs.existsSync(path.join(cache, 'version.json')));
}

/**
 * Best guess at the camofox-browser checkout: explicit env var, the sibling
 * directory next to this project, then the current working directory.
 */
export function detectCamofoxDir() {
  const candidates = [
    process.env.CAMOFOX_DIR,
    path.resolve(ROOT_DIR, '..', 'camofox-browser'),
    path.resolve(ROOT_DIR, '..'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (candidate && isCamofoxDir(path.resolve(candidate))) return path.resolve(candidate);
  }
  return '';
}
