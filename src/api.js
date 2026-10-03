/**
 * JSON API + SSE stream consumed by public/app.js.
 */

import { MODES, PROXY_MODES } from './store.js';
import { describeProxy, normalizeProxy, parseProxyLine, parseProxyList, testProxy } from './proxy.js';

/** Stand-in shown instead of a stored password; never persisted. */
const PASSWORD_PLACEHOLDER = '••••••';

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createApi({ store, manager }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** Bumped to cancel an in-flight sequential bulk start. */
  let bulkStartToken = 0;

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  }

  manager.on('log', (event) => broadcast('log', event));
  manager.on('status', (status) => broadcast('status', status));
  manager.on('log-reset', (event) => broadcast('logreset', event));

  function profileView(profile) {
    const route = store.effectiveProxyChain(profile);
    return {
      ...profile,
      proxy: { ...profile.proxy, password: profile.proxy.password ? PASSWORD_PLACEHOLDER : '' },
      upstreamProxy: { ...profile.upstreamProxy, password: profile.upstreamProxy?.password ? PASSWORD_PLACEHOLDER : '' },
      upstreamProxyLabel: profile.upstreamProxy?.enabled ? describeProxy(profile.upstreamProxy) : '',
      proxyLabel: ['node', 'chain'].includes(profile.proxyMode)
        ? (route.map((p) => p.name || describeProxy(p)).join(' → ') || '不使用代理')
        : describeProxy(store.effectiveProxy(profile)) || '不使用代理',
      effectiveStartUrl: store.effectiveStartUrl(profile),
    };
  }

  function state() {
    const settings = store.settings;
    const active = store.activeProxy();
    return {
      settings: {
        ...settings,
        // Passwords never leave the process in the clear: the list is only ever
        // rendered, and edits send back the placeholder when left untouched.
        proxies: settings.proxies.map((p) => ({
          id: p.id,
          name: p.name,
          showInList: p.showInList,
          scheme: p.scheme,
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password ? PASSWORD_PLACEHOLDER : '',
          label: describeProxy(p),
          route: [p.name],
        })),
        chains: settings.chains.map((c) => ({ ...c, items: c.items.map((item) => ({ ...item })), route: store.resolveChain(c.id).map((node) => node.name) })),
      },
      proxyConfigured: !!active,
      profiles: store.profiles.map(profileView),
      statuses: manager.statuses(),
    };
  }

  /**
   * The UI sends the placeholder when the user did not retype a stored
   * password; restore the saved value so editing another field does not wipe it.
   */
  function mergeProxy(incoming, previous) {
    const next = normalizeProxy(incoming);
    if (next.password === PASSWORD_PLACEHOLDER) next.password = normalizeProxy(previous).password;
    return next;
  }

  /** Resolve whatever the client sent into a real proxy: saved id or inline object. */
  function resolveProxyInput(body) {
    if (body.proxyId) {
      const saved = store.settings.proxies.find((p) => p.id === body.proxyId);
      if (!saved) throw new Error('代理不存在');
      return normalizeProxy(saved);
    }
    const incoming = normalizeProxy(body.proxy);
    if (incoming.password !== PASSWORD_PLACEHOLDER) return incoming;
    // Placeholder with no id: match against the saved entry with the same endpoint.
    const previous = store.settings.proxies.find(
      (p) => p.host === incoming.host && String(p.port) === String(incoming.port) && p.username === incoming.username
    );
    return mergeProxy(incoming, previous || {});
  }

  const routes = [
    ['GET', /^\/api\/state$/, async () => state()],

    ['POST', /^\/api\/settings$/, async (req, res, match, body) => {
      store.updateSettings({ ...body });
      return state();
    }],

    ['POST', /^\/api\/url-presets$/, async (req, res, match, body) => {
      const url = store.addUrlPreset(body.url);
      return { url, state: state() };
    }],
    ['DELETE', /^\/api\/url-presets$/, async (req, res, match, body, requestUrl) => {
      store.removeUrlPreset(requestUrl.searchParams.get('url'));
      return { state: state() };
    }],

    // --- saved proxy nodes ---
    ['POST', /^\/api\/proxies$/, async (req, res, match, body) => {
      if (body.node) {
        store.addProxyNode(body.node);
        return { state: state() };
      }
      // Accepts a pasted list ("一行一个") and/or a single structured proxy.
      const inputs = [];
      const { proxies: parsed, errors } = parseProxyList(body.list || '');
      inputs.push(...parsed);
      if (body.proxy && normalizeProxy(body.proxy).host) inputs.push(normalizeProxy(body.proxy));
      if (!inputs.length) {
        throw new Error(errors.length ? `没有可用的代理：${errors.join('；')}` : '请填写至少一个代理');
      }
      const { added, duplicates } = store.addProxies(inputs);
      if (body.activate && added.length) store.setActiveProxy(added[0].id);
      return { added: added.length, duplicates: duplicates.length, errors, state: state() };
    }],

    ['PATCH', /^\/api\/proxies\/([\w-]+)$/, async (req, res, match, body) => {
      const id = match[1];
      const current = store.settings.proxies.find((p) => p.id === id);
      if (!current) throw new Error('代理不存在');
      const input = body.proxy ? { ...body, ...body.proxy } : body;
      store.updateProxy(id, { ...input, ...mergeProxy({ ...current, ...input }, current) });
      return { state: state() };
    }],

    ['POST', /^\/api\/proxies\/([\w-]+)\/copy$/, async (req, res, match, body) => {
      const created = store.copyProxy(match[1], body.count);
      return { created: created.length, state: state() };
    }],

    ['DELETE', /^\/api\/proxies\/([\w-]+)$/, async (req, res, match) => {
      store.deleteProxy(match[1]);
      return { state: state() };
    }],

    ['POST', /^\/api\/chains$/, async (req, res, match, body) => {
      store.addChain(body);
      return { state: state() };
    }],
    ['PATCH', /^\/api\/chains\/([\w-]+)$/, async (req, res, match, body) => {
      store.updateChain(match[1], body);
      return { state: state() };
    }],
    ['DELETE', /^\/api\/chains\/([\w-]+)$/, async (req, res, match) => {
      store.deleteChain(match[1]);
      return { state: state() };
    }],
    ['POST', /^\/api\/chains\/([\w-]+)\/copy$/, async (req, res, match, body) => {
      const created = store.copyChain(match[1], body.count);
      return { created: created.length, state: state() };
    }],

    ['POST', /^\/api\/proxy\/test$/, async (req, res, match, body) => {
      let proxy;
      let upstreamProxy = null;
      let chain = null;
      if (body.profileId) {
        const profile = store.getProfile(body.profileId);
        if (!profile) throw new Error('profile 不存在');
        proxy = store.effectiveProxy(profile);
        upstreamProxy = profile.upstreamProxy?.enabled ? profile.upstreamProxy : null;
        chain = store.effectiveProxyChain(profile);
        if (!chain.length) return { ok: false, error: '该 profile 未配置代理' };
      } else if (body.chainId || body.proxyId) {
        chain = body.chainId ? store.resolveChain(body.chainId) : store.resolveProxyChain(body.proxyId);
        proxy = chain.at(-1);
      } else {
        proxy = resolveProxyInput(body);
      }
      if (!proxy?.host && !upstreamProxy?.host) return { ok: false, error: '没有选中任何代理' };
      const result = await testProxy(proxy, { upstreamProxy, chain });
      return { ...result, proxyLabel: describeProxy(proxy) };
    }],

    // Single source of truth for proxy-string parsing, shared with the UI's
    // "paste a proxy line" field.
    ['POST', /^\/api\/proxy\/parse$/, async (req, res, match, body) => ({
      proxy: parseProxyLine(body.line),
    })],

    ['POST', /^\/api\/profiles$/, async (req, res, match, body) => {
      const profile = store.createProfile({
        name: body.name,
        mode: MODES.includes(body.mode) ? body.mode : undefined,
        proxyMode: body.proxyChainId ? 'chain' : body.proxyNodeId ? 'node' : body.proxyMode === 'none' ? 'none' : PROXY_MODES.includes(body.proxyMode) ? body.proxyMode : 'none',
        proxyNodeId: body.proxyNodeId,
        proxyChainId: body.proxyChainId,
        proxy: normalizeProxy(body.proxy),
        upstreamProxy: body.upstreamProxy,
        startUrl: body.startUrl,
        note: body.note,
        // The new-profile dialog has a port field; honour it instead of always
        // auto-allocating (store.createProfiles validates and de-duplicates).
        port: body.port,
      });
      return { profile: profileView(profile), state: state() };
    }],

    ['POST', /^\/api\/profiles\/batch$/, async (req, res, match, body) => {
      if (body.proxyNodeId !== undefined || body.proxyChainId !== undefined) {
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('数量需在 1-200 之间');
        const created = store.createProfiles(Array.from({ length: count }, (_, index) => ({
          name: `${String(body.prefix || 'profile').trim() || 'profile'}-${index + 1}`,
          mode: MODES.includes(body.mode) ? body.mode : store.settings.defaultMode,
          startUrl: body.startUrl,
          proxyMode: body.proxyChainId ? 'chain' : body.proxyNodeId ? 'node' : 'none',
          proxyNodeId: body.proxyNodeId, proxyChainId: body.proxyChainId,
        })));
        return { created: created.length, errors: [], note: '', state: state() };
      }
      const prefix = String(body.prefix || 'profile').trim() || 'profile';
      const mode = MODES.includes(body.mode) ? body.mode : store.settings.defaultMode;
      const startUrl = String(body.startUrl || '').trim();
      const { proxies, errors } = parseProxyList(body.proxyList || '');

      const count = Number(body.count) || 0;
      const shortage = body.shortage;
      let inputs;
      let note = '';
      let pendingGlobalProxy = null;

      if (proxies.length) {
        const total = Math.max(proxies.length, count);
        if (total > 200) throw new Error('一次最多创建 200 个 profile');

        // Fewer proxies than profiles is ambiguous -- ask the user rather than
        // silently picking one meaning. Nothing is created on this round-trip.
        if (total > proxies.length && !shortage) {
          return { needsChoice: true, proxyCount: proxies.length, count: total, errors };
        }

        if (shortage === 'setGlobal') {
          // The proxy pool is only touched after createProfiles() below has
          // accepted every input -- otherwise a validation failure (e.g. a
          // start URL without a scheme) would abort the batch while silently
          // leaving the user's global proxy replaced.
          pendingGlobalProxy = { ...proxies[0], enabled: true };
          inputs = Array.from({ length: total }, (unused, index) => ({
            name: `${prefix}-${index + 1}`,
            mode,
            proxyMode: 'global',
            startUrl,
          }));
          note = `已把 ${describeProxy(proxies[0])} 设为全局代理，${total} 个 profile 全部跟随全局`;
        } else {
          // 'cycle' reuses the list in order; 'global' gives the surplus
          // profiles the global proxy instead of a copied one.
          const useGlobalForSurplus = shortage === 'global';
          inputs = Array.from({ length: total }, (unused, index) => {
            const surplus = index >= proxies.length;
            return {
              name: `${prefix}-${index + 1}`,
              mode,
              proxyMode: surplus && useGlobalForSurplus ? 'global' : 'custom',
              proxy: surplus && useGlobalForSurplus ? undefined : proxies[index % proxies.length],
              startUrl,
            };
          });
          if (total > proxies.length) {
            note = useGlobalForSurplus
              ? `前 ${proxies.length} 个用粘贴的代理，其余 ${total - proxies.length} 个跟随全局代理`
              : `${proxies.length} 条代理循环分配给了 ${total} 个 profile`;
          }
        }
      } else {
        if (!Number.isInteger(count) || count < 1 || count > 200) {
          throw new Error('数量需在 1-200 之间，或粘贴一份代理列表');
        }
        inputs = Array.from({ length: count }, (unused, index) => ({
          name: `${prefix}-${index + 1}`,
          mode,
          proxyMode: 'global',
          startUrl,
        }));
      }

      const created = store.createProfiles(inputs);
      if (pendingGlobalProxy) {
        const { added, duplicates } = store.addProxies([pendingGlobalProxy]);
        store.setActiveProxy((added[0] || duplicates[0]).id);
      }
      return { created: created.length, errors, note, state: state() };
    }],

    ['PATCH', /^\/api\/profiles\/([\w-]+)$/, async (req, res, match, body) => {
      const id = match[1];
      const current = store.getProfile(id);
      if (!current) throw new Error('profile 不存在');
      const patch = { ...body };
      if (patch.proxy !== undefined) patch.proxy = mergeProxy(patch.proxy, current.proxy);
      if (patch.upstreamProxy !== undefined) patch.upstreamProxy = mergeProxy(patch.upstreamProxy, current.upstreamProxy);
      const profile = store.updateProfile(id, patch);
      return { profile: profileView(profile), state: state() };
    }],

    ['DELETE', /^\/api\/profiles\/([\w-]+)$/, async (req, res, match, body, url) => {
      const id = match[1];
      if (['running', 'starting', 'stopping'].includes(manager.statusOf(id).status)) {
        await manager.stop(id);
      }
      store.deleteProfile(id, { purge: url.searchParams.get('purge') === '1' });
      manager.runners.delete(id);
      return { state: state() };
    }],

    ['POST', /^\/api\/profiles\/([\w-]+)\/start$/, async (req, res, match) => {
      await manager.start(match[1]);
      return { status: manager.statusOf(match[1]) };
    }],

    ['POST', /^\/api\/profiles\/([\w-]+)\/stop$/, async (req, res, match) => {
      await manager.stop(match[1]);
      return { status: manager.statusOf(match[1]) };
    }],

    ['POST', /^\/api\/profiles\/([\w-]+)\/open$/, async (req, res, match, body) => {
      const tab = await manager.openUrl(match[1], body.url);
      return { tab };
    }],

    ['GET', /^\/api\/profiles\/([\w-]+)\/logs$/, async (req, res, match) => ({
      logs: manager.logs(match[1]),
    })],

    ['POST', /^\/api\/bulk\/start$/, async (req, res, match, body) => {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const results = [];
      const token = ++bulkStartToken;
      // Sequential: a browser launch is CPU/RAM heavy, and parallel launches
      // behind the same proxy tend to trip bot detection.
      for (const id of ids) {
        // A bulk stop (or another bulk start) invalidates this run -- without
        // this check "停止全部" reports success while the loop keeps launching
        // the profiles it just stopped.
        if (token !== bulkStartToken) {
          results.push({ id, ok: false, error: '批量启动已被取消' });
          continue;
        }
        try {
          await manager.start(id);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err?.message || String(err) });
        }
      }
      const cancelled = results.filter((r) => r.error === '批量启动已被取消').length;
      return { results, cancelled };
    }],

    ['POST', /^\/api\/bulk\/stop$/, async (req, res, match, body) => {
      bulkStartToken += 1; // cancel any in-flight bulk start
      const ids = Array.isArray(body.ids) && body.ids.length
        ? body.ids
        : store.profiles.map((p) => p.id);
      await Promise.allSettled(ids.map((id) => manager.stop(id)));
      return { state: state() };
    }],
  ];

  return async function handleApi(req, res, url) {
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.once('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return true;
    }

    // Several routes share a path with different methods (PATCH/DELETE on
    // /api/profiles/:id), so collect every path match first and pick by method
    // -- matching on path alone would 405 the second route of a pair.
    const pathMatches = routes
      .map(([method, pattern, handler]) => ({ method, handler, match: url.pathname.match(pattern) }))
      .filter((route) => route.match);

    if (pathMatches.length) {
      const route = pathMatches.find((candidate) => candidate.method === req.method);
      if (!route) {
        const allowed = [...new Set(pathMatches.map((candidate) => candidate.method))];
        res.setHeader('allow', allowed.join(', '));
        send(res, 405, { error: `${url.pathname} 不支持 ${req.method}，只支持 ${allowed.join('/')}` });
        return true;
      }
      const { method, handler, match } = route;
      try {
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        const result = await handler(req, res, match, body, url);
        // Routes that changed the profile list or settings hand back a fresh
        // state; push it to every other open tab.
        if (result?.state) broadcast('state', result.state);
        else if (url.pathname === '/api/settings') broadcast('state', result);
        send(res, 200, result ?? { ok: true });
      } catch (err) {
        send(res, 400, { error: err?.message || String(err) });
      }
      return true;
    }

    if (url.pathname.startsWith('/api/')) {
      send(res, 404, { error: '接口不存在' });
      return true;
    }
    return false;
  };
}
