// Offline process fixture for Manager tests. Never starts a real browser.
import http from 'node:http';
import fs from 'node:fs';
let running = false;
let tabs = 0;
let closed = false;
const server = http.createServer((req, res) => {
  fs.appendFileSync('requests.log', req.method + ' ' + req.url + '\n');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/start') { running = true; setTimeout(() => res.end('{}'), 30); return; }
  if (req.url === '/tabs') { tabs++; res.end(JSON.stringify({ url: 'https://example.com' })); return; }
  if (req.url === '/control/close' || req.url === '/control/noipc') {
    running = false; tabs = 0; closed = true; res.end('{}');
    if (req.url === '/control/close') process.send?.({ type: 'camofox-desktop-closed' });
    return;
  }
  if (req.url === '/env') {
    res.end(JSON.stringify({ host: process.env.PROXY_HOST, port: process.env.PROXY_PORT })); return;
  }
  res.end(JSON.stringify({ ok: true, desktopProtocol: 1, browserConnected: running, browserRunning: running, activeTabs: tabs, closed }));
});
server.listen(Number(process.env.CAMOFOX_PORT), '127.0.0.1');
process.on('SIGTERM', () => { server.close(); process.exit(0); });
