#!/usr/bin/env bash
# 把 desktop 插件装进 camofox-browser 检出目录，并在 camofox.config.json 里注册。
# 可重复执行；不会覆盖已有的其他插件配置。
#
#   ./scripts/install-plugin.sh [camofox-browser 目录]
#
# 不带参数时，自动找同级目录 ../camofox-browser。
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HERE/../camofox-browser}"

if [ ! -f "$TARGET/server.js" ] || [ ! -f "$TARGET/camofox.config.json" ]; then
  echo "错误: $TARGET 不像是 camofox-browser 检出目录（缺 server.js 或 camofox.config.json）" >&2
  echo "用法: $0 [camofox-browser 目录]" >&2
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"
echo "目标: $TARGET"

mkdir -p "$TARGET/plugins/desktop"
cp "$HERE/camofox-browser-plugin/desktop/index.js" "$TARGET/plugins/desktop/index.js"
cp "$HERE/camofox-browser-plugin/desktop/lifecycle.js" "$TARGET/plugins/desktop/lifecycle.js"
cp "$HERE/camofox-browser-plugin/desktop/window-size.js" "$TARGET/plugins/desktop/window-size.js"
cp "$HERE/camofox-browser-plugin/desktop/plugin.json" "$TARGET/plugins/desktop/plugin.json"
echo "  ✓ 已复制 plugins/desktop/"

node - "$TARGET/camofox.config.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const config = JSON.parse(raw);

if (Array.isArray(config.plugins)) {
  if (config.plugins.includes('desktop')) {
    console.log('  = camofox.config.json 已注册 desktop，跳过');
    process.exit(0);
  }
  config.plugins.push('desktop');
} else {
  config.plugins = config.plugins && typeof config.plugins === 'object' ? config.plugins : {};
  if (config.plugins.desktop) {
    console.log('  = camofox.config.json 已注册 desktop，跳过');
    process.exit(0);
  }
  config.plugins.desktop = { enabled: true };
}

fs.writeFileSync(`${file}.bak`, raw);
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log('  ✓ 已在 camofox.config.json 注册 desktop（原文件备份为 camofox.config.json.bak）');
NODE

echo
echo "完成。插件在没有 CAMOFOX_DESKTOP_* 环境变量时不做任何事，"
echo "可见模式启用桌面生命周期管理；原始代理注入也支持无头模式。请重启 GUI 和实例。"
