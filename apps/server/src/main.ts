import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { Flow } from './flow.js';
import { makeApp } from './app.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
loadDotEnv({ path: '.env', quiet: true });
const config = loadConfig();
const store = new Store(config.databasePath, config.runtimeDir);
const owner = crypto.randomUUID();
store.acquireLease(owner);
const flow = new Flow(store, config);
const app = await makeApp(config, store, flow);
await app.listen({ port: config.port, host: '127.0.0.1' });
await flow.tick();
const interval = setInterval(() => void flow.tick(), 2000);
const leaseInterval = setInterval(() => {
  try { store.renewLease(owner); }
  catch { clearInterval(interval); clearInterval(leaseInterval); void app.close().then(() => process.exit(1)); }
}, 3000);
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(interval); clearInterval(leaseInterval);
    void app.close().then(() => { store.releaseLease(owner); store.db.close(); process.exit(0); });
  });
}
