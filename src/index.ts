import { registry } from './core/registry';
import { runtime } from './core/runtime';
import { dataDir, userWidgetsDir } from './paths';
import { attachScreenStream } from './screen-stream';
import { createServer } from './server';

const PORT = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  await registry.load();

  const app = createServer();
  const server = app.listen(PORT, () => {
    console.log(`BUSY Web OS → http://localhost:${PORT}`);
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
