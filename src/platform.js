import { spawn } from 'node:child_process';

export function browserOpenCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  // Pass the URL as a process argument without a shell interpreting it.
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function openInBrowser(url) {
  const [command, args] = browserOpenCommand(url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* The console also prints the URL for manual opening. */ }
}
