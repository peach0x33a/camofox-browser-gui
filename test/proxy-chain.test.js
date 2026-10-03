import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import https from 'node:https';
import { createProxyRelay } from '../src/proxy-chain.js';
import { openProxyTunnel } from '../src/proxy.js';
import { listen, mockProxy, proxyGet, tlsOptions } from './helpers/proxies.js';

for (const frontScheme of ['http', 'https', 'socks5']) {
  for (const exitScheme of ['http', 'https', 'socks5']) {
    test('front ' + frontScheme + ' -> exit ' + exitScheme + ' carries HTTP and CONNECT in order', { timeout: 10000 }, async (t) => {
      const front = await mockProxy(t, frontScheme); const exit = await mockProxy(t, exitScheme);
      const originPort = await listen(t, http.createServer((req, res) => {
        assert.equal(req.headers['proxy-authorization'], undefined);
        res.end(req.url);
      }));
      const relay = await createProxyRelay({ upstreamProxy: front.proxy, proxy: exit.proxy, timeoutMs: 2000, tlsOptions: { ca: tlsOptions.cert } });
      t.after(() => relay.close());
      const response = await proxyGet(relay.proxy, 'http://127.0.0.1:' + originPort + '/through-chain?q=1');
      assert.equal(response.status, 200); assert.equal(response.text, '/through-chain?q=1');
      assert.deepEqual(front.calls[0], { host: exit.proxy.host, port: Number(exit.proxy.port) });
      assert.deepEqual(exit.calls[0], { host: '127.0.0.1', port: originPort });
      const echoPort = await listen(t, net.createServer((s) => s.pipe(s)));
      const socket = await openProxyTunnel(relay.proxy, '127.0.0.1', echoPort, { timeoutMs: 2000 });
      t.after(() => socket.destroy());
      const echoed = new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); });
      socket.write('chain-echo'); socket.resume();
      assert.equal((await echoed).toString(), 'chain-echo');
      assert.equal(front.calls.length, 2); assert.equal(exit.calls.length, 2);
    });
  }
}

test('front-only mode carries HTTPS end to end through CONNECT', { timeout: 10000 }, async (t) => {
  const front = await mockProxy(t, 'socks5');
  const port = await listen(t, https.createServer(tlsOptions, (_, res) => res.end('tls-origin')));
  const relay = await createProxyRelay({ upstreamProxy: front.proxy }); t.after(() => relay.close());
  const tunnel = await openProxyTunnel(relay.proxy, '127.0.0.1', port);
  const secure = tls.connect({ socket: tunnel, rejectUnauthorized: false }); t.after(() => secure.destroy());
  const body = await new Promise((resolve, reject) => {
    let data = ''; secure.on('data', (c) => { data += c; }); secure.on('error', reject); secure.on('end', () => resolve(data));
    secure.once('secureConnect', () => secure.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  });
  assert.match(body, /tls-origin/); assert.equal(front.calls[0].port, port);
});

test('rejected front proxy never contacts the exit or target directly', { timeout: 5000 }, async (t) => {
  const front = await mockProxy(t, 'http', { reject: true }); const exit = await mockProxy(t, 'http');
  let contacts = 0;
  const port = await listen(t, http.createServer((_, res) => { contacts++; res.end('unexpected'); }));
  const relay = await createProxyRelay({ upstreamProxy: front.proxy, proxy: exit.proxy }); t.after(() => relay.close());
  assert.equal((await proxyGet(relay.proxy, 'http://127.0.0.1:' + port)).status, 502);
  assert.equal(exit.calls.length, 0); assert.equal(contacts, 0);
});

test('closing relay aborts an in-flight handshake and is idempotent', { timeout: 5000 }, async (t) => {
  let accepted;
  const connected = new Promise((resolve) => { accepted = resolve; });
  const port = await listen(t, net.createServer(() => accepted()));
  const relay = await createProxyRelay({ upstreamProxy: { enabled: true, scheme: 'http', host: '127.0.0.1', port } });
  t.after(() => relay.close());
  const request = proxyGet(relay.proxy, 'http://example.invalid/').catch(() => null);
  await connected;
  await Promise.all([relay.close(), relay.close()]); await request;
});

test('malformed enabled front proxy is rejected instead of bypassed', async (t) => {
  const exit = await mockProxy(t, 'http');
  const upstreamProxy = { enabled: true, host: '', port: '0' };
  await assert.rejects(createProxyRelay({ upstreamProxy, proxy: exit.proxy }), /前置代理/);
  await assert.rejects(openProxyTunnel(exit.proxy, 'example.invalid', 443, { upstreamProxy }), /前置代理/);
  assert.equal(exit.calls.length, 0);
});

test('untrusted HTTPS proxy certificate fails closed', async (t) => {
  const front = await mockProxy(t, 'https'); const exit = await mockProxy(t, 'http');
  const relay = await createProxyRelay({ upstreamProxy: front.proxy, proxy: exit.proxy }); t.after(() => relay.close());
  assert.equal((await proxyGet(relay.proxy, 'http://example.invalid/')).status, 502);
  assert.equal(exit.calls.length, 0);
});

test('four reusable hops carry HTTP and CONNECT in order', { timeout: 10000 }, async (t) => {
  const hops = [];
  for (const scheme of ['http', 'socks5', 'https', 'http']) hops.push(await mockProxy(t, scheme));
  const port = await listen(t, http.createServer((req, res) => res.end(req.url)));
  const chain = hops.map((hop) => hop.proxy);
  const relay = await createProxyRelay({ chain, timeoutMs: 2000, tlsOptions: { ca: tlsOptions.cert } });
  t.after(() => relay.close());
  const response = await proxyGet(relay.proxy, `http://127.0.0.1:${port}/four`);
  assert.deepEqual(response, { status: 200, text: '/four' });
  for (let i = 0; i < hops.length; i++) {
    assert.deepEqual(hops[i].calls[0], {
      host: hops[i + 1]?.proxy.host || '127.0.0.1',
      port: Number(hops[i + 1]?.proxy.port || port),
    });
  }
});

test('a rejected middle hop never contacts downstream nodes or origin', { timeout: 5000 }, async (t) => {
  const first = await mockProxy(t, 'socks5');
  const middle = await mockProxy(t, 'http', { reject: true });
  const last = await mockProxy(t, 'http');
  let contacts = 0;
  const port = await listen(t, http.createServer((_, res) => { contacts++; res.end('unexpected'); }));
  const relay = await createProxyRelay({ chain: [first.proxy, middle.proxy, last.proxy] });
  t.after(() => relay.close());
  assert.equal((await proxyGet(relay.proxy, `http://127.0.0.1:${port}`)).status, 502);
  assert.equal(last.calls.length, 0);
  assert.equal(contacts, 0);
});
