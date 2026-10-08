#!/usr/bin/env node
/**
 * camofox-gui -- a local control panel for camofox-browser.
 *
 * Serves a small web UI on 127.0.0.1 and manages one camofox-browser process
 * per profile. Nothing is exposed off-host: the listener binds to loopback and
 * cross-origin requests are rejected.
 *
 * Usage: node src/main.js [--port 8790] [--host 127.0.0.1] [--no-open]
 */

import { openInBrowser } from './platform.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createApi } from './api.js';
import { Manager } from './manager.js';
import { DATA_DIR, PUBLIC_DIR, acquireDataDirLock, ensureDataDirs } from './paths.js';
import { Store } from './store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const options = { port: Number(process.env.CAMOFOX_GUI_PORT) || 8790, host: '127.0.0.1', open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = String(argv[++i]);
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function serveStatic(req, res, url) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, relative);
  // Reject anything that escapes the public directory.
  if (!path.resolve(file).startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  });
}

/** Block browser-driven cross-origin calls to the local API. */
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, fetch from same page without CORS
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}


const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write('用法: node src/main.js [--port 8790] [--host 127.0.0.1] [--no-open]\n');
  process.exit(0);
}

ensureDataDirs();
let releaseLock;
try {
  releaseLock = acquireDataDirLock();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
const store = new Store();
const manager = new Manager(store);
const handleApi = createApi({ store, manager });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!originAllowed(req, options.port)) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'cross-origin 请求被拒绝' }));
    return;
  }
  try {
    if (await handleApi(req, res, url)) return;
    serveStatic(req, res, url);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: err?.message || String(err) }));
  }
});

server.listen(options.port, options.host, () => {
  const url = `http://${options.host}:${options.port}`;
  process.stdout.write(`camofox-gui 已启动: ${url}\n`);
  process.stdout.write(`数据目录: ${DATA_DIR}\n`);
  process.stdout.write(`camofox-browser: ${store.settings.camofoxDir || '(未检测到，请在界面里设置)'}\n`);
  if (options.open) openInBrowser(url);
});

server.on('error', (err) => {
  process.stderr.write(`启动失败: ${err.message}\n`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n收到 ${signal}，正在停止所有 profile…\n`);
  server.close();
  manager.dispose();
  await manager.stopAll();
  releaseLock?.();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('message', (message) => {
  if (message?.type === 'camofox-gui-shutdown' && process.connected) shutdown('IPC');
});
