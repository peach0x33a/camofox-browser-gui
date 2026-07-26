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
import { describeProxy, proxyEnv } from './proxy.js';

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

export class Manager extends EventEmitter {
  /** Ports claimed by in-flight or running launches (see #resolvePort). */
  #reservedPorts = new Set();

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

  #buildEnv(profile, port) {
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

    Object.assign(env, proxyEnv(this.store.effectiveProxy(profile)));
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

  #spawnServer(profile, port, camofoxDir) {
    const env = this.#buildEnv(profile, port);
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: camofoxDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
        const health = await fetchJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 3000 });
        if (health?.ok) return health;
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('等待服务就绪超时');
  }

  async start(id) {
    const profile = this.store.getProfile(id);
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

    const seq = ++runner.launchSeq;
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

    try {
      const port = await this.#resolvePort(profile);
      abortIfSuperseded();
      const proxy = this.store.effectiveProxy(profile);
      const startUrl = this.store.effectiveStartUrl(profile);

      runner.port = port;
      this.#log(id, `启动 ${profile.name}｜端口 ${port}｜模式 ${profile.mode === 'visible' ? '可见窗口' : '无头'}`);
      this.#log(id, `代理: ${proxy ? describeProxy(proxy) : '不使用代理'}`);
      if (profile.mode === 'visible' && !process.env.DISPLAY) {
        this.#log(id, '当前环境没有 DISPLAY，窗口将无法显示，会回退到无头模式', 'warn');
      }

      // Re-check immediately before spawning: this is the last moment at which
      // aborting costs nothing.
      abortIfSuperseded();
      const proc = this.#spawnServer(profile, port, camofoxDir);
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
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
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

  async stop(id) {
    const profile = this.store.getProfile(id);
    const runner = this.runner(id);

    // Cancel any in-flight start() -- without this a stop that lands before
    // the child is spawned is a no-op and the launch continues to completion.
    runner.launchSeq += 1;

    if (!runner.proc) {
      this.#setStatus(id, 'stopped');
      return this.statusOf(id);
    }
    this.#setStatus(id, 'stopping');
    this.#log(id, '正在停止…');

    // Ask the server to close the session first so cookies/localStorage are
    // checkpointed by the persistence plugin before the process goes away.
    if (profile) {
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
    const target = String(url || '').trim() || this.store.effectiveStartUrl(profile);
    if (!/^https?:\/\//i.test(target)) throw new Error('网址必须以 http:// 或 https:// 开头');
    const tab = await fetchJson(`http://127.0.0.1:${runner.port}/tabs`, {
      method: 'POST',
      timeoutMs: BROWSER_TIMEOUT_MS,
      body: { userId: profile.id, sessionKey: 'gui', url: target },
    });
    this.#log(id, `已打开 ${tab?.url || target}`);
    return tab;
  }

  async #pollHealth() {
    for (const runner of this.runners.values()) {
      if (runner.status !== 'running' || !runner.port) continue;
      try {
        const health = await fetchJson(`http://127.0.0.1:${runner.port}/health`, { timeoutMs: 3000 });
        const previous = runner.health;
        runner.health = health;
        if (previous?.browserConnected !== health?.browserConnected) {
          this.emit('status', this.statusOf(runner.id));
        }
      } catch {
        runner.health = null;
      }
    }
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
