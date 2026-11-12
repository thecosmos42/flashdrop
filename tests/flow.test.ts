import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Config } from '../apps/server/src/config.js';
import { Store } from '../apps/server/src/db.js';
import { canDispatch, Flow, hashSecret } from '../apps/server/src/flow.js';
import { encodeHash, type Invoice, type Payment } from '../apps/server/src/lightning/lnd.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dakar-test-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'app.sqlite'), dir);
  const node = { url: 'https://127.0.0.1:1', cert: Buffer.alloc(0), macaroon: '' };
  const config: Config = { port: 0, origin: 'http://127.0.0.1:3000', databasePath: path.join(dir, 'app.sqlite'),
    runtimeDir: dir, nodes: { buyer: node, seller: node, courier: node }, releaseKey: crypto.randomBytes(32) };
  return { store, config };
}

test('dispatch requires both accepted holds and the actual block-height margin', () => {
  const buyer: Invoice = { state: 'ACCEPTED', amountSat: 11000, expiryHeight: 200 };
  const courier: Invoice = { state: 'ACCEPTED', amountSat: 1000, expiryHeight: 170 };
  const payment: Payment = { state: 'IN_FLIGHT', expiryHeight: 176 };
  expect(canDispatch(buyer, courier, payment, 145)).toBe(true);
  expect(canDispatch(buyer, courier, payment, 147)).toBe(false);
  expect(canDispatch({ ...buyer, expiryHeight: 193 }, courier, payment, 145)).toBe(false);
  expect(canDispatch(buyer, { ...courier, state: 'OPEN' }, payment, 145)).toBe(false);
  expect(canDispatch(buyer, courier, { ...payment, expiryHeight: null }, 145)).toBe(false);
});

test('payment tracking path handles hashes whose standard base64 has slashes', () => {
  const hash = Buffer.alloc(32, 255).toString('hex');
  const encoded = encodeHash(hash);
  expect(encoded).not.toContain('%2F');
  expect(encoded).not.toContain('%2B');
  expect(encoded.endsWith('%3D')).toBe(true);
  expect(Buffer.from(decodeURIComponent(encoded), 'base64url').toString('hex')).toBe(hash);
});

test('restart resumes a durable release and settles both legs once', async () => {
  const { store, config } = setup();
  const secret = crypto.randomBytes(32).toString('hex');
  const hash = hashSecret(secret);
  const order = store.createOrder({ description: 'Panier', quantity: 1, goodsSat: 10000, deliverySat: 1000 });
  store.update(order.id, { hash, phase: 'DISPATCHED', buyer_invoice: 'buyer-invoice', courier_invoice: 'courier-invoice',
    buyer_send_attempted_at: Date.now(), courier_send_attempted_at: Date.now(), delivery_deadline: Date.now() + 60_000 });
  let courierSettled = false;
  let sellerSettled = false;
  let courierSettleCalls = 0;
  let sellerSettleCalls = 0;
  function attach(flow: Flow) {
    flow.lnd.courier = {
      info: async () => ({ height: 145, synced: true, pubkey: 'courier' }),
      invoice: async () => ({ state: courierSettled ? 'SETTLED' : 'ACCEPTED', amountSat: 1000, expiryHeight: 170 }),
      settle: async (value: string) => { expect(value).toBe(secret); courierSettled = true; courierSettleCalls++; }
    } as never;
    flow.lnd.seller = {
      info: async () => ({ height: 145, synced: true, pubkey: 'seller' }),
      invoice: async () => ({ state: sellerSettled ? 'SETTLED' : 'ACCEPTED', amountSat: 11000, expiryHeight: 200 }),
      payment: async () => ({ state: courierSettled ? 'SUCCEEDED' : 'IN_FLIGHT', preimage: courierSettled ? secret : undefined, expiryHeight: 176 }),
      settle: async (value: string) => { expect(value).toBe(secret); sellerSettled = true; sellerSettleCalls++; }
    } as never;
    flow.lnd.buyer = { payment: async () => ({ state: sellerSettled ? 'SUCCEEDED' : 'IN_FLIGHT', expiryHeight: 200 }) } as never;
  }
  const beforeCrash = new Flow(store, config);
  attach(beforeCrash);
  await beforeCrash.release(store.order(order.id)!, secret);
  expect(store.order(order.id)?.phase).toBe('RELEASE_PENDING');
  expect(JSON.stringify(store.order(order.id))).not.toContain(secret);

  const restarted = new Flow(store, config);
  attach(restarted);
  await restarted.tick();
  expect(store.order(order.id)?.phase).toBe('COMPLETED');
  expect(store.order(order.id)?.release_cipher).toBeNull();
  await restarted.tick();
  expect([courierSettleCalls, sellerSettleCalls]).toEqual([1, 1]);
  store.db.close();
});

test('cancel waits for both payer failures before showing canceled', async () => {
  const { store, config } = setup();
  const secret = crypto.randomBytes(32).toString('hex');
  const hash = hashSecret(secret);
  const order = store.createOrder({ description: 'Panier', quantity: 1, goodsSat: 10000, deliverySat: 1000 });
  store.update(order.id, { hash, phase: 'DISPATCHED', buyer_invoice: 'buyer-invoice', courier_invoice: 'courier-invoice',
    buyer_send_attempted_at: Date.now(), courier_send_attempted_at: Date.now() });
  let buyerCanceled = false;
  let courierCanceled = false;
  const flow = new Flow(store, config);
  flow.lnd.courier = { invoice: async () => ({ state: courierCanceled ? 'CANCELED' : 'ACCEPTED' }),
    cancel: async () => { courierCanceled = true; } } as never;
  flow.lnd.seller = { invoice: async () => ({ state: buyerCanceled ? 'CANCELED' : 'ACCEPTED' }),
    payment: async () => ({ state: courierCanceled ? 'FAILED' : 'IN_FLIGHT' }),
    cancel: async () => { buyerCanceled = true; } } as never;
  flow.lnd.buyer = { payment: async () => ({ state: buyerCanceled ? 'FAILED' : 'IN_FLIGHT' }) } as never;
  flow.cancel(store.order(order.id)!);
  await flow.tick();
  expect(store.order(order.id)?.phase).toBe('CANCELED');
  expect([courierCanceled, buyerCanceled]).toEqual([true, true]);
  store.db.close();
});

test('one app instance owns the database lease and the release key is pinned', () => {
  const { store, config } = setup();
  new Flow(store, config);
  expect(() => new Flow(store, { ...config, releaseKey: crypto.randomBytes(32) })).toThrow('Release key changed');
  store.acquireLease('first');
  const other = new Store(config.databasePath, config.runtimeDir);
  expect(() => other.acquireLease('second')).toThrow('Another app instance');
  store.renewLease('first');
  store.releaseLease('first');
  other.acquireLease('second');
  other.releaseLease('second');
  other.db.close();
  store.db.close();
});

test('a courier settlement that wins cancellation is surfaced for review', async () => {
  const { store, config } = setup();
  const secret = crypto.randomBytes(32).toString('hex');
  const hash = hashSecret(secret);
  const order = store.createOrder({ description: 'Panier', quantity: 1, goodsSat: 10000, deliverySat: 1000 });
  store.update(order.id, { hash, phase: 'DISPATCHED', buyer_invoice: 'buyer-invoice', courier_invoice: 'courier-invoice',
    buyer_send_attempted_at: Date.now(), courier_send_attempted_at: Date.now() });
  let buyerSettled = false;
  const flow = new Flow(store, config);
  flow.lnd.courier = { invoice: async () => ({ state: 'SETTLED', amountSat: 1000, expiryHeight: 170 }) } as never;
  flow.lnd.seller = { invoice: async () => ({ state: buyerSettled ? 'SETTLED' : 'ACCEPTED', amountSat: 11000, expiryHeight: 200 }),
    payment: async () => ({ state: 'SUCCEEDED', preimage: secret, expiryHeight: 176 }),
    settle: async (value: string) => { expect(value).toBe(secret); buyerSettled = true; } } as never;
  flow.lnd.buyer = { payment: async () => ({ state: buyerSettled ? 'SUCCEEDED' : 'IN_FLIGHT', expiryHeight: 200 }) } as never;
  flow.cancel(store.order(order.id)!);
  await flow.tick();
  expect(buyerSettled).toBe(true);
  expect(store.order(order.id)?.phase).toBe('NEEDS_ATTENTION');
  store.db.close();
});

test('worker never moves a dispatched parcel back to pickup', async () => {
  const { store, config } = setup();
  const hash = hashSecret(crypto.randomBytes(32).toString('hex'));
  const order = store.createOrder({ description: 'Panier', quantity: 1, goodsSat: 10000, deliverySat: 1000 });
  store.update(order.id, { hash, phase: 'DISPATCHED', prepare_requested: 1,
    buyer_invoice: 'buyer-invoice', courier_invoice: 'courier-invoice',
    buyer_send_attempted_at: Date.now(), courier_send_attempted_at: Date.now(),
    delivery_deadline: Date.now() + 60_000 });
  const flow = new Flow(store, config);
  flow.lnd.seller = { invoice: async () => ({ state: 'ACCEPTED', amountSat: 11000, expiryHeight: 200 }),
    payment: async () => ({ state: 'IN_FLIGHT', expiryHeight: 176 }),
    info: async () => ({ height: 145, synced: true }) } as never;
  flow.lnd.courier = { invoice: async () => ({ state: 'ACCEPTED', amountSat: 1000, expiryHeight: 170 }),
    info: async () => ({ height: 145, synced: true }) } as never;
  flow.lnd.buyer = { payment: async () => ({ state: 'IN_FLIGHT', expiryHeight: 200 }) } as never;
  await flow.tick();
  expect(store.order(order.id)?.phase).toBe('DISPATCHED');
  store.db.close();
});
