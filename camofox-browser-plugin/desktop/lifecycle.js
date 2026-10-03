/** One visible browser lifetime per GUI instance; observation never opens pages. */
export function installVisibleLifecycle(app, { events, log, auth }, notify = (message) => {
  try { if (process.connected) process.send(message, () => {}); } catch { /* GUI polling is the fallback. */ }
}) {
  let browser = null;
  let launched = false;
  let closed = false;
  let shuttingDown = false;
  const pages = new Set();
  const contexts = new WeakSet();

  const close = (reason) => {
    if (closed || shuttingDown) return;
    closed = true; // latch synchronously, before upstream recovery can run
    log('info', 'desktop window closed; automatic relaunch disabled', { reason });
    notify({ type: 'camofox-desktop-closed', reason });
  };
  const trackPage = (page) => {
    if (page.isClosed() || pages.has(page)) return;
    pages.add(page);
    page.once('close', () => {
      pages.delete(page);
      if (!pages.size) close('last_page_closed');
    });
  };
  const trackContext = (context) => {
    if (contexts.has(context)) return;
    contexts.add(context);
    const newPage = context.newPage?.bind(context);
    if (newPage) context.newPage = async (...args) => {
      if (closed || shuttingDown) throw new Error('可见窗口已关闭，请在 GUI 中重新启动实例');
      return newPage(...args);
    };
    context.on('page', trackPage);
    context.pages().forEach(trackPage);
  };

  events.on('browser:launching', () => {
    if (closed || launched || shuttingDown) {
      throw new Error('可见窗口已关闭，请在 GUI 中重新启动实例');
    }
  });
  events.on('browser:launched', ({ browser: instance }) => {
    browser = instance;
    launched = true;
    instance.once('disconnected', () => close('browser_disconnected'));
    instance.contexts().forEach(trackContext);

    // Upstream's periodic health probe calls newContext() without options, then
    // opens/navigates/closes about:blank. In headed Firefox that is a flashing
    // window. Session creation always supplies options. Adapt only the no-options
    // probe to evaluate a harmless expression in an existing page, without
    // navigating or closing that page. Headless mode never installs this adapter.
    const newContext = instance.newContext.bind(instance);
    instance.newContext = async (options, ...rest) => {
      if (options !== undefined) {
        if (closed || shuttingDown) throw new Error('可见窗口已关闭，请在 GUI 中重新启动实例');
        return newContext(options, ...rest);
      }
      return {
        newPage: async () => ({
          goto: async (url, { timeout = 5000 } = {}) => {
            if (url !== 'about:blank') throw new Error('Desktop health probe only supports about:blank');
            if (closed || shuttingDown || !instance.isConnected()) throw new Error('Browser is closed');
            const page = [...pages].find((p) => !p.isClosed());
            if (!page) return; // browser may still be warming before the first tab
            let timer;
            try {
              await Promise.race([
                page.evaluate(() => 1),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error('Desktop health probe timed out')), timeout);
                }),
              ]);
            } finally { clearTimeout(timer); }
          },
          close: async () => {},
        }),
        close: async () => {},
      };
    };
  });
  events.on('session:created', ({ context }) => trackContext(context));
  events.on('server:shutdown', () => { shuttingDown = true; });

  /**
   * @openapi
   * /desktop/status:
   *   get:
   *     tags: [System]
   *     summary: Read visible desktop lifecycle state without launching or recovering a browser.
   *     responses:
   *       200:
   *         description: Passive state (desktop plugin in visible mode only).
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 desktopProtocol:
   *                   type: integer
   *                 browserConnected:
   *                   type: boolean
   *                 browserRunning:
   *                   type: boolean
   *                 activeTabs:
   *                   type: integer
   *                 closed:
   *                   type: boolean
   */
  app.get('/desktop/status', ...(auth ? [auth()] : []), (_req, res) => res.json({
    ok: true,
    desktopProtocol: 1,
    browserConnected: browser?.isConnected() ?? false,
    browserRunning: browser?.isConnected() ?? false,
    activeTabs: [...pages].filter((page) => !page.isClosed()).length,
    closed,
  }));
}
