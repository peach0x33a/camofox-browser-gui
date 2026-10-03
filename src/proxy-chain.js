/** Per-launch loopback HTTP relay: browser -> any number of proxy hops -> site. */
import http from 'node:http';
import { hasProxy, openProxyTunnel, validateProxy } from './proxy.js';

function forwardHeaders(headers) {
  const result = { ...headers };
  const hopHeaders = ['proxy-authorization', 'proxy-authenticate', 'proxy-connection',
    'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  for (const name of String(headers.connection || '').split(',')) hopHeaders.push(name.trim().toLowerCase());
  for (const name of hopHeaders) delete result[name];
  return result;
}

export async function createProxyRelay({ proxy = null, upstreamProxy, chain = null, timeoutMs = 10000, tlsOptions }) {
  if (chain === null) {
    const invalid = validateProxy(upstreamProxy);
    if (invalid || !hasProxy(upstreamProxy)) throw new Error('前置代理 ' + (invalid || '未启用'));
  } else if (!chain.length || chain.some((node) => validateProxy(node))) {
    throw new Error('代理链路包含无效节点');
  }
  let closed = false;
  const sockets = new Set();
  const track = (socket) => {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const connect = async (host, port) => {
    if (closed) throw new Error('代理转发已关闭');
    const socket = await openProxyTunnel(proxy, host, port, { upstreamProxy, chain, timeoutMs, onSocket: track, tlsOptions });
    if (closed) { socket.destroy(); throw new Error('代理转发已关闭'); }
    return socket;
  };
  const server = http.createServer(async (req, res) => {
    let outgoing;
    let agent;
    const abort = () => { outgoing?.destroy(); agent?.destroy(); };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Expected HTTP proxy request');
      const socket = await connect(url.hostname, Number(url.port) || 80);
      if (res.destroyed) { socket.destroy(); return; }
      agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      outgoing = http.request({
        hostname: url.hostname, port: Number(url.port) || 80, method: req.method,
        path: url.pathname + url.search, agent,
        headers: { ...forwardHeaders(req.headers), host: url.host },
      }, (response) => {
        res.writeHead(response.statusCode, forwardHeaders(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      outgoing.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end('Proxy chain connection failed');
        else res.destroy();
      });
      req.pipe(outgoing);
      socket.resume();
    } catch {
      abort();
      if (!res.headersSent) res.writeHead(502).end('Proxy chain connection failed');
      else res.destroy();
    }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    let remote;
    client.on('error', () => remote?.destroy());
    client.once('close', () => remote?.destroy());
    try {
      const target = new URL('http://' + req.url);
      if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
        throw new Error('Invalid CONNECT authority');
      }
      remote = await connect(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port) || 443);
      if (client.destroyed) { remote.destroy(); return; }
      remote.on('error', () => client.destroy());
      remote.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    } catch {
      remote?.destroy();
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let closing;
  return {
    proxy: { enabled: true, scheme: 'http', host: '127.0.0.1', port: String(server.address().port), username: '', password: '' },
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = new Promise((resolve) => server.close(resolve));
      return closing;
    },
  };
}
