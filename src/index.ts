import { registry } from './core/registry';
import { runtime } from './core/runtime';
import { dataDir, userWidgetsDir } from './paths';
import { attachScreenStream } from './screen-stream';
import { createServer } from './server';

const PORT = Number(process.env.PORT) || 3000;
// Loopback by default: the API has no auth and /api/settings returns tokens.
// Set HOST=0.0.0.0 to expose on the LAN (e.g. phone as a buzzer remote).
const HOST = process.env.HOST || '127.0.0.1';

async function main(): Promise<void> {
  await registry.load();

  const app = createServer();
  const server = app.listen(PORT, HOST, () => {
    console.log(`BUSY Web OS → http://localhost:${PORT}`);
    if (HOST === '127.0.0.1') {
      console.log('Listening on loopback only — run with HOST=0.0.0.0 to allow LAN access (phone buzzer)');
    }
    console.log(`Data: ${dataDir} · your own widgets go in ${userWidgetsDir}`);
  });
  attachScreenStream(server);

  const shutdown = async () => {
    console.log('\nStopping widgets…');
    await runtime.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
