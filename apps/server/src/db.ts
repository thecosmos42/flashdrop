import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OrderPhase, OrderView, Role } from '@dakar/contracts';

export type OrderRow = {
  id: string; description: string; quantity: number; goods_sat: number; delivery_sat: number; total_sat: number;
  hash: string | null; buyer_invoice: string | null; courier_invoice: string | null;
  phase: OrderPhase; version: number; offer_expires_at: number; delivery_deadline: number | null;
  buyer_invoice_state: OrderView['buyerInvoiceState']; buyer_payment_state: OrderView['buyerPaymentState'];
  courier_invoice_state: OrderView['courierInvoiceState']; courier_payment_state: OrderView['courierPaymentState'];
  buyer_send_attempted_at: number | null; courier_send_attempted_at: number | null;
  fund_requested: number; prepare_requested: number; cancel_requested: number; release_cipher: string | null;
  last_checked_at: number | null; error: string | null;
};

const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS actors (
  role TEXT PRIMARY KEY CHECK(role IN ('buyer','seller','courier')),
  code_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL REFERENCES actors(role),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  goods_sat INTEGER NOT NULL CHECK(goods_sat > 0),
  delivery_sat INTEGER NOT NULL CHECK(delivery_sat > 0),
  total_sat INTEGER NOT NULL CHECK(total_sat = goods_sat + delivery_sat AND total_sat <= 100000),
  hash TEXT UNIQUE,
  buyer_invoice TEXT,
  courier_invoice TEXT,
  phase TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  offer_expires_at INTEGER NOT NULL,
  delivery_deadline INTEGER,
  buyer_invoice_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  buyer_payment_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  courier_invoice_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  courier_payment_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  buyer_send_attempted_at INTEGER,
  courier_send_attempted_at INTEGER,
  fund_requested INTEGER NOT NULL DEFAULT 0,
  prepare_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  release_cipher TEXT,
  last_checked_at INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instance_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orders_phase_idx ON orders(phase);
`;

function sha(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function passwordHash(code: string, salt: string): string { return crypto.scryptSync(code, salt, 32).toString('hex'); }

export class Store {
  readonly db: Database.Database;
  constructor(filename: string, private readonly runtimeDir: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(schema);
    const actionColumns = this.db.pragma('table_info(actions)') as { name: string }[];
    if (!actionColumns.some(column => column.name === 'body_hash')) this.db.exec("ALTER TABLE actions ADD COLUMN body_hash TEXT NOT NULL DEFAULT ''");
    if (!actionColumns.some(column => column.name === 'completed_at')) this.db.exec('ALTER TABLE actions ADD COLUMN completed_at INTEGER');
    this.seedActors();
  }

  private seedActors(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n;
    if (count) return;
    const codes = Object.fromEntries((['buyer','seller','courier'] as Role[]).map(role => [role, crypto.randomBytes(12).toString('base64url')])) as Record<Role,string>;
    const insert = this.db.prepare('INSERT INTO actors(role,code_hash) VALUES (?,?)');
    this.db.transaction(() => {
      for (const role of ['buyer','seller','courier'] as Role[]) {
        const salt = crypto.randomBytes(16).toString('hex');
        insert.run(role, `${salt}:${passwordHash(codes[role], salt)}`);
      }
    })();
    const file = path.join(this.runtimeDir, 'demo-access.json');
    fs.writeFileSync(file, JSON.stringify(codes, null, 2), { mode: 0o600, flag: 'wx' });
  }

  login(role: Role, code: string): { token: string; csrf: string } | null {
    const row = this.db.prepare('SELECT code_hash FROM actors WHERE role=?').get(role) as { code_hash: string } | undefined;
    if (!row || code.length > 128) return null;
    const [salt, digest] = row.code_hash.split(':');
    if (!salt || !digest) return null;
    const supplied = passwordHash(code, salt);
    if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(digest))) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO sessions(token_hash,role,csrf,expires_at) VALUES (?,?,?,?)')
      .run(sha(token), role, csrf, Date.now() + 8 * 60 * 60_000);
    return { token, csrf };
  }

  session(token: string | undefined): { role: Role; csrf: string } | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT role,csrf,expires_at FROM sessions WHERE token_hash=?').get(sha(token)) as { role: Role; csrf: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { role: row.role, csrf: row.csrf };
  }

  verifyCsrf(expected: string, supplied: string | undefined): boolean {
    if (!supplied || supplied.length > 128) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  }

  createOrder(input: { description: string; quantity: number; goodsSat: number; deliverySat: number }): OrderRow {
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO orders(id,description,quantity,goods_sat,delivery_sat,total_sat,phase,offer_expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, input.description, input.quantity, input.goodsSat, input.deliverySat,
      input.goodsSat + input.deliverySat, 'OFFERED', Date.now() + 10 * 60_000);
    return this.order(id)!;
  }

  order(id: string): OrderRow | null {
    return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as OrderRow | undefined ?? null;
  }

  orders(): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY rowid DESC LIMIT 20').all() as OrderRow[];
  }

  activeOrders(): OrderRow[] {
    return this.db.prepare(`SELECT * FROM orders WHERE phase NOT IN ('COMPLETED','CANCELED') ORDER BY rowid`).all() as OrderRow[];
  }

  update(id: string, fields: Record<string, unknown>): OrderRow {
    const allowed = new Set(['hash','buyer_invoice','courier_invoice','phase','offer_expires_at','delivery_deadline',
      'buyer_invoice_state','buyer_payment_state','courier_invoice_state','courier_payment_state',
      'buyer_send_attempted_at','courier_send_attempted_at','fund_requested','prepare_requested','cancel_requested',
      'release_cipher','last_checked_at','error']);
    const entries = Object.entries(fields);
    if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid update');
    const sql = `UPDATE orders SET ${entries.map(([key]) => `${key}=?`).join(',')},version=version+1 WHERE id=?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => value), id);
    return this.order(id)!;
  }

  beginAction(id: string, orderId: string, role: Role, action: string, bodyHash: string): boolean {
    const row = this.db.prepare('SELECT order_id,role,action,body_hash,completed_at FROM actions WHERE id=?').get(id) as
      { order_id: string; role: Role; action: string; body_hash: string; completed_at: number | null } | undefined;
    if (row) {
      if (row.order_id !== orderId || row.role !== role || row.action !== action || row.body_hash !== bodyHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return row.completed_at !== null;
    }
    this.db.prepare('INSERT INTO actions(id,order_id,role,action,body_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, orderId, role, action, bodyHash, Date.now());
    return false;
  }

  completeAction(id: string): void {
    this.db.prepare('UPDATE actions SET completed_at=? WHERE id=?').run(Date.now(), id);
  }

  assertReleaseKey(key: Buffer): void {
    const fingerprint = sha(key.toString('hex'));
    const stored = this.db.prepare("SELECT value FROM metadata WHERE key='release_key_fingerprint'").get() as { value: string } | undefined;
    if (stored && stored.value !== fingerprint) throw new Error('Release key changed; restore the original .runtime/release.key before starting');
    if (!stored) this.db.prepare("INSERT INTO metadata(key,value) VALUES ('release_key_fingerprint',?)").run(fingerprint);
  }

  acquireLease(owner: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT owner,expires_at FROM instance_lease WHERE id=1').get() as
        { owner: string; expires_at: number } | undefined;
      if (row && row.owner !== owner && row.expires_at > Date.now()) throw new Error('Another app instance owns the database');
      this.db.prepare('INSERT INTO instance_lease(id,owner,expires_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at')
        .run(owner, Date.now() + 10_000);
    })();
  }

  renewLease(owner: string): void {
    const result = this.db.prepare('UPDATE instance_lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?')
      .run(Date.now() + 10_000, owner, Date.now());
    if (result.changes !== 1) throw new Error('App instance lost database lease');
  }

  releaseLease(owner: string): void {
    this.db.prepare('DELETE FROM instance_lease WHERE id=1 AND owner=?').run(owner);
  }

  view(order: OrderRow, role: Role): OrderView {
    return {
      id: order.id, description: order.description, quantity: order.quantity,
      goodsSat: order.goods_sat, deliverySat: order.delivery_sat, totalSat: order.total_sat,
      hash: order.hash, invoice: role === 'buyer' ? order.buyer_invoice : null,
      phase: order.phase, version: order.version,
      offerExpiresAt: order.offer_expires_at, deliveryDeadline: order.delivery_deadline,
      buyerInvoiceState: order.buyer_invoice_state, buyerPaymentState: order.buyer_payment_state,
      courierInvoiceState: order.courier_invoice_state, courierPaymentState: order.courier_payment_state,
      lastCheckedAt: order.last_checked_at, error: order.error
    };
  }
}
