import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Config } from '../apps/server/src/config.js';
import { Store } from '../apps/server/src/db.js';
import { Flow } from '../apps/server/src/flow.js';
import { makeApp } from '../apps/server/src/app.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('roles, CSRF, input validation and idempotency protect order actions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dakar-api-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'app.sqlite'), dir);
  const codes = JSON.parse(fs.readFileSync(path.join(dir, 'demo-access.json'), 'utf8')) as Record<string,string>;
  const node = { url: 'https://127.0.0.1:1', cert: Buffer.alloc(0), macaroon: '' };
  const config: Config = { port: 0, origin: 'http://127.0.0.1:3000', databasePath: path.join(dir, 'app.sqlite'),
    runtimeDir: dir, nodes: { buyer: node, seller: node, courier: node }, releaseKey: crypto.randomBytes(32) };
  const app = await makeApp(config, store, new Flow(store, config));
  const home = await app.inject({ method: 'GET', url: '/' });
  expect(home.statusCode).toBe(200);
  expect(home.headers['content-security-policy']).toContain("default-src 'self'");
  async function login(role: 'buyer'|'seller') {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { role, code: codes[role] } });
    expect(response.statusCode).toBe(200);
    return { cookie: response.headers['set-cookie'] as string, csrf: response.json().csrf as string };
  }
  const seller = await login('seller');
  const buyer = await login('buyer');
  const created = store.createOrder({ description: 'Panier', quantity: 1, goodsSat: 10000, deliverySat: 1000 });
  const url = `/api/orders/${created.id}/hash`;
  const hash = crypto.randomBytes(32).toString('hex');
  const key = crypto.randomUUID();
  const headers = { cookie: buyer.cookie, 'x-csrf': buyer.csrf, 'idempotency-key': key };
  try {
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, cookie: seller.cookie, 'x-csrf': seller.csrf }, payload: { hash } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf': 'wrong' }, payload: { hash } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { hash } })).statusCode).toBe(200);
    const version = store.order(created.id)!.version;
    expect((await app.inject({ method: 'POST', url, headers, payload: { hash } })).statusCode).toBe(200);
    expect(store.order(created.id)!.version).toBe(version);
    expect((await app.inject({ method: 'POST', url, headers, payload: { hash: crypto.randomBytes(32).toString('hex') } })).statusCode).toBe(409);
    expect(store.order(created.id)!.version).toBe(version);
    const badOrder = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: seller.cookie, 'x-csrf': seller.csrf },
      payload: { description: 'Panier', quantity: 1, goodsSat: -1, deliverySat: 1000 } });
    expect(badOrder.statusCode).toBe(409);
  } finally {
    await app.close();
    store.db.close();
  }
});
