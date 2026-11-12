import { z } from 'zod';

export const sat = z.coerce.number().int().min(1).max(100_000);
export const hashHex = z.string().regex(/^[0-9a-f]{64}$/);
export const secretHex = hashHex;
export const id = z.string().uuid();
export const orderInput = z.object({
  description: z.string().trim().min(2).max(160),
  quantity: z.coerce.number().int().min(1).max(99),
  goodsSat: sat,
  deliverySat: sat
}).strict().refine(v => v.goodsSat + v.deliverySat <= 100_000, 'Total exceeds demo limit');
export const releaseInput = z.object({ orderId: id, hash: hashHex, secret: secretHex }).strict();

export type Role = 'buyer' | 'seller' | 'courier';
export type OrderPhase = 'OFFERED' | 'AWAITING_PAYMENT' | 'PREPARING_DISPATCH' | 'READY_FOR_PICKUP' | 'DISPATCHED' | 'RELEASE_PENDING' | 'COMPLETED' | 'CANCEL_PENDING' | 'CANCELED' | 'NEEDS_ATTENTION';
export type InvoiceState = 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED' | 'UNKNOWN';
export type PaymentState = 'NOT_STARTED' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
export type OrderView = {
  id: string;
  description: string;
  quantity: number;
  goodsSat: number;
  deliverySat: number;
  totalSat: number;
  hash: string | null;
  invoice: string | null;
  phase: OrderPhase;
  buyerInvoiceState: InvoiceState;
  buyerPaymentState: PaymentState;
  courierInvoiceState: InvoiceState;
  courierPaymentState: PaymentState;
  offerExpiresAt: number;
  deliveryDeadline: number | null;
  version: number;
  lastCheckedAt: number | null;
  error: string | null;
};
