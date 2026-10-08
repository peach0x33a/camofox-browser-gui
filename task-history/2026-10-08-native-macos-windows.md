# macOS / Windows 原生适配

日期：2026-10-08

请求：评估并适配 macOS 和 Windows 原生使用。

改动：desktop 插件在 macOS / Windows 将 upstream headless launch options 切换为原生可见窗口，读取系统屏幕工作区并调整指纹窗口尺寸；Linux 继续使用真实 X display。Windows 指纹环境变量按 camoufox-js 的 2047 字符分段。插件 guiProtocol 升为 3，旧插件需要重装。

新增 Node 跨平台安装器（保留 Bash 包装）、Windows start.cmd、系统浏览器打开命令、Windows 内核缓存路径探测。Manager 通过 scripts/browser-server.mjs 启动上游；Windows 使用 IPC 调用上游 SIGTERM 事件处理，先保存会话并关闭浏览器，超时 taskkill /PID /T /F 仅清理该服务进程树。父进程断连也触发正常退出。无需修改同级 camofox-browser。

文件：src/main.js、src/platform.js、src/manager.js、src/paths.js、camofox-browser-plugin/desktop/、scripts/install-plugin.mjs、scripts/install-plugin.sh、scripts/browser-server.mjs、scripts/verify-browser.mjs、start.cmd、package.json、README.md、test/platform.test.js、test/window-size.test.js、test/manager-integration.test.js、.github/workflows/test.yml。

验证：npm test 50/50；Linux Xvfb 1280×800 真实浏览器集成通过（UI、代理链、1200×720 窗口、被动探活、最后一页关闭和禁止重启）；git diff --check 通过。默认 Playwright Chromium 1217 未安装，改用 PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/peach0x33a/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome 完成验证。测试使用临时配置和数据目录。

限制：本机只有 Linux，macOS / Windows 分支测试使用模拟平台和屏幕命令输出；原生窗口、权限、真实屏幕读取、Windows 进程树超时清理需要实机验收。CI 配置已添加但尚未发布运行。camoufox-js 0.10.2 不支持 Windows ARM64 原生内核。同级已安装插件和现有实例未改动。

发布：用户追加要求“提交推送”；本轮发布目标 `origin/main`，提交范围为上述适配、测试、CI、文档和任务记录，推送后核对本地 HEAD 与远端分支。
