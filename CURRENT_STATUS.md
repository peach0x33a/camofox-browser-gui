# 当前状态

更新日期：2026-10-08

工作区：`/home/peach0x33a/workspace/fingerprint/camofox-gui`。同级服务：`../camofox-browser`。

已完成 macOS / Windows 原生适配代码：跨平台安装器 `npm run install-plugin`、Windows `start.cmd`、系统浏览器自动打开、Windows 内核目录探测、原生可见窗口及屏幕尺寸约束、Windows 2047 字符指纹分段、IPC 正常退出和超时进程树清理。Linux 可见窗口保持 X display 路径。desktop 插件 guiProtocol 已升至 3，使用新 GUI 前须重装插件并重启实例。

原有 Profiles / 代理节点 / 嵌套链路 / 工具 / 预设 / 日志功能保留。运行数据默认仍在 `~/.camofox-gui`；本次未操作现有数据、实例或同级已安装插件。此前记录中的服务终端会话不作为本轮已核实状态。

验证：离线测试 50/50；Linux Xvfb 真实浏览器集成通过，覆盖 UI、代理链、窗口尺寸、被动探活和最后一页关闭。macOS / Windows 原生实机验收尚未完成。三平台 Node 24 GitHub Actions 离线测试矩阵已添加但未运行。本轮发布目标为 `origin/main`，包含适配代码、测试、文档和任务记录；原生实机验收仍为后续事项。

使用：安装 Node 24 和 Git，clone GUI 和同级服务，在服务目录执行 `npm install`、`npx camoufox-js fetch`，回 GUI 执行 `npm run install-plugin`、`npm start`。完整平台步骤见 README。

记录：[本轮原生适配](task-history/2026-10-08-native-macos-windows.md)、[此前工具界面](task-history/2026-10-04-account-totp-progress.md)。
