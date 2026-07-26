/**
 * Proxy parsing, env mapping and connectivity testing.
 *
 * Two ways a proxy reaches Camoufox:
 *   - PROXY_* env vars     -> camofox-browser's round_robin pool. Only emits
 *                             `http://host:port`, but gets GeoIP locale/timezone
 *                             spoofing for free. Used for plain HTTP proxies.
 *   - CAMOFOX_RAW_PROXY_*  -> the `desktop` plugin overrides the launch proxy
 *                             with an arbitrary server string. Used for
 *                             https:// and socks5:// proxies, which the pool
 *                             cannot express.
 */

import net from 'node:net';
import tls from 'node:tls';

export const SCHEMES = ['http', 'https', 'socks5'];

export const EMPTY_PROXY = {
  enabled: false,
  scheme: 'http',
  host: '',
  port: '',
  username: '',
  password: '',
};

/**
 * Normalize a proxy object coming from the UI or from a parsed line.
 * Never throws -- validation is a separate step.
 */
export function normalizeProxy(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const scheme = SCHEMES.includes(String(raw.scheme || '').toLowerCase())
    ? String(raw.scheme).toLowerCase()
    : 'http';
  return {
    enabled: raw.enabled !== false,
    scheme,
    host: String(raw.host ?? '').trim(),
    port: String(raw.port ?? '').trim(),
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
  };
}

/** Returns an error string, or '' when the proxy is usable. */
export function validateProxy(proxy) {
  const p = normalizeProxy(proxy);
  if (!p.host) return '代理地址不能为空';
  if (!/^[a-zA-Z0-9._-]+$/.test(p.host)) return `代理地址不合法: ${p.host}`;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `代理端口不合法: ${p.port}`;
  if (p.password && !p.username) return '填写了密码但没有填用户名';
  return '';
}

export function hasProxy(proxy) {
  const p = normalizeProxy(proxy);
  return p.enabled && !!p.host && !!p.port;
}

/** Human-readable form with the password masked -- safe for the UI and logs. */
export function describeProxy(proxy) {
  const p = normalizeProxy(proxy);
  if (!p.host || !p.port) return '';
  const auth = p.username ? `${p.username}${p.password ? ':••••' : ''}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

/**
 * Parse one line of a pasted proxy list. Accepted shapes:
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   scheme://host:port
 *   scheme://user:pass@host:port
 *   scheme://host:port:user:pass
 * Returns a normalized proxy; throws Error with a Chinese message on bad input.
 */
export function parseProxyLine(line) {
  let rest = String(line ?? '').trim();
  if (!rest) throw new Error('空行');

  let scheme = 'http';
  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    const found = schemeMatch[1].toLowerCase();
    const alias = { socks: 'socks5', socks5h: 'socks5' }[found] || found;
    if (!SCHEMES.includes(alias)) throw new Error(`不支持的代理协议: ${found}`);
    scheme = alias;
    rest = rest.slice(schemeMatch[0].length);
  }

  const isPort = (value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  // A password may legitimately contain a bare '%' ("100%pure"), which makes
  // decodeURIComponent throw a URIError with an English message. Fall back to
  // the literal text instead of rejecting the line.
  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const build = (host, port, username, password) => {
    const proxy = normalizeProxy({ enabled: true, scheme, host, port, username, password });
    const error = validateProxy(proxy);
    if (error) throw new Error(`${error}（${line.trim()}）`);
    return proxy;
  };

  // `host:port:user:pass` is matched FIRST, because splitting on the last '@'
  // would otherwise mangle any password containing '@' (e.g. "1.2.3.4:8080:u:p@ss"
  // parsed as credentials "1.2.3.4:8080:u:p" + host "ss"). Requiring a numeric
  // port in field 2 keeps this from stealing `user:pass@host:port` lines.
  const colonParts = rest.split(':');
  if (colonParts.length >= 4 && isPort(colonParts[1]) && !colonParts[0].includes('@')) {
    const [host, port, username, ...passwordParts] = colonParts;
    return build(host, port, username, passwordParts.join(':'));
  }

  // user:pass@host:port -- the last '@' separates credentials from the endpoint.
  const atIndex = rest.lastIndexOf('@');
  if (atIndex !== -1) {
    const credentials = rest.slice(0, atIndex);
    const endpoint = rest.slice(atIndex + 1);
    const sep = credentials.indexOf(':');
    const username = safeDecode(sep === -1 ? credentials : credentials.slice(0, sep));
    const password = sep === -1 ? '' : safeDecode(credentials.slice(sep + 1));
    const endpointParts = endpoint.split(':');
    if (endpointParts.length !== 2 || !isPort(endpointParts[1])) {
      throw new Error(`无法解析: ${line.trim()}`);
    }
    return build(endpointParts[0], endpointParts[1], username, password);
  }

  if (colonParts.length !== 2) throw new Error(`无法解析: ${line.trim()}`);
  return build(colonParts[0], colonParts[1], '', '');
}

/** Parse a pasted list; returns { proxies, errors }. Blank lines and # comments are skipped. */
export function parseProxyList(text) {
  const proxies = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    try {
      proxies.push(parseProxyLine(trimmed));
    } catch (err) {
      errors.push(`第 ${index + 1} 行: ${err.message}`);
    }
  });
  return { proxies, errors };
}

/**
 * Environment variables that hand this proxy to a camofox-browser instance.
 * Plain HTTP goes through the native pool; everything else through the plugin.
 */
export function proxyEnv(proxy) {
  if (!hasProxy(proxy)) return {};
  const p = normalizeProxy(proxy);

  if (p.scheme === 'http') {
    // camofox-browser runs every pool credential through decodeURIComponent
    // (lib/proxy.js normalizePlaywrightProxy, applied at launch AND per
    // context), so a raw password containing %XX would arrive mangled. Encode
    // here so the server's decode round-trips back to the original.
    return {
      PROXY_STRATEGY: 'round_robin',
      PROXY_HOST: p.host,
      PROXY_PORTS: String(p.port),
      PROXY_PORT: String(p.port),
      ...(p.username ? { PROXY_USERNAME: encodeURIComponent(p.username) } : {}),
      ...(p.password ? { PROXY_PASSWORD: encodeURIComponent(p.password) } : {}),
    };
  }

  return {
    CAMOFOX_RAW_PROXY_SERVER: `${p.scheme}://${p.host}:${p.port}`,
    ...(p.username ? { CAMOFOX_RAW_PROXY_USERNAME: p.username } : {}),
    ...(p.password ? { CAMOFOX_RAW_PROXY_PASSWORD: p.password } : {}),
  };
}

// ---------------------------------------------------------------------------
// Connectivity test
// ---------------------------------------------------------------------------

/**
 * Fail the pending promise on timeout *or* on a silent close -- a proxy that
 * hangs up without an error event would otherwise leave it unsettled forever.
 * Returns a cleanup function to call once the socket has been handed off.
 */
function guard(socket, timeoutMs, reject, label = '') {
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error(`${label}超时（${timeoutMs}ms）`));
  }, timeoutMs);
  const onClose = () => {
    clearTimeout(timer);
    reject(new Error(`${label}连接被对端关闭`));
  };
  socket.once('close', onClose);
  return () => {
    clearTimeout(timer);
    socket.off('close', onClose);
  };
}

/** Open a raw TCP tunnel to target through an HTTP/HTTPS proxy (CONNECT). */
function connectViaHttp(p, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = p.scheme === 'https'
      ? tls.connect({ host: p.host, port: Number(p.port), servername: p.host, rejectUnauthorized: false })
      : net.connect({ host: p.host, port: Number(p.port) });

    const done = guard(socket, timeoutMs, reject, '代理握手');
    socket.once('error', reject);

    socket.once(p.scheme === 'https' ? 'secureConnect' : 'connect', () => {
      const auth = p.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        auth +
        `Proxy-Connection: keep-alive\r\n\r\n`
      );
    });

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16384) {
          socket.destroy();
          reject(new Error('代理响应头过长'));
        }
        return;
      }
      socket.off('data', onData);
      socket.pause();
      const head = buffer.slice(0, end).toString('utf8');
      const status = Number(head.split(/\r?\n/)[0]?.split(' ')[1]);
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝 CONNECT: ${head.split(/\r?\n/)[0] || '无响应'}`));
        return;
      }
      // Push back anything the proxy sent past the header so the TLS layer sees it.
      const leftover = buffer.slice(end + 4);
      if (leftover.length) socket.unshift(leftover);
      done();
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/** Minimal SOCKS5 client: greeting, optional user/pass auth, CONNECT by domain. */
function connectViaSocks5(p, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: p.host, port: Number(p.port) });
    const done = guard(socket, timeoutMs, reject, 'SOCKS5 握手');
    socket.once('error', reject);

    const readExactly = (length) => new Promise((resolveRead, rejectRead) => {
      const attempt = () => {
        const chunk = socket.read(length);
        if (chunk) {
          resolveRead(chunk);
          return;
        }
        socket.once('readable', attempt);
      };
      socket.once('error', rejectRead);
      socket.once('close', () => rejectRead(new Error('SOCKS5 连接被对端关闭')));
      attempt();
    });

    socket.once('connect', async () => {
      try {
        const methods = p.username ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, methods.length, ...methods]));
        const greeting = await readExactly(2);
        if (greeting[0] !== 0x05) throw new Error('不是 SOCKS5 代理');
        if (greeting[1] === 0x02) {
          if (!p.username) throw new Error('代理要求账号密码认证');
          const user = Buffer.from(p.username);
          const pass = Buffer.from(p.password || '');
          socket.write(Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass,
          ]));
          const authReply = await readExactly(2);
          if (authReply[1] !== 0x00) throw new Error('代理账号密码认证失败');
        } else if (greeting[1] !== 0x00) {
          throw new Error('代理不接受任何支持的认证方式');
        }

        const host = Buffer.from(targetHost);
        const request = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        socket.write(request);

        const reply = await readExactly(4);
        if (reply[1] !== 0x00) throw new Error(`SOCKS5 连接失败（代码 ${reply[1]}）`);
        const addressType = reply[3];
        const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (await readExactly(1))[0];
        await readExactly(addressLength + 2);
        done();
        resolve(socket);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
  });
}

/**
 * Echo services used to read back the exit IP. Several, because any single one
 * may be unreachable from a given proxy (ipify in particular is blocked on many
 * mainland Chinese routes) -- a working proxy must not be reported as broken.
 */
export const IP_ECHO_TARGETS = [
  { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' },
  { host: 'ipinfo.io', path: '/json' },
  { host: 'api.ipify.org', path: '/?format=json' },
  { host: 'ifconfig.me', path: '/ip' },
];

const IPV4 = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;

/**
 * Read the exit IP (and country when available) out of an echo response.
 * Handles Cloudflare's `key=value` trace format, JSON `{"ip": ...}`, and
 * plain-text bodies that are just the address.
 */
function extractIp(body) {
  const payload = body.split('\r\n\r\n').slice(1).join('\r\n\r\n') || body;
  const trace = payload.match(/^ip=(.+)$/m)?.[1]?.trim();
  if (trace) return { ip: trace, country: payload.match(/^loc=([A-Z]{2})$/m)?.[1] || '' };

  const json = payload.match(/"ip"\s*:\s*"([^"]+)"/)?.[1];
  if (json) return { ip: json, country: payload.match(/"country"\s*:\s*"([^"]+)"/)?.[1] || '' };

  return { ip: payload.match(IPV4)?.[1] || '', country: '' };
}

async function fetchIpThrough(p, target, timeoutMs) {
  let socket = null;
  try {
    socket = p.scheme === 'socks5'
      ? await connectViaSocks5(p, target.host, 443, timeoutMs)
      : await connectViaHttp(p, target.host, 443, timeoutMs);

    const body = await new Promise((resolve, reject) => {
      const secure = tls.connect({ socket, servername: target.host }, () => {
        secure.write(
          `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\n` +
          `User-Agent: curl/8\r\nAccept: */*\r\nConnection: close\r\n\r\n`
        );
      });
      const done = guard(secure, timeoutMs, reject, '请求');
      secure.once('error', reject);
      const chunks = [];
      secure.on('data', (chunk) => chunks.push(chunk));
      secure.once('end', () => {
        done();
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

    return extractIp(body);
  } finally {
    socket?.destroy?.();
  }
}

/**
 * Verify the proxy actually tunnels HTTPS, and report the exit IP.
 * Tries each echo target in turn; the first one that answers wins.
 * @returns {Promise<{ok: boolean, ip?: string, via?: string, latencyMs?: number, error?: string}>}
 */
export async function testProxy(proxy, { timeoutMs = 10000, targets = IP_ECHO_TARGETS } = {}) {
  const p = normalizeProxy(proxy);
  const invalid = validateProxy(p);
  if (invalid) return { ok: false, error: invalid };

  const startedAt = Date.now();
  const failures = [];
  for (const target of targets) {
    // Timed per attempt: charging the successful target with the time spent on
    // earlier unreachable ones would report a latency many times the real one.
    const attemptStartedAt = Date.now();
    try {
      const { ip, country } = await fetchIpThrough(p, target, timeoutMs);
      if (ip) {
        return {
          ok: true,
          ip,
          country,
          via: target.host,
          latencyMs: Date.now() - attemptStartedAt,
          totalMs: Date.now() - startedAt,
        };
      }
      failures.push(`${target.host}: 响应里没有 IP`);
    } catch (err) {
      failures.push(`${target.host}: ${err?.message || String(err)}`);
    }
  }
  return {
    ok: false,
    error: failures.join('；'),
    latencyMs: Date.now() - startedAt,
  };
}
