# 2026-10-01：窗口生命周期与前置代理

## 用户请求

- 排查偶发浏览器窗口弹出、关闭后再闪现一次的问题。
- 在每个实例的设置和新建实例时增加前置代理。

## 实现

- 确认当前上游定时健康探测会创建 context/page 并打开 about:blank；部分恢复路径会再启动浏览器。
- desktop/lifecycle.js 为可见模式提供被动探活适配和 /desktop/status；通过关闭事件同步设置禁止重启标记并发 IPC 通知。窗口关闭后阻止重新创建上下文和页面。带参数的正常上下文创建与无头行为保持原样。
- Manager 可见模式不调用 /health；健康轮询不重入且拒绝过期结果；IPC 触发停止；停止请求合并；运行时使用启动配置快照；修复 spawn 失败后等待永不出现的 exit 事件的问题。
- 新增 src/proxy-chain.js：每次启动建立仅监听 loopback 的 HTTP 转发器，依次通过前置和实例代理连接目标。支持 HTTP CONNECT、HTTPS 代理和 SOCKS5 认证；HTTPS 代理默认校验证书；失败不直连；随启动失败/停止/进程退出清理所有连接和监听器。
- Store/API 添加 upstreamProxy，旧配置默认关闭。状态接口打码密码，编辑返回占位符时恢复原密码。新建/编辑表单显示独立开关、协议、地址、端口、用户名、密码、粘贴框和重启生效提示；列表显示已启用的前置代理。
- 插件路由与环境变量读取分文件，添加 OpenAPI 注释和插件协议版本。安装脚本复制生命周期文件，已更新本机同级插件；未改动上游核心 server.js 或已有插件注册配置。

## 修改位置

src/manager.js、src/proxy.js、src/proxy-chain.js、src/store.js、src/api.js；public/app.js、public/index.html、public/style.css；camofox-browser-plugin/desktop/；scripts/install-plugin.sh、scripts/verify-browser.mjs；package.json、README.md、.gitignore；test/。

## 验证

- npm test：29/29，通过九种协议组合、HTTP/CONNECT/TLS、前置认证失败及配置损坏不旁路、HTTPS 证书验证、连接回收、可见/无头生命周期、并发停止、启动取消、spawn 失败、API 密码回填及旧配置兼容等检查。
- 真实浏览器：PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/peach0x33a/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome xvfb-run -a node scripts/verify-browser.mjs。新建与编辑交互通过，真实可见 Camoufox 验证连续三次探活没有创建新窗口或导航当前页面，最后一页关闭立即禁止新页面/上下文和重启。
- 截图：.impeccable/review/desktop.png、mobile-top.png、mobile.png。独立界面复核 disposition 为 ship；继承的字号层级 detector warning 未作为本次重设计处理。
- 18 个 JavaScript 文件、2 个 shell 文件语法检查通过；git diff --check 通过。
- 上游 npm run generate-openapi 无生成差异；npm test -- tests/unit/openapi.test.js：16/16。
- 使用临时数据、本地代理 fixture 和独立 Xvfb，未读取或修改用户既有 profile/代理凭据。测试证书为专用本地自签名 fixture。

## 生效与边界

- 本机 desktop 插件已安装。重启 GUI 和已有实例后使用新逻辑；未替用户关闭正在使用的实例。
- 前置代理处理浏览器访问链路；内核/GeoIP 等下载仍使用系统 http_proxy / https_proxy。
- 后续升级 camofox-browser 时需验证其无参数 newContext 探活调用契约。
- 当前改动留在工作区，未提交或推送。
