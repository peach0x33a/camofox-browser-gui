# 2026-10-03 标签与平面布局

用户要求将控制台原有四个卡片改为标签、默认显示 Profiles，并去掉圆角卡片。

- `public/index.html`：增加 Profiles、代理链路、全局设置、运行日志四个标签和对应面板；初始仅显示 Profiles。
- `public/app.js`：点击与方向键、Home、End 切换标签，更新选中状态、焦点和面板可见性。
- `public/style.css`：移除卡片容器和弹窗的圆角，内容区改为平面布局，窄屏标签栏可滚动。
- `scripts/verify-browser.mjs`：检查初始面板、键盘与点击切换、窄屏无页面横向溢出，截图覆盖默认 Profiles 和代理链路；同步 `README.md` 截图。

验证：`npm test` 34/34；浏览器 UI 与真实 Camoufox 集成验证通过；桌面、手机截图人工检查。工作树保留先前未提交的代理链路和窗口生命周期修改；本次未提交或推送。
