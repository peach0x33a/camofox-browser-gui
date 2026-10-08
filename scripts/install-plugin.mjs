import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function installPlugin(target) {
  target = path.resolve(target);
  const configFile = path.join(target, 'camofox.config.json');
  if (!fs.existsSync(path.join(target, 'server.js')) || !fs.existsSync(configFile)) {
    throw new Error(`${target} 缺少 server.js 或 camofox.config.json，不是有效的 camofox-browser 目录`);
  }
  const raw = fs.readFileSync(configFile, 'utf8');
  const config = JSON.parse(raw);
  const source = fileURLToPath(new URL('../camofox-browser-plugin/desktop/', import.meta.url));
  const destination = path.join(target, 'plugins', 'desktop');
  fs.mkdirSync(destination, { recursive: true });
  for (const file of ['index.js', 'lifecycle.js', 'window-size.js', 'plugin.json']) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
  let changed = false;
  if (Array.isArray(config.plugins)) {
    if (!config.plugins.includes('desktop')) { config.plugins.push('desktop'); changed = true; }
  } else {
    config.plugins = config.plugins && typeof config.plugins === 'object' ? config.plugins : {};
    if (!config.plugins.desktop || config.plugins.desktop.enabled === false) {
      config.plugins.desktop = { ...(config.plugins.desktop || {}), enabled: true };
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(`${configFile}.bak`, raw);
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv[2] || fileURLToPath(new URL('../../camofox-browser/', import.meta.url));
    console.log(`desktop 插件已安装: ${installPlugin(target)}。请重启 GUI 和实例。`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
