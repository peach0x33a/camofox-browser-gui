/**
 * Desktop plugin for camofox-browser.
 *
 * Lets a desktop GUI drive the server for interactive, human-operated browsing:
 *
 *   1. Visible window -- core always renders Camoufox into a throwaway Xvfb
 *      display on Linux, so the window is invisible. This plugin replaces
 *      ctx.createVirtualDisplay with a factory that returns the host's real X
 *      display, so the browser window appears on the user's desktop.
 *
 *   2. Raw proxy -- the core proxy pool is built from PROXY_* env vars and only
 *      emits `http://host:port` servers. This plugin can override the launch
 *      proxy with any Playwright-supported server string (socks5://, https://).
 *
 * Both features are opt-in and the plugin is inert without them, so enabling it
 * in camofox.config.json does not change default server behaviour.
 *
 * Environment:
 *   CAMOFOX_DESKTOP=1               Enable the plugin (also loadable via config)
 *   CAMOFOX_DESKTOP_DISPLAY=1       Render on the real X display instead of Xvfb
 *   CAMOFOX_DESKTOP_DISPLAY_NAME    X display to use (default: $DISPLAY, else :0)
 *   CAMOFOX_RAW_PROXY_SERVER        e.g. socks5://127.0.0.1:1080
 *   CAMOFOX_RAW_PROXY_USERNAME
 *   CAMOFOX_RAW_PROXY_PASSWORD
 *   CAMOFOX_RAW_PROXY_BYPASS        comma-separated no-proxy list
 */

import fs from 'node:fs';
import { installVisibleLifecycle } from './lifecycle.js';
import { fitWindowToDisplay, readDisplaySize } from './window-size.js';
export { installVisibleLifecycle } from './lifecycle.js';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/**
 * Resolve the X display to render on, or null when none is usable.
 * Returning null keeps core's behaviour (Xvfb, or headless if Xvfb is missing).
 */
export function resolveHostDisplay(env = process.env, existsSync = fs.existsSync) {
  const display = String(env.CAMOFOX_DESKTOP_DISPLAY_NAME || env.DISPLAY || '').trim();
  if (!display) return null;

  // Unix-socket displays (":0", ":1.0") must have a live X socket, otherwise
  // Firefox exits immediately with "cannot open display". Remote displays
  // ("host:0") have no local socket to check -- accept them as-is.
  const local = display.match(/^:(\d+)(\.\d+)?$/);
  if (local && !existsSync(`/tmp/.X11-unix/X${local[1]}`)) return null;

  return display;
}

/**
 * Build a Playwright proxy object from the raw proxy env vars, or null.
 */
export function resolveRawProxy(env = process.env) {
  const server = String(env.CAMOFOX_RAW_PROXY_SERVER || '').trim();
  if (!server) return null;

  const proxy = { server };
  const username = env.CAMOFOX_RAW_PROXY_USERNAME;
  const password = env.CAMOFOX_RAW_PROXY_PASSWORD;
  const bypass = env.CAMOFOX_RAW_PROXY_BYPASS;
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  if (bypass) proxy.bypass = bypass;
  return proxy;
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, log } = ctx;
  const env = process.env;

  // --- 1. Visible window on the host display ---
  const wantsHostDisplay = envFlag(env.CAMOFOX_DESKTOP_DISPLAY) || pluginConfig.hostDisplay === true;
  if (wantsHostDisplay) {
    installVisibleLifecycle(app, ctx);
    const display = resolveHostDisplay(env);
    if (!display) {
      log('warn', 'desktop plugin: no usable X display, keeping Xvfb', {
        requested: env.CAMOFOX_DESKTOP_DISPLAY_NAME || env.DISPLAY || null,
      });
    } else {
      // Duck-typed VirtualDisplay: core only calls get() and kill(). kill() is a
      // no-op because this display belongs to the user's session, not to us.
      ctx.createVirtualDisplay = () => ({
        get: async () => display,
        kill: () => {},
      });
      events.on('browser:launching', ({ options }) => {
        const screen = readDisplaySize(display);
        const size = fitWindowToDisplay(options, screen);
        if (size) log('info', 'desktop plugin: visible window size', { display, screen, window: size });
        else log('warn', 'desktop plugin: could not constrain window to display', { display, screen });
      });
      log('info', 'desktop plugin: rendering on host display', { display });
    }
  }

  // --- 2. Raw proxy override ---
  const rawProxy = resolveRawProxy(env);
  if (rawProxy) {
    events.on('browser:launching', ({ options }) => {
      options.proxy = rawProxy;
      // geoip inference happens before this hook and only fires for pool proxies,
      // so spoofed locale/timezone are not derived from this proxy's exit IP.
      log('info', 'desktop plugin: raw proxy override applied', { server: rawProxy.server });
    });
  }

  if (!wantsHostDisplay && !rawProxy) {
    log('info', 'desktop plugin: loaded but inactive (no CAMOFOX_DESKTOP_* overrides set)');
  }
}
