/** Keep visible Camoufox windows on the host display. The upstream JS launcher
 * generates random screen/window dimensions without inspecting host monitors. */
import { execFileSync } from 'node:child_process';

export function parseXrandr(output) {
  const monitors = [...String(output).matchAll(/^\S+\s+connected(?:\s+primary)?\s+(\d+)x(\d+)\+[-\d]+\+[-\d]+/gm)]
    .map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  // Fit even when the window manager places a new window on a smaller monitor.
  if (monitors.length) return {
    width: Math.min(...monitors.map((monitor) => monitor.width)),
    height: Math.min(...monitors.map((monitor) => monitor.height)),
  };
  const current = String(output).match(/\bcurrent\s+(\d+)\s+x\s+(\d+)/);
  return current ? { width: Number(current[1]), height: Number(current[2]) } : null;
}

export function readDisplaySize(display, run = execFileSync, platform = process.platform) {
  const nativeOptions = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  if (platform === 'darwin' || platform === 'win32') {
    try {
      const output = platform === 'darwin'
        ? run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var screens = $.NSScreen.screens; var w = [], h = []; for (var i = 0; i < screens.count; i++) { var f = screens.objectAtIndex(i).visibleFrame; w.push(f.size.width); h.push(f.size.height); } JSON.stringify({width: Math.min.apply(null, w), height: Math.min.apply(null, h)})'], nativeOptions)
        : run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $screens = [System.Windows.Forms.Screen]::AllScreens; @{width=($screens | ForEach-Object {$_.WorkingArea.Width} | Measure-Object -Minimum).Minimum; height=($screens | ForEach-Object {$_.WorkingArea.Height} | Measure-Object -Minimum).Minimum} | ConvertTo-Json -Compress'], nativeOptions);
      const size = JSON.parse(String(output).trim());
      return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0 ? size : null;
    } catch { return null; }
  }
  const env = { ...process.env, DISPLAY: display };
  try {
    const screen = parseXrandr(run('xrandr', ['--current'], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
    if (screen) return screen;
  } catch { /* Xrandr may be unavailable on a remote X display. */ }
  try {
    const output = run('xwininfo', ['-root'], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const width = Number(String(output).match(/^\s*Width:\s*(\d+)/m)?.[1]);
    const height = Number(String(output).match(/^\s*Height:\s*(\d+)/m)?.[1]);
    return width && height ? { width, height } : null;
  } catch { return null; }
}

export function fitWindowToDisplay(options, displaySize, platform = process.platform) {
  const screenWidth = displaySize?.width;
  const screenHeight = displaySize?.height;
  if (!Number.isInteger(screenWidth) || !Number.isInteger(screenHeight) ||
      screenWidth < 640 || screenHeight < 480) return null;
  const env = options?.env;
  if (!env) return null;
  const keys = Object.keys(env).filter((key) => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(13)) - Number(b.slice(13)));
  if (!keys.length) return null;
  let config;
  try { config = JSON.parse(keys.map((key) => env[key]).join('')); }
  catch { return null; }
  if (!Number.isInteger(config['window.outerWidth']) || !Number.isInteger(config['window.outerHeight'])) return null;

  const width = Math.min(1200, screenWidth - 80);
  const height = Math.min(800, screenHeight - 80);
  const oldWidth = config['window.outerWidth'];
  const oldHeight = config['window.outerHeight'];
  Object.assign(config, {
    'screen.width': screenWidth, 'screen.height': screenHeight,
    'screen.availWidth': screenWidth, 'screen.availHeight': screenHeight,
    'window.outerWidth': width, 'window.outerHeight': height,
    'window.screenX': 0, 'window.screenY': 0,
  });
  // Some fingerprints specify inner dimensions too; retain their chrome offset.
  if (Number.isInteger(config['window.innerWidth'])) {
    config['window.innerWidth'] = Math.min(width, Math.max(1, width - (oldWidth - config['window.innerWidth'])));
  }
  if (Number.isInteger(config['window.innerHeight'])) {
    config['window.innerHeight'] = Math.min(height, Math.max(1, height - (oldHeight - config['window.innerHeight'])));
  }
  if ('screen.availLeft' in config) config['screen.availLeft'] = 0;
  if ('screen.availTop' in config) config['screen.availTop'] = 0;

  const encoded = JSON.stringify(config);
  for (const key of keys) delete env[key];
  const chunkSize = platform === 'win32' ? 2047 : 32767;
  for (let i = 0; i < encoded.length; i += chunkSize) {
    env[`CAMOU_CONFIG_${Math.floor(i / chunkSize) + 1}`] = encoded.slice(i, i + chunkSize);
  }
  return { width, height };
}
