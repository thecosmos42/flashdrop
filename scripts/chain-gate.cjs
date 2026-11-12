const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const nodes = Object.fromEntries(['buyer', 'seller', 'courier'].map((name, index) => [name, {
  port: 8081 + index,
  cert: fs.readFileSync(path.join(root, `.runtime/${name}/tls.cert`)),
  macaroon: fs.readFileSync(path.join(root, `.runtime/${name}/runtime.macaroon`)).toString('hex')
}]));
const secret = crypto.randomBytes(32);
const hash = crypto.createHash('sha256').update(secret).digest();
const hex = hash.toString('hex');
const b64 = hash.toString('base64');
const pathHash = encodeURIComponent(hash.toString('base64url') + '=');
let buyerInvoice = false;
let courierInvoice = false;
let courierPaid = false;
let buyerPaid = false;

function rpc(name, method, endpoint, body, stream = false) {
  const node = nodes[name];
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(`https://127.0.0.1:${node.port}${endpoint}`, {
      method, ca: node.cert, timeout: 15_000,
      headers: { 'Grpc-Metadata-Macaroon': node.macaroon,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, response => {
      let buffer = '';
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; error ? reject(error) : resolve(value); };
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        if (stream && response.statusCode < 400) {
          const pos = buffer.indexOf('\n');
          if (pos >= 0) {
            try {
              const value = JSON.parse(buffer.slice(0, pos));
              if (value.error) throw new Error(`LND ${name} stream error: ${value.error.code}`);
              finish(null, value.result ?? value);
              if (method === 'GET') response.destroy();
            } catch (error) { finish(error); response.destroy(); }
          }
        }
      });
      response.on('end', () => {
        if (done) return;
        try {
          const value = JSON.parse(buffer);
          if (response.statusCode >= 400 || value.error) throw new Error(`LND ${name} error, HTTP ${response.statusCode} ${value.error?.code ?? ''}`);
          finish(null, value.result ?? value);
        } catch (error) { finish(error); }
      });
      response.on('error', error => finish(error));
    });
    req.on('timeout', () => req.destroy(new Error(`LND ${name} timeout`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const invoice = name => rpc(name, 'GET', `/v1/invoice/${hex}`);
const payment = name => rpc(name, 'GET', `/v2/router/track/${pathHash}?no_inflight_updates=false`, null, true);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, check) {
  for (let i = 0; i < 30; i++) {
    try { const value = await check(); if (value) return value; } catch { /* wait for node state */ }
    await pause(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function cancel(name) {
  try { await rpc(name, 'POST', '/v2/invoices/cancel', { payment_hash: b64 }); } catch { /* Check the actual node state afterward. */ }
}

(async () => {
  try {
    const sellerHold = await rpc('seller', 'POST', '/v2/invoices/hodl', {
      hash: b64, value: '11000', expiry: '600', cltv_expiry: '144', private: true
    });
    buyerInvoice = true;
    console.log('Seller hold invoice created');
    const buyerSend = await rpc('buyer', 'POST', '/v2/router/send', {
      payment_request: sellerHold.payment_request, timeout_seconds: 30,
      fee_limit_sat: '20', max_parts: 1, cancelable: false
    }, true);
    console.log(`Buyer payment: ${buyerSend.status}`);
    await until('buyer payment hold', async () => (await invoice('seller')).state === 'ACCEPTED');

    const courierHold = await rpc('courier', 'POST', '/v2/invoices/hodl', {
      hash: b64, value: '1000', expiry: '600', cltv_expiry: '72', private: true
    });
    courierInvoice = true;
    console.log('Courier hold invoice created with the same hash');
    const courierSend = await rpc('seller', 'POST', '/v2/router/send', {
      payment_request: courierHold.payment_request, timeout_seconds: 30,
      fee_limit_sat: '20', max_parts: 1, cancelable: false
    }, true);
    console.log(`Seller-to-courier payment: ${courierSend.status}`);
    const courierHeld = await until('courier payment hold', async () => {
      const current = await invoice('courier');
      return current.state === 'ACCEPTED' ? current : null;
    });
    const buyerHeld = await invoice('seller');
    const outgoing = await payment('seller');
    const heights = outgoing.htlcs?.map(a => a.route?.total_time_lock).filter(Number.isFinite) ?? [];
    console.log(`Both holds: seller ${buyerHeld.state}, expiry block ${buyerHeld.htlcs?.[0]?.expiry_height}; courier ${courierHeld.state}, expiry block ${courierHeld.htlcs?.[0]?.expiry_height}; seller outgoing ${outgoing.status}, expiry block ${Math.max(...heights)}`);
    if (outgoing.status !== 'IN_FLIGHT') throw new Error('Courier payment is not held');
    await rpc('courier', 'POST', '/v2/invoices/settle', { preimage: secret.toString('base64') });
    courierPaid = true;
    console.log('Courier invoice settled');
    const settledOutgoing = await until('seller outgoing payment to succeed', async () => {
      const current = await payment('seller');
      return current.status === 'SUCCEEDED' ? current : null;
    });
    if (settledOutgoing.payment_preimage !== secret.toString('hex')) throw new Error('The outgoing payment secret does not match');
    await rpc('seller', 'POST', '/v2/invoices/settle', { preimage: secret.toString('base64') });
    buyerPaid = true;
    const buyerSucceeded = await until('buyer payment to succeed', async () => (await payment('buyer')).status === 'SUCCEEDED');
    console.log(`PASS: courier and seller invoices settled; buyer payment ${buyerSucceeded ? 'confirmed' : 'unverified'}`);
  } catch (error) {
    console.log(`FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (!courierPaid) {
      if (courierInvoice) await cancel('courier');
      if (buyerInvoice) await cancel('seller');
    } else if (!buyerPaid) {
      try {
        const outgoing = await payment('seller');
        if (outgoing.status === 'SUCCEEDED' && outgoing.payment_preimage === secret.toString('hex')) {
          await rpc('seller', 'POST', '/v2/invoices/settle', { preimage: secret.toString('base64') });
          console.log('Recovery: seller invoice settled after courier payment');
        }
      } catch { console.log('Recovery requires operator review'); }
    }
  }
})().catch(error => { console.log(`FAIL: ${error.message}`); process.exitCode = 1; });
