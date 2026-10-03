# 2026-10-03 代理链路

用户要求新增“代理链路”面板，允许代理节点自由组合前置关系，并用“是否展示在列表”控制实例可选节点。

- 扩展 `src/store.js`：节点名称、前置引用、可见性、环路及依赖约束、旧配置迁移和实例节点引用。
- 扩展 `src/proxy.js`、`src/proxy-chain.js`、`src/manager.js`、`src/api.js`：任意长度 HTTP / HTTPS / SOCKS5 链路在启动和测试时按序连接；失败不直连，密码不在状态 API 中明文输出。
- 更新 `public/index.html`、`public/app.js`、`public/style.css`：节点管理、批量导入、链路预览、可见性控制、实例单节点选择和窄屏布局。
- 更新 `README.md`、`docs/proxy-chain.png`，扩展 `test/` 与 `scripts/verify-browser.mjs`。

验证：`npm test` 34/34；`git diff --check`；真实 Camoufox 和浏览器界面验证通过。测试覆盖四跳混合代理、深层节点失败、旧配置迁移、密码遮罩、环路与删除约束、直接单节点启动和转发器回收。预览服务在 `127.0.0.1:8791`，使用独立临时配置目录。

未提交或推送；未操作现有用户配置或正在运行的实例。正式运行需重启 GUI 和要应用新链路的实例。
