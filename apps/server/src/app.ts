import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { hashHex, id, orderInput, releaseInput, type Role } from '@dakar/contracts';
import type { Config } from './config.js';
import { Store } from './db.js';
import { DomainError, Flow } from './flow.js';

const loginInput = z.object({ role: z.enum(['buyer','seller','courier']), code: z.string().min(1).max(128) }).strict();
const hashInput = z.object({ hash: hashHex }).strict();
const releaseBody = releaseInput.omit({ orderId: true });
const noteInput = z.object({ reason: z.string().max(120).optional() }).strict();

function responseError(code: string): { error: { code: string; message: string } } {
  const messages: Record<string, string> = {
    UNAUTHORIZED: 'Sign in required', WRONG_ROLE: 'Action not allowed for this role',
    WRONG_CSRF: 'Session expired or invalid form', WRONG_ORIGIN: 'Origin not allowed',
    INVALID_INPUT: 'Check the information entered', STATE_NOT_ELIGIBLE: 'Action unavailable in the current state',
    OFFER_EXPIRED: 'Offer expired', DEADLINE_TOO_CLOSE: 'Too little time remains',
    PAYMENT_STATUS_UNKNOWN: 'Payment status unverified', INVALID_SECRET: 'Invalid release code',
    INVALID_HASH: 'Invalid payment hash',
    NOT_FOUND: 'Order not found',
    ACTIVE_ORDER_EXISTS: 'Complete or cancel the current order before creating another',
    IDEMPOTENCY_CONFLICT: 'This request key was already used with different information',
    NODE_UNAVAILABLE: 'Lightning node unavailable', INTERNAL_ERROR: 'Server error'
  };
  return { error: { code, message: messages[code] ?? 'Action unavailable right now' } };
}

export async function makeApp(config: Config, store: Store, flow: Flow) {
  const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.x-csrf', 'req.body', 'res.headers.set-cookie'] }, bodyLimit: 16_384 });
  await app.register(cookie);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(self)');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') && ['POST','PUT','PATCH','DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowed = [config.origin, 'http://127.0.0.1:5173'];
      if (origin && !allowed.includes(origin)) return reply.code(403).send(responseError('WRONG_ORIGIN'));
    }
  });

  const currentSession = (request: FastifyRequest): { role: Role; csrf: string } => {
    const session = store.session(request.cookies.session);
    if (!session) throw new DomainError('UNAUTHORIZED');
    return session;
  };
  const authorize = (request: FastifyRequest, roles: Role[]): Role => {
    const session = currentSession(request);
    if (!roles.includes(session.role)) throw new DomainError('WRONG_ROLE');
    if (request.method !== 'GET' && !store.verifyCsrf(session.csrf, request.headers['x-csrf'] as string | undefined)) throw new DomainError('WRONG_CSRF');
    return session.role;
  };
  const orderId = (request: FastifyRequest): string => {
    const parsed = id.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success || !store.order(parsed.data)) throw new DomainError('NOT_FOUND');
    return parsed.data;
  };
  const mutate = async (request: FastifyRequest, roles: Role[], action: string,
    fn: (oid: string, role: Role) => Promise<void> | void) => {
    const role = authorize(request, roles);
    const oid = orderId(request);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !id.safeParse(key).success) throw new DomainError('INVALID_INPUT');
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(request.body ?? null)).digest('hex');
    return flow.withOrder(oid, async () => {
      let complete: boolean;
      try { complete = store.beginAction(key, oid, role, action, bodyHash); }
      catch (error) {
        if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') throw new DomainError('IDEMPOTENCY_CONFLICT');
        throw error;
      }
      if (!complete) {
        await fn(oid, role);
        store.completeAction(key);
      }
      return store.view(store.order(oid)!, role);
    });
  };

  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof DomainError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR';
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'WRONG_ROLE' || code === 'WRONG_CSRF' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 409;
    reply.code(status).send(responseError(code));
  });

  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (_request, reply) => {
    try {
      const nodes = await Promise.all(Object.values(flow.lnd).map(n => n.info()));
      if (nodes.some(n => !n.synced)) throw new Error('unsynced');
      return { status: 'ready', network: 'regtest' };
    } catch { return reply.code(503).send({ status: 'waiting', network: 'regtest' }); }
  });

  app.post('/api/sessions', async (request, reply) => {
    const input = loginInput.parse(request.body);
    const session = store.login(input.role, input.code);
    if (!session) return reply.code(401).send(responseError('UNAUTHORIZED'));
    reply.setCookie('session', session.token, { httpOnly: true, sameSite: 'strict', secure: config.origin.startsWith('https:'), path: '/', maxAge: 8 * 3600 });
    return { role: input.role, csrf: session.csrf };
  });
  app.get('/api/me', async request => currentSession(request));
  app.delete('/api/sessions/current', async (request, reply) => {
    authorize(request, ['buyer','seller','courier']);
    store.logout(request.cookies.session); reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/orders', async request => {
    const role = authorize(request, ['buyer','seller','courier']);
    return store.orders().map(o => store.view(o, role));
  });
  app.get('/api/orders/:id', async request => {
    const role = authorize(request, ['buyer','seller','courier']);
    return store.view(store.order(orderId(request))!, role);
  });
  app.post('/api/orders', async request => {
    const role = authorize(request, ['seller']);
    const input = orderInput.parse(request.body);
    if (store.activeOrders().length) throw new DomainError('ACTIVE_ORDER_EXISTS');
    return store.view(store.createOrder(input), role);
  });
  app.post('/api/orders/:id/hash', async request => mutate(request, ['buyer'], 'register-hash', oid => {
    flow.registerHash(store.order(oid)!, hashInput.parse(request.body).hash);
  }));
  app.post('/api/orders/:id/fund', async request => mutate(request, ['buyer'], 'fund', oid => { flow.requestFund(store.order(oid)!); }));
  app.post('/api/orders/:id/prepare-dispatch', async request => mutate(request, ['seller'], 'prepare', oid => { flow.requestPrepare(store.order(oid)!); }));
  app.post('/api/orders/:id/pickup', async request => mutate(request, ['courier'], 'pickup', async oid => { await flow.pickup(store.order(oid)!); }));
  app.post('/api/orders/:id/release', async request => mutate(request, ['courier'], 'release', async oid => {
    const input = releaseBody.parse(request.body);
    const order = store.order(oid)!;
    if (input.hash !== order.hash) throw new DomainError('INVALID_SECRET');
    await flow.release(order, input.secret);
  }));
  app.post('/api/orders/:id/cancel', async request => mutate(request, ['buyer','seller'], 'cancel', oid => { flow.cancel(store.order(oid)!); }));
  app.post('/api/orders/:id/refuse', async request => mutate(request, ['buyer'], 'refuse', oid => {
    noteInput.parse(request.body);
    const order = store.order(oid)!;
    if (order.phase !== 'DISPATCHED') throw new DomainError('STATE_NOT_ELIGIBLE');
    flow.cancel(order);
  }));

  const webDist = path.resolve('apps/web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(staticFiles, { root: webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send(responseError('NOT_FOUND')) : reply.sendFile('index.html'));
  }
  return app;
}
