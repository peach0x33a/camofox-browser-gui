/**
 * Process manager: one camofox-browser server instance per profile.
 *
 * camofox-browser reads its proxy and storage paths from the environment and
 * runs a single Camoufox instance per process, so per-profile proxies mean one
 * process per profile -- each on its own port, with its own profile/cookie dirs.
 *
 * Launch sequence:
 *   spawn node server.js  ->  wait for GET /health  ->  POST /start (warm the
 *   browser)  ->  POST /tabs (open the start URL, which is what actually makes
 *   a window appear in visible mode).
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { camoufoxInstalled, isCamofoxDir, profileDataDir } from './paths.js';
import { normalizeOpenUrl } from './store.js';
import { describeProxy, proxyEnv } from './proxy.js';
import { createProxyRelay } from './proxy-chain.js';

const LOG_LIMIT = 500;
const HEALTH_TIMEOUT_MS = 90_000;
const BROWSER_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 15_000;
/** ~7 days: long enough that manual browsing is never reaped, short enough to
 *  stay inside setTimeout's 32-bit ceiling. */
const KEEP_ALIVE_MS = 604_800_000;

function nowIso() {
  return new Date().toISOString();
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function fetchJson(url, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const message = parsed?.error || parsed?.message || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

/**
 * A visible profile owns one browser window. Once its browser is disconnected
 * or all pages are gone, keeping the node server alive only leaves a stale
 * "running" row that can cause the upstream server to warm a new window.
 */
export function visibleWindowClosed(profile, browser, health) {
  if (profile?.mode !== 'visible') return false;
  if (browser?.browserConnected === false || browser?.browserRunning === false) return true;
  if (health?.browserConnected === false || health?.browserRunning === false) return true;
  return Number.isInteger(health?.activeTabs) && health.activeTabs === 0;
}

export class Manager extends EventEmitter {
  /** Ports claimed by in-flight or running launches (see #resolvePort). */
  #reservedPorts = new Set();
  #healthPolling = false;

  constructor(store) {
    super();
    this.store = store;
    this.runners = new Map();
    this.healthTimer = setInterval(() => this.#pollHealth(), 5000);
    this.healthTimer.unref?.();
  }

  runner(id) {
    let runner = this.runners.get(id);
    if (!runner) {
      runner = {
        id,
        status: 'stopped',
        port: 0,
        pid: null,
        proc: null,
        error: '',
        startedAt: null,
        health: null,
        logs: [],
        // Identifies the in-flight start(). stop()/delete bump it so a launch
        // that is still between awaits knows it was cancelled -- without this a
        // stop landing before spawn() is silently swallowed and leaves an
        // unreferenced (orphan) server process behind.
        launchSeq: 0,
        spawnError: '',
        profile: null,
        proxyRelay: null,
        stopPromise: null,
      };
      this.runners.set(id, runner);
    }
    return runner;
  }

  /** Serializable status for the UI. */
  statusOf(id) {
    const runner = this.runner(id);
    return {
      id,
      status: runner.status,
      port: runner.port,
      pid: runner.pid,
      error: runner.error,
      startedAt: runner.startedAt,
      health: runner.health,
    };
  }

  statuses() {
    return this.store.profiles.map((profile) => this.statusOf(profile.id));
  }

  logs(id) {
    return this.runner(id).logs;
  }

  #log(id, line, level = 'info') {
    const runner = this.runner(id);
    const entry = { ts: nowIso(), level, line: String(line) };
    runner.logs.push(entry);
    if (runner.logs.length > LOG_LIMIT) runner.logs.splice(0, runner.logs.length - LOG_LIMIT);
    this.emit('log', { profileId: id, entry });
  }

  #setStatus(id, status, error = '') {
    const runner = this.runner(id);
    runner.status = status;
    runner.error = error;
    this.emit('status', this.statusOf(id));
  }

  #buildEnv(profile, port, launchProxy) {
    const env = {};
    // Start from the user's env (PATH/HOME/DISPLAY/XAUTHORITY are all needed)
    // but drop any camofox/proxy vars so the GUI is the only source of truth.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('PROXY_') || key.startsWith('CAMOFOX_') || key.startsWith('CAMOUFOX_')) continue;
      env[key] = value;
    }
    if (process.env.CAMOUFOX_EXECUTABLE) env.CAMOUFOX_EXECUTABLE = process.env.CAMOUFOX_EXECUTABLE;

    // Camoufox downloads its GeoIP database and the uBO addon with plain
    // fetch(), which ignores http(s)_proxy unless Node is told to honour it.
    // On a restricted network that download hangs, so opt in when the GUI was
    // itself started with proxy env vars. (Node <24 ignores the flag.)
    const proxyEnvSet = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']
      .some((key) => process.env[key]);
    if (proxyEnvSet && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';

    const dataDir = profileDataDir(profile.id);
    Object.assign(env, {
      CAMOFOX_PORT: String(port),
      CAMOFOX_BIND_HOST: '127.0.0.1',
      CAMOFOX_PROFILE_DIR: path.join(dataDir, 'profile'),
      CAMOFOX_COOKIES_DIR: path.join(dataDir, 'cookies'),
      CAMOFOX_TRACES_DIR: path.join(dataDir, 'traces'),
      CAMOFOX_CRASH_REPORT_ENABLED: this.store.settings.crashReport ? 'true' : 'false',
      // Camoufox startup behind a slow proxy easily exceeds the 30s default.
      HANDLER_TIMEOUT_MS: '120000',
      CAMOFOX_DESKTOP: '1',
    });

    if (profile.mode === 'visible') {
      Object.assign(env, {
        CAMOFOX_DESKTOP_DISPLAY: '1',
        // A human-driven window must not be reaped for being "idle" -- the
        // server only counts API traffic, not the user's own clicking.
        BROWSER_IDLE_TIMEOUT_MS: String(KEEP_ALIVE_MS),
        SESSION_TIMEOUT_MS: String(KEEP_ALIVE_MS),
        TAB_INACTIVITY_MS: String(KEEP_ALIVE_MS),
        MAX_TABS_PER_SESSION: '50',
      });
    }

    Object.assign(env, proxyEnv(launchProxy));
    return env;
  }

  async #resolvePort(profile) {
    const runner = this.runner(profile.id);
    // isPortFree only proves the port was free a moment ago, so a second
    // concurrent launch could pick the same one and lose the bind race.
    // #reservedPorts records a claim the instant it is made, and every other
    // in-flight launch sees it before its own scan.
    const reserve = (port) => {
      this.#reservedPorts.add(port);
      runner.port = port;
      return port;
    };
    if (profile.port && !this.#reservedPorts.has(profile.port) && await isPortFree(profile.port)) {
      return reserve(profile.port);
    }

    const busy = profile.port;
    let candidate = this.store.settings.basePort;
    const claimed = new Set(
      this.store.profiles.filter((p) => p.id !== profile.id).map((p) => p.port)
    );
    while (claimed.has(candidate) || this.#reservedPorts.has(candidate) || !(await isPortFree(candidate))) {
      candidate += 1;
      if (candidate > 65535) throw new Error('找不到可用端口');
    }
    if (busy) this.#log(profile.id, `端口 ${busy} 被占用，改用 ${candidate}`, 'warn');
    reserve(candidate);
    this.store.updateProfile(profile.id, { port: candidate });
    return candidate;
  }

  /** Give a port back to the pool once nothing is listening on it any more. */
  #releasePort(port) {
    if (port) this.#reservedPorts.delete(port);
  }

  #spawnServer(profile, port, camofoxDir, launchProxy, relay) {
    const env = this.#buildEnv(profile, port, launchProxy);
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: camofoxDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closeRelay = () => {
      relay?.close().catch(() => {});
      const runner = this.runners.get(profile.id);
      if (runner?.proxyRelay === relay) runner.proxyRelay = null;
    };
    proc.once('exit', closeRelay);
    proc.once('error', closeRelay);
    proc.on('message', (message) => {
      const runner = this.runners.get(profile.id);
      if (message?.type !== 'camofox-desktop-closed' || profile.mode !== 'visible' ||
          runner?.proc !== proc || !['starting', 'running'].includes(runner.status)) return;
      this.#log(profile.id, '浏览器窗口已关闭，正在停止实例');
      this.stop(profile.id, { skipSessionClose: true }).catch((err) => this.#log(profile.id, err.message, 'error'));
    });

    const pipe = (stream, level) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) this.#log(profile.id, line.trim(), level);
        }
      });
    };
    pipe(proc.stdout, 'info');
    pipe(proc.stderr, 'error');

    // spawn() reports failures (ENOENT when camofoxDir vanished, EMFILE under
    // fd pressure) as an async 'error' event. With no listener, Node rethrows
    // it from a nextTick callback -- outside every try/catch here -- and the
    // whole GUI dies, orphaning every running profile.
    proc.once('error', (err) => {
      const runner = this.runner(profile.id);
      this.#log(profile.id, `启动子进程失败: ${err.message}`, 'error');
      if (runner.proc !== proc) return;
      runner.proc = null;
      runner.pid = null;
      runner.health = null;
      runner.spawnError = err.message;
      this.#setStatus(profile.id, 'error', err.message);
    });

    proc.once('exit', (code, signal) => {
      const runner = this.runner(profile.id);
      if (runner.proc !== proc) return; // superseded by a newer launch
      runner.proc = null;
      runner.pid = null;
      runner.health = null;
      this.#releasePort(runner.port);
      const expected = runner.status === 'stopping';
      this.#log(profile.id, `进程退出 (code=${code} signal=${signal || '-'})`, expected ? 'info' : 'error');
      this.#setStatus(profile.id, expected ? 'stopped' : 'error', expected ? '' : `进程意外退出 (code=${code})`);
    });

    return proc;
  }

  async #waitForHealth(id, port, proc, deadline) {
    while (Date.now() < deadline) {
      const runner = this.runner(id);
      if (runner.spawnError) throw new Error(runner.spawnError);
      if (proc.exitCode !== null || proc.signalCode) throw new Error('服务进程已退出');
      try {
        const route = runner.profile?.mode === 'visible' ? '/desktop/status' : '/health';
        const health = await fetchJson(`http://127.0.0.1:${port}${route}`, { timeoutMs: 3000 });
        if (health?.ok) return health;
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('等待服务就绪超时');
  }

  /**
   * The desktop endpoint only observes state. Never call upstream /health for
   * visible instances: it can schedule a relaunch between the two probes.
   */
  async #inspectVisibleWindow(profile, port) {
    const health = await fetchJson(`http://127.0.0.1:${port}/desktop/status`, { timeoutMs: 3000 });
    return { closed: health?.closed === true || visibleWindowClosed(profile, health, health), health };
  }

  async start(id) {
    const profile = structuredClone(this.store.getProfile(id));
    if (!profile) throw new Error('profile 不存在');
    const runner = this.runner(id);
    if (runner.status === 'starting' || runner.status === 'running' || runner.status === 'stopping') {
      throw new Error('该 profile 正在运行中');
    }

    const camofoxDir = this.store.settings.camofoxDir;
    if (!isCamofoxDir(camofoxDir)) {
      throw new Error(`camofox-browser 目录无效: ${camofoxDir || '(未设置)'}`);
    }
    if (!fs.existsSync(path.join(camofoxDir, 'node_modules'))) {
      throw new Error(`${camofoxDir} 还没有安装依赖，请先在该目录执行 npm install`);
    }
    if (!camoufoxInstalled()) {
      throw new Error(
        `Camoufox 浏览器内核还没下载完（约 663MB）。请在 ${camofoxDir} 执行 npx camoufox-js fetch，` +
        `或用 CAMOUFOX_EXECUTABLE 指定已有的 camoufox-bin 后重启 GUI`
      );
    }
    if (profile.mode === 'visible') {
      const pluginDir = path.join(camofoxDir, 'plugins', 'desktop');
      let protocol;
      try { protocol = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).guiProtocol; } catch {}
      if (protocol !== 2 || !fs.existsSync(path.join(pluginDir, 'lifecycle.js')) ||
          !fs.existsSync(path.join(pluginDir, 'window-size.js'))) {
        throw new Error('请先运行 ./scripts/install-plugin.sh 更新 desktop 插件，再启动可见实例');
      }
    }

    const seq = ++runner.launchSeq;
    runner.profile = structuredClone(profile); // edits apply to the next launch
    runner.spawnError = '';
    this.#setStatus(id, 'starting');
    runner.startedAt = nowIso();
    runner.logs.length = 0;
    this.emit('log-reset', { profileId: id });

    // Every await below is a window in which stop()/delete/another start() can
    // land. They bump launchSeq; this check turns that into a clean abort
    // instead of a launch that resurrects a stopped profile or leaks a process.
    const abortIfSuperseded = () => {
      if (runner.launchSeq !== seq) throw new Error('启动已被取消');
    };
    // Tracked separately from runner.proc so the failure path always kills the
    // process *this* launch spawned, never a newer launch's process.
    let myProc = null;
    let myRelay = null;

    try {
      const port = await this.#resolvePort(profile);
      abortIfSuperseded();
      const chain = this.store.effectiveProxyChain(profile);
      const proxy = chain.at(-1) || null;
      const startUrl = this.store.effectiveStartUrl(profile);
      if (chain.length > 1) {
        myRelay = await createProxyRelay({ chain });
        abortIfSuperseded();
        runner.proxyRelay = myRelay;
      }

      runner.port = port;
      this.#log(id, `启动 ${profile.name}｜端口 ${port}｜模式 ${profile.mode === 'visible' ? '可见窗口' : '无头'}`);
      this.#log(id, `代理链路: ${chain.length ? chain.map((node) => describeProxy(node)).join(' → ') : '不使用代理'}`);
      if (profile.mode === 'visible' && !process.env.DISPLAY) {
        this.#log(id, '当前环境没有 DISPLAY，窗口将无法显示，会回退到无头模式', 'warn');
      }

      // Re-check immediately before spawning: this is the last moment at which
      // aborting costs nothing.
      abortIfSuperseded();
      const proc = this.#spawnServer(profile, port, camofoxDir, myRelay?.proxy || proxy, myRelay);
      myProc = proc;
      runner.proc = proc;
      runner.pid = proc.pid;

      const health = await this.#waitForHealth(id, port, proc, Date.now() + HEALTH_TIMEOUT_MS);
      abortIfSuperseded();
      runner.health = health;
      this.#log(id, `服务就绪 http://127.0.0.1:${port}`);

      this.#log(id, '正在启动 Camoufox（首次可能需要 1-2 分钟）…');
      await fetchJson(`http://127.0.0.1:${port}/start`, { method: 'POST', timeoutMs: BROWSER_TIMEOUT_MS });
      abortIfSuperseded();

      const tab = await fetchJson(`http://127.0.0.1:${port}/tabs`, {
        method: 'POST',
        timeoutMs: BROWSER_TIMEOUT_MS,
        body: { userId: profile.id, sessionKey: 'gui', url: startUrl },
      });
      abortIfSuperseded();
      this.#log(id, `已打开 ${tab?.url || startUrl}`);

      // The exit handler flips to 'error' if the process died meanwhile.
      if (runner.proc === proc) this.#setStatus(id, 'running');
      return this.statusOf(id);
    } catch (err) {
      const message = err?.message || String(err);
      this.#log(id, `启动失败: ${message}`, 'error');
      // Always reap the process this launch spawned, even when superseded --
      // otherwise it survives with nothing referencing it.
      await this.#killProcess(id, myProc, { silent: true });
      await myRelay?.close();
      if (runner.proxyRelay === myRelay) runner.proxyRelay = null;
      if (runner.proc === myProc) {
        runner.proc = null;
        runner.pid = null;
      }
      // Only release the port if a newer launch has not already claimed it.
      if (runner.launchSeq === seq) this.#releasePort(runner.port);
      // A concurrent stop()/start() owns the status now; don't overwrite it.
      const superseded = runner.launchSeq !== seq;
      const interrupted = runner.status === 'stopping' || runner.status === 'stopped';
      if (!superseded && !interrupted) this.#setStatus(id, 'error', message);
      // When a stop killed the child mid-request the raw error is a useless
      // "fetch failed"; report the actual cause instead.
      if (superseded) throw new Error('启动已被取消');
      throw err;
    }
  }

  /** SIGTERM a specific process, escalating to SIGKILL. Safe on null/dead procs. */
  async #killProcess(id, proc, { silent = false } = {}) {
    if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode) return;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try {
      proc.kill('SIGTERM');
    } catch {
      return; // already reaped
    }
    const timer = setTimeout(() => {
      if (!silent) this.#log(id, 'SIGTERM 超时，强制结束进程', 'warn');
      proc.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  async #kill(id, options = {}) {
    const runner = this.runner(id);
    const proc = runner.proc;
    // runner.proc is cleared only after the process is gone, so the 'exit'
    // handler still recognises it and logs the exit code.
    await this.#killProcess(id, proc, options);
    if (runner.proc === proc) {
      runner.proc = null;
      runner.pid = null;
    }
    this.#releasePort(runner.port);
  }

  async stop(id, { skipSessionClose = false } = {}) {
    const runner = this.runner(id);
    if (runner.stopPromise) return runner.stopPromise;
    runner.stopPromise = this.#stop(id, { skipSessionClose });
    try { return await runner.stopPromise; }
    finally { runner.stopPromise = null; }
  }

  async #stop(id, { skipSessionClose }) {
    const runner = this.runner(id);
    const profile = runner.profile || this.store.getProfile(id);

    // Cancel any in-flight start() -- without this a stop that lands before
    // the child is spawned is a no-op and the launch continues to completion.
    runner.launchSeq += 1;

    if (!runner.proc) {
      await runner.proxyRelay?.close();
      runner.proxyRelay = null;
      this.#setStatus(id, 'stopped');
      return this.statusOf(id);
    }
    this.#setStatus(id, 'stopping');
    this.#log(id, '正在停止…');

    // A browser window may have been closed between health polls. Do not send
    // a session request to an already-gone visible browser: the upstream
    // recovery path may launch a replacement window just before we kill it.
    let closeSession = !!profile && !skipSessionClose;
    if (closeSession && profile.mode === 'visible') {
      try {
        const inspection = await this.#inspectVisibleWindow(profile, runner.port);
        runner.health = inspection.health;
        if (inspection.closed) {
          closeSession = false;
          this.#log(id, '浏览器窗口已关闭，跳过会话关闭请求', 'info');
        }
      } catch {
        // A live server can briefly fail a probe while shutting down; retain
        // the normal checkpoint request unless closure was confirmed.
      }
    }

    // Ask the server to close the session first so cookies/localStorage are
    // checkpointed by the persistence plugin before the process goes away.
    if (closeSession) {
      try {
        await fetchJson(`http://127.0.0.1:${runner.port}/sessions/${encodeURIComponent(profile.id)}`, {
          method: 'DELETE',
          timeoutMs: 15_000,
        });
      } catch (err) {
        this.#log(id, `关闭会话失败（继续结束进程）: ${err.message}`, 'warn');
      }
    }

    await this.#kill(id);
    await runner.proxyRelay?.close();
    runner.proxyRelay = null;
    this.#setStatus(id, 'stopped');
    this.#log(id, '已停止');
    return this.statusOf(id);
  }

  /** Open another tab in a running profile. */
  async openUrl(id, url) {
    const profile = this.store.getProfile(id);
    if (!profile) throw new Error('profile 不存在');
    const runner = this.runner(id);
    if (runner.status !== 'running') throw new Error('该 profile 未在运行');
    const target = normalizeOpenUrl(String(url || '').trim() || this.store.effectiveStartUrl(profile));
    const tab = await fetchJson(`http://127.0.0.1:${runner.port}/tabs`, {
      method: 'POST',
      timeoutMs: BROWSER_TIMEOUT_MS,
      body: { userId: profile.id, sessionKey: 'gui', url: target },
    });
    this.#log(id, `已打开 ${tab?.url || target}`);
    return tab;
  }

  async #pollHealth() {
    if (this.#healthPolling) return;
    this.#healthPolling = true;
    try {
      for (const runner of this.runners.values()) {
        if (runner.status !== 'running' || !runner.port) continue;
        const profile = runner.profile || this.store.getProfile(runner.id);
        const proc = runner.proc;
        const seq = runner.launchSeq;
        try {
          let health;
          let closed = false;
          if (profile?.mode === 'visible') {
            const inspection = await this.#inspectVisibleWindow(profile, runner.port);
            health = inspection.health;
            closed = inspection.closed;
          } else {
            health = await fetchJson(`http://127.0.0.1:${runner.port}/health`, { timeoutMs: 3000 });
          }
          if (runner.proc !== proc || runner.launchSeq !== seq || runner.status !== 'running') continue;
          const previous = runner.health;
          runner.health = health;
          if (closed) {
            this.#log(runner.id, '检测到浏览器窗口已关闭，正在销毁实例');
            await this.stop(runner.id, { skipSessionClose: true });
            continue;
          }
          if (previous?.browserConnected !== health?.browserConnected) {
            this.emit('status', this.statusOf(runner.id));
          }
        } catch {
          if (runner.proc !== proc || runner.launchSeq !== seq || runner.status !== 'running') continue;
          if (runner.health !== null) {
            runner.health = null;
            this.emit('status', this.statusOf(runner.id));
          }
        }
      }
    } finally { this.#healthPolling = false; }
  }

  async stopAll() {
    // Include 'starting' runners that have no proc yet: stop() cancels their
    // in-flight launch, so shutdown can't race a spawn into an orphan.
    const active = [...this.runners.values()].filter((r) => r.proc || r.status === 'starting');
    await Promise.allSettled(active.map((r) => this.stop(r.id)));
  }

  dispose() {
    clearInterval(this.healthTimer);
  }
}
