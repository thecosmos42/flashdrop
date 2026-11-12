import crypto from 'node:crypto';
import type { Config, NodeName } from './config.js';
import { Store, type OrderRow } from './db.js';
import { LndClient, LndError, type Invoice, type Payment } from './lightning/lnd.js';

export class DomainError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function hashSecret(secret: string): string {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new DomainError('INVALID_SECRET');
  return crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
}

export function canDispatch(buyer: Invoice, courier: Invoice, courierPay: Payment, height: number): boolean {
  if (buyer.state !== 'ACCEPTED' || courier.state !== 'ACCEPTED' || courierPay.state !== 'IN_FLIGHT') return false;
  if (buyer.expiryHeight === null || courier.expiryHeight === null || courierPay.expiryHeight === null) return false;
  return buyer.expiryHeight >= courierPay.expiryHeight + 18 &&
    courier.expiryHeight - height >= 24 && buyer.expiryHeight - height >= 42;
}

function encrypt(secret: string, key: Buffer, orderId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(orderId));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(value: string, key: Buffer, orderId: string): string {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length < 29) throw new DomainError('INVALID_RELEASE_JOB');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAAD(Buffer.from(orderId));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

export class Flow {
  readonly lnd: Record<NodeName, LndClient>;
  private running = false;
  private readonly locks = new Map<string, Promise<void>>();
  constructor(readonly store: Store, readonly config: Config) {
    store.assertReleaseKey(config.releaseKey);
    this.lnd = {
      buyer: new LndClient('buyer', config.nodes.buyer),
      seller: new LndClient('seller', config.nodes.seller),
      courier: new LndClient('courier', config.nodes.courier)
    };
  }

  async withOrder<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const queued = previous.then(() => held);
    this.locks.set(id, queued);
    await previous;
    try { return await task(); }
    finally {
      unlock();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  registerHash(order: OrderRow, hash: string): OrderRow {
    if (order.hash === hash) return order;
    if (order.phase !== 'OFFERED' || order.hash || order.offer_expires_at < Date.now()) throw new DomainError('STATE_NOT_ELIGIBLE');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new DomainError('INVALID_HASH');
    return this.store.update(order.id, { hash, phase: 'AWAITING_PAYMENT' });
  }

  requestFund(order: OrderRow): OrderRow {
    if (order.fund_requested) return order;
    if (order.phase !== 'AWAITING_PAYMENT' || !order.buyer_invoice || !order.hash) throw new DomainError('STATE_NOT_ELIGIBLE');
    if (order.offer_expires_at < Date.now()) throw new DomainError('OFFER_EXPIRED');
    return this.store.update(order.id, { fund_requested: 1 });
  }

  requestPrepare(order: OrderRow): OrderRow {
    if (order.prepare_requested) return order;
    if (order.phase !== 'AWAITING_PAYMENT' || order.buyer_invoice_state !== 'ACCEPTED') throw new DomainError('STATE_NOT_ELIGIBLE');
    return this.store.update(order.id, { prepare_requested: 1, phase: 'PREPARING_DISPATCH' });
  }

  async pickup(order: OrderRow): Promise<OrderRow> {
    if (order.phase === 'DISPATCHED') return order;
    if (order.phase !== 'READY_FOR_PICKUP' || !order.hash) throw new DomainError('STATE_NOT_ELIGIBLE');
    if (!await this.liveReady(order)) throw new DomainError('DEADLINE_TOO_CLOSE');
    return this.store.update(order.id, { phase: 'DISPATCHED' });
  }

  async release(order: OrderRow, secret: string): Promise<OrderRow> {
    if (!order.hash || hashSecret(secret) !== order.hash) throw new DomainError('INVALID_SECRET');
    if (order.phase === 'RELEASE_PENDING' && order.release_cipher) return order;
    if (order.phase !== 'DISPATCHED' || order.cancel_requested) throw new DomainError('STATE_NOT_ELIGIBLE');
    if (!order.delivery_deadline || Date.now() >= order.delivery_deadline) throw new DomainError('DEADLINE_TOO_CLOSE');
    if (!await this.liveReady(order)) throw new DomainError('PAYMENT_STATUS_UNKNOWN');
    return this.store.update(order.id, { release_cipher: encrypt(secret, this.config.releaseKey, order.id), phase: 'RELEASE_PENDING' });
  }

  cancel(order: OrderRow): OrderRow {
    if (order.cancel_requested) return order;
    if (['COMPLETED','CANCELED','RELEASE_PENDING'].includes(order.phase)) throw new DomainError('STATE_NOT_ELIGIBLE');
    return this.store.update(order.id, { cancel_requested: 1, phase: 'CANCEL_PENDING' });
  }

  private async liveReady(order: OrderRow): Promise<boolean> {
    if (!order.hash) return false;
    const [buyer, courier, payment, sellerInfo, courierInfo] = await Promise.all([
      this.lnd.seller.invoice(order.hash), this.lnd.courier.invoice(order.hash),
      this.lnd.seller.payment(order.hash), this.lnd.seller.info(), this.lnd.courier.info()
    ]);
    if (!sellerInfo.synced || !courierInfo.synced || Math.abs(sellerInfo.height - courierInfo.height) > 1) return false;
    return canDispatch(buyer, courier, payment, Math.max(sellerInfo.height, courierInfo.height));
  }

  private async observeInvoice(node: NodeName, hash: string): Promise<Invoice | null> {
    try { return await this.lnd[node].invoice(hash); } catch { return null; }
  }

  private async observePayment(node: NodeName, hash: string): Promise<Payment | null> {
    try { return await this.lnd[node].payment(hash); }
    catch (error) {
      if (error instanceof LndError && error.code === 'NOT_FOUND') return { state: 'NOT_STARTED', expiryHeight: null };
      return null;
    }
  }

  private async reconcile(order: OrderRow): Promise<OrderRow> {
    if (!order.hash) return order;
    const [buyer, buyerPay, courier, courierPay] = await Promise.all([
      order.buyer_invoice ? this.observeInvoice('seller', order.hash) : Promise.resolve(null),
      order.buyer_send_attempted_at ? this.observePayment('buyer', order.hash) : Promise.resolve(null),
      order.courier_invoice ? this.observeInvoice('courier', order.hash) : Promise.resolve(null),
      order.courier_send_attempted_at ? this.observePayment('seller', order.hash) : Promise.resolve(null)
    ]);
    const next: Record<string, unknown> = {};
    if (buyer) next.buyer_invoice_state = buyer.state;
    if (buyerPay) next.buyer_payment_state = buyerPay.state;
    if (courier) next.courier_invoice_state = courier.state;
    if (courierPay) next.courier_payment_state = courierPay.state;
    if (buyer && (!order.buyer_send_attempted_at || buyerPay) && (!order.courier_invoice || (courier && (!order.courier_send_attempted_at || courierPay)))) {
      next.last_checked_at = Date.now();
    }
    if (buyer?.state === 'ACCEPTED' && !order.delivery_deadline) next.delivery_deadline = Date.now() + 15 * 60_000;
    if (buyer?.state === 'SETTLED' && buyerPay?.state === 'SUCCEEDED' && courier?.state === 'SETTLED' && courierPay?.state === 'SUCCEEDED') {
      next.phase = 'COMPLETED'; next.release_cipher = null; next.error = null;
    }
    return Object.keys(next).length ? this.store.update(order.id, next) : order;
  }

  private async process(order: OrderRow): Promise<void> {
    let current = await this.reconcile(order);
    if (current.phase === 'COMPLETED' || current.phase === 'CANCELED' || current.phase === 'NEEDS_ATTENTION') return;
    if (current.phase === 'OFFERED' && current.offer_expires_at < Date.now()) {
      this.store.update(current.id, { phase: 'CANCELED' }); return;
    }
    if (current.delivery_deadline && Date.now() > current.delivery_deadline && !current.release_cipher && !current.cancel_requested) {
      current = this.store.update(current.id, { cancel_requested: 1, phase: 'CANCEL_PENDING' });
    }
    if (current.offer_expires_at < Date.now() && !current.buyer_send_attempted_at && current.phase === 'AWAITING_PAYMENT') {
      current = this.store.update(current.id, { cancel_requested: 1, phase: 'CANCEL_PENDING' });
    }
    if (!current.release_cipher && !current.cancel_requested &&
      (current.buyer_invoice_state === 'CANCELED' || current.buyer_payment_state === 'FAILED' ||
        current.courier_invoice_state === 'CANCELED' || current.courier_payment_state === 'FAILED')) {
      current = this.store.update(current.id, { cancel_requested: 1, phase: 'CANCEL_PENDING' });
    }
    if (current.cancel_requested) { await this.processCancel(current); return; }
    if (current.release_cipher) { await this.processRelease(current); return; }
    if (current.hash && !current.buyer_invoice) {
      const existing = await this.observeInvoice('seller', current.hash);
      const invoice = existing?.paymentRequest ?? await this.lnd.seller.addHold(current.hash, current.total_sat, 600, 144);
      current = this.store.update(current.id, { buyer_invoice: invoice, buyer_invoice_state: existing?.state ?? 'OPEN' });
    }
    if (current.fund_requested && current.buyer_invoice &&
      (!current.buyer_send_attempted_at ||
        (current.buyer_payment_state === 'NOT_STARTED' && current.buyer_invoice_state === 'OPEN' && Date.now() - current.buyer_send_attempted_at > 5000))) {
      const invoice = current.buyer_invoice;
      current = this.store.update(current.id, { buyer_send_attempted_at: Date.now(), buyer_payment_state: 'UNKNOWN' });
      const result = await this.lnd.buyer.send(invoice);
      current = this.store.update(current.id, { buyer_payment_state: result.state });
    }
    if (current.phase === 'PREPARING_DISPATCH' && current.prepare_requested && current.buyer_invoice_state === 'ACCEPTED' && current.hash) {
      if (!current.courier_invoice) {
        const existing = await this.observeInvoice('courier', current.hash);
        const invoice = existing?.paymentRequest ?? await this.lnd.courier.addHold(current.hash, current.delivery_sat, 600, 72);
        current = this.store.update(current.id, { courier_invoice: invoice, courier_invoice_state: existing?.state ?? 'OPEN' });
      }
      if (current.courier_invoice &&
        (!current.courier_send_attempted_at ||
          (current.courier_payment_state === 'NOT_STARTED' && current.courier_invoice_state === 'OPEN' && Date.now() - current.courier_send_attempted_at > 5000))) {
        const invoice = current.courier_invoice;
        current = this.store.update(current.id, { courier_send_attempted_at: Date.now(), courier_payment_state: 'UNKNOWN' });
        const result = await this.lnd.seller.send(invoice);
        current = this.store.update(current.id, { courier_payment_state: result.state });
      }
      if (await this.liveReady(current)) this.store.update(current.id, { phase: 'READY_FOR_PICKUP', error: null });
    }
  }

  private async processRelease(order: OrderRow): Promise<void> {
    if (!order.hash || !order.release_cipher) return;
    const secret = decrypt(order.release_cipher, this.config.releaseKey, order.id);
    const courier = await this.lnd.courier.invoice(order.hash);
    if (courier.state === 'CANCELED') {
      const payment = await this.lnd.seller.payment(order.hash);
      if (payment.state === 'FAILED') {
        const canceled = this.store.update(order.id, { release_cipher: null, cancel_requested: 1, phase: 'CANCEL_PENDING' });
        await this.processCancel(canceled);
      } else if (payment.state === 'SUCCEEDED') {
        this.store.update(order.id, { phase: 'NEEDS_ATTENTION', error: 'Courier payment succeeded, but the invoice state conflicts.' });
      }
      return;
    }
    if (courier.state === 'ACCEPTED') await this.lnd.courier.settle(secret);
    const paidCourier = await this.lnd.seller.payment(order.hash);
    if (paidCourier.state !== 'SUCCEEDED' || !paidCourier.preimage || hashSecret(paidCourier.preimage) !== order.hash) return;
    const buyer = await this.lnd.seller.invoice(order.hash);
    if (buyer.state === 'ACCEPTED') await this.lnd.seller.settle(paidCourier.preimage);
    if (buyer.state === 'CANCELED') {
      this.store.update(order.id, { phase: 'NEEDS_ATTENTION', error: 'Courier paid; buyer hold canceled before the seller could collect.' });
      return;
    }
    await this.reconcile(this.store.order(order.id)!);
  }

  private async processCancel(order: OrderRow): Promise<void> {
    if (!order.hash) { this.store.update(order.id, { phase: 'CANCELED' }); return; }
    if (order.courier_invoice) {
      const courier = await this.lnd.courier.invoice(order.hash);
      if (courier.state === 'SETTLED') {
        const paid = await this.lnd.seller.payment(order.hash);
        if (paid.state === 'SUCCEEDED' && paid.preimage && hashSecret(paid.preimage) === order.hash) {
          const buyer = await this.lnd.seller.invoice(order.hash);
          if (buyer.state === 'ACCEPTED') await this.lnd.seller.settle(paid.preimage);
          this.store.update(order.id, { phase: 'NEEDS_ATTENTION', error: 'Courier paid during cancellation; review the handover.' });
        }
        return;
      }
      if (courier.state !== 'CANCELED') await this.lnd.courier.cancel(order.hash);
      if (order.courier_send_attempted_at) {
        const payment = await this.observePayment('seller', order.hash);
        if (!payment || payment.state !== 'FAILED') return;
      }
    }
    if (order.buyer_invoice) {
      const buyer = await this.lnd.seller.invoice(order.hash);
      if (buyer.state === 'SETTLED') {
        this.store.update(order.id, { phase: 'NEEDS_ATTENTION', error: 'Buyer payment already settled; an ordinary refund is required.' });
        return;
      }
      if (buyer.state !== 'CANCELED') await this.lnd.seller.cancel(order.hash);
      if (order.buyer_send_attempted_at) {
        const payment = await this.observePayment('buyer', order.hash);
        if (!payment || payment.state !== 'FAILED') return;
      }
    }
    this.store.update(order.id, { phase: 'CANCELED', release_cipher: null, error: null });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const order of this.store.activeOrders()) {
        try { await this.withOrder(order.id, async () => this.process(this.store.order(order.id)!)); }
        catch (error) {
          const code = error instanceof DomainError ? error.code : 'NODE_UNAVAILABLE';
          this.store.update(order.id, { error: code });
        }
      }
    } finally { this.running = false; }
  }
}
