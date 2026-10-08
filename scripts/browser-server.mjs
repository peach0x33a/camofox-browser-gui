import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Windows kill(SIGTERM) terminates immediately. Bridge private parent IPC to
// upstream's existing graceful shutdown handler so it can persist and close Firefox.
let ready = false;
let requested = false;
function shutdown() {
  requested = true;
  if (ready) process.emit('SIGTERM');
}
process.on('message', (message) => {
  if (message?.type === 'camofox-gui-shutdown') shutdown();
});
process.on('disconnect', shutdown);
await import(pathToFileURL(path.resolve('server.js')).href);
ready = true;
if (requested) shutdown();
