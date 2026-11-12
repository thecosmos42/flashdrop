import https from 'node:https';
import { URL } from 'node:url';
import type { NodeConfig, NodeName } from '../config.js';

type Json = Record<string, unknown>;
export type Invoice = {
  state: 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED' | 'UNKNOWN';
  amountSat: number;
  expiryHeight: number | null;
  paymentRequest?: string;
};
export type Payment = {
  state: 'NOT_STARTED' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  preimage?: string;
  feeSat?: number;
  expiryHeight: number | null;
};

export class LndError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function asJson(value: string): Json {
  try { return JSON.parse(value) as Json; } catch { throw new LndError('BAD_RESPONSE', 'Malformed LND response'); }
}

export function encodeHash(hash: string): string {
  return encodeURIComponent(Buffer.from(hash, 'hex').toString('base64url') + '=');
}

export class LndClient {
  constructor(readonly name: NodeName, private readonly config: NodeConfig) {}

  private async request(method: 'GET' | 'POST', endpoint: string, body?: Json, stream = false, closeAfterFirst = false): Promise<Json> {
    const url = new URL(endpoint, this.config.url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        ca: this.config.cert,
        rejectUnauthorized: true,
        headers: {
          'Grpc-Metadata-Macaroon': this.config.macaroon,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
        },
        timeout: 12_000
      }, res => {
        let buffer = '';
        let done = false;
        const settle = (error?: Error, value?: Json) => {
          if (done) return;
          done = true;
          if (error) reject(error); else resolve(value ?? {});
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1_000_000) { settle(new LndError('BAD_RESPONSE', 'Oversized LND response')); req.destroy(); return; }
          if (stream && res.statusCode && res.statusCode < 400) {
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (line) {
                try {
                  const parsed = asJson(line);
                  if (parsed.error) {
                    const error = parsed.error as Json;
                    settle(new LndError(Number(error.code) === 5 ? 'NOT_FOUND' : 'RPC_ERROR', 'Could not look up the LND payment'));
                    req.destroy(); return;
                  }
                  settle(undefined, (parsed.result as Json | undefined) ?? parsed);
                  // Tracking streams provide a snapshot. Keep send streams open
                  // while the payment is held, then reconcile against LND.
                  if (closeAfterFirst) { res.destroy(); return; }
                } catch (error) { settle(error as Error); req.destroy(); return; }
              }
              newline = buffer.indexOf('\n');
            }
          }
        });
        res.on('end', () => {
          if (done) return;
          try {
            const parsed = buffer.trim() ? asJson(buffer.trim()) : {};
            if ((res.statusCode ?? 500) >= 400 || parsed.error) {
              const code = res.statusCode === 404 || (parsed.error && Number((parsed.error as Json).code) === 5) ? 'NOT_FOUND' : 'RPC_ERROR';
              settle(new LndError(code, `LND ${this.name} returned an error`));
            }
            else settle(undefined, (parsed.result as Json | undefined) ?? parsed);
          } catch (error) { settle(error as Error); }
        });
        res.on('error', () => settle(new LndError('NETWORK', 'LND connection interrupted')));
      });
      req.on('timeout', () => req.destroy(new LndError('TIMEOUT', 'LND request timed out')));
      req.on('error', () => reject(new LndError('NETWORK', 'Could not connect to LND')));
      if (data) req.write(data);
      req.end();
    });
  }

  async info(): Promise<{ height: number; synced: boolean; pubkey: string }> {
    const v = await this.request('GET', '/v1/getinfo');
    return { height: Number(v.block_height), synced: v.synced_to_chain === true, pubkey: String(v.identity_pubkey ?? '') };
  }

  async addHold(hash: string, amountSat: number, expirySeconds: number, cltv: number): Promise<string> {
    const v = await this.request('POST', '/v2/invoices/hodl', {
      hash: Buffer.from(hash, 'hex').toString('base64'), value: String(amountSat),
      expiry: String(expirySeconds), cltv_expiry: String(cltv), private: true
    });
    if (typeof v.payment_request !== 'string') throw new LndError('BAD_RESPONSE', 'Missing invoice in LND response');
    return v.payment_request;
  }

  async invoice(hash: string): Promise<Invoice> {
    const v = await this.request('GET', `/v1/invoice/${hash}`);
    const htlcs = Array.isArray(v.htlcs) ? v.htlcs as Json[] : [];
    const heights = htlcs.map(h => Number(h.expiry_height)).filter(Number.isFinite);
    const state = String(v.state ?? 'UNKNOWN');
    return {
      state: ['OPEN','ACCEPTED','SETTLED','CANCELED'].includes(state) ? state as Invoice['state'] : 'UNKNOWN',
      amountSat: Number(v.value ?? 0),
      expiryHeight: heights.length ? Math.min(...heights) : null,
      paymentRequest: typeof v.payment_request === 'string' ? v.payment_request : undefined
    };
  }

  async settle(secret: string): Promise<void> {
    await this.request('POST', '/v2/invoices/settle', { preimage: Buffer.from(secret, 'hex').toString('base64') });
  }

  async cancel(hash: string): Promise<void> {
    await this.request('POST', '/v2/invoices/cancel', { payment_hash: Buffer.from(hash, 'hex').toString('base64') });
  }

  async send(paymentRequest: string): Promise<Payment> {
    const v = await this.request('POST', '/v2/router/send', {
      payment_request: paymentRequest, timeout_seconds: 30, fee_limit_sat: '20', max_parts: 1, cancelable: false
    }, true);
    return this.paymentFrom(v);
  }

  async payment(hash: string): Promise<Payment> {
    const v = await this.request('GET', `/v2/router/track/${encodeHash(hash)}?no_inflight_updates=false`, undefined, true, true);
    return this.paymentFrom(v);
  }

  private paymentFrom(v: Json): Payment {
    const status = String(v.status ?? 'UNKNOWN');
    const attempts = Array.isArray(v.htlcs) ? v.htlcs as Json[] : [];
    const heights = attempts.map(a => Number(a.route && typeof a.route === 'object' ? (a.route as Json).total_time_lock : NaN)).filter(Number.isFinite);
    return {
      state: ['IN_FLIGHT','SUCCEEDED','FAILED'].includes(status) ? status as Payment['state'] : 'UNKNOWN',
      preimage: typeof v.payment_preimage === 'string' && /^[0-9a-f]{64}$/i.test(v.payment_preimage) ? v.payment_preimage.toLowerCase() : undefined,
      feeSat: Number.isFinite(Number(v.fee_sat)) ? Number(v.fee_sat) : undefined,
      expiryHeight: heights.length ? Math.max(...heights) : null
    };
  }
}
