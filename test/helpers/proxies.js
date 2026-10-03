import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { once } from 'node:events';

export const tlsOptions = {
  key: fs.readFileSync(new URL('../fixtures/proxy-key.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('../fixtures/proxy-cert.pem', import.meta.url)),
};

export async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); s.once('close', () => sockets.delete(s)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); });
  return server.address().port;
}

function read(socket, size) {
  return new Promise((resolve, reject) => {
    const done = () => { socket.off('readable', attempt); socket.off('close', closed); socket.off('error', fail); };
    const fail = (err) => { done(); reject(err); };
    const closed = () => fail(new Error('closed during handshake'));
    const attempt = () => { const value = socket.read(size); if (value) { done(); resolve(value); } };
    socket.on('readable', attempt); socket.once('close', closed); socket.once('error', fail); attempt();
  });
}

export async function mockProxy(t, scheme, { reject = false } = {}) {
  const calls = [];
  const auth = { username: 'fixture-user', password: 'fixture-password' };
  const connect = (host, port, client, ready) => {
    calls.push({ host, port });
    const remote = net.connect({ host, port });
    client.once('close', () => remote.destroy()); remote.on('error', () => client.destroy());
    remote.once('close', () => client.destroy());
    remote.once('connect', () => { ready(); client.pipe(remote); remote.pipe(client); });
  };
  const server = scheme === 'socks5' ? net.createServer(async (client) => {
    try {
      const header = await read(client, 2); await read(client, header[1]);
      client.write(Buffer.from([5, 2]));
      const userHeader = await read(client, 2); const user = (await read(client, userHeader[1])).toString();
      const passSize = (await read(client, 1))[0]; const pass = (await read(client, passSize)).toString();
      if (reject || user !== auth.username || pass !== auth.password) { client.end(Buffer.from([1, 1])); return; }
      client.write(Buffer.from([1, 0]));
      const request = await read(client, 4);
      let host;
      if (request[3] === 3) host = (await read(client, (await read(client, 1))[0])).toString();
      else if (request[3] === 1) host = [...await read(client, 4)].join('.');
      else throw new Error('unsupported fixture address');
      const port = (await read(client, 2)).readUInt16BE();
      connect(host, port, client, () => client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])));
    } catch { client.destroy(); }
  }) : scheme === 'https' ? https.createServer(tlsOptions) : http.createServer();
  if (scheme !== 'socks5') server.on('connect', (req, client, head) => {
    const expected = 'Basic ' + Buffer.from(auth.username + ':' + auth.password).toString('base64');
    if (reject || req.headers['proxy-authorization'] !== expected) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const target = new URL('http://' + req.url);
    connect(target.hostname, Number(target.port), client, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) client.unshift(head);
    });
  });
  const port = await listen(t, server);
  return { proxy: { enabled: true, scheme, host: '127.0.0.1', port: String(port), ...auth }, calls };
}

export function proxyGet(proxy, url) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: proxy.host, port: proxy.port, path: url, headers: { 'proxy-authorization': 'should-not-reach-origin' } }, (response) => {
      const chunks = []; response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(3000, () => request.destroy(new Error('request timed out')));
  });
}
