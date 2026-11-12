import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import type { InvoiceState, OrderPhase, OrderView, Role } from '@dakar/contracts';
import * as api from './api';
import { loadSecret, newSecret } from './secret';
import './styles.css';

function formatTime(value: number | null): string { return value ? new Date(value).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : '—'; }
function sat(value: number): string { return `${new Intl.NumberFormat('en-GB').format(value)} sat`; }
const phaseLabel: Record<OrderPhase,string> = {
  OFFERED: 'Offer created', AWAITING_PAYMENT: 'Awaiting payment', PREPARING_DISPATCH: 'Preparing delivery',
  READY_FOR_PICKUP: 'Ready for pickup', DISPATCHED: 'Out for delivery', RELEASE_PENDING: 'Settling payment',
  COMPLETED: 'Paid', CANCEL_PENDING: 'Canceling', CANCELED: 'Canceled', NEEDS_ATTENTION: 'Needs attention'
};
function invoiceLabel(state: InvoiceState): string {
  const labels: Record<InvoiceState,string> = {
    OPEN: 'pending', ACCEPTED: 'held', SETTLED: 'paid', CANCELED: 'canceled', UNKNOWN: 'unverified'
  };
  return labels[state];
}
const orderErrorLabel: Record<string,string> = {
  NODE_UNAVAILABLE: 'Lightning node unavailable. Try again shortly.',
  PAYMENT_STATUS_UNKNOWN: 'Payment status could not be verified.',
  DEADLINE_TOO_CLOSE: 'Too little time remains for a safe handover.',
  INVALID_RELEASE_JOB: 'Payment authorization could not be read. Operator help is needed.'
};
function orderErrorMessage(value: string): string {
  return orderErrorLabel[value] ?? (/^[A-Z_]+$/.test(value) ? 'Ask the seller to check this order.' : value);
}

function App() {
  const [session,setSession] = useState<api.Session|null>(null);
  const [role,setRole] = useState<Role>('seller');
  const [code,setCode] = useState('');
  const [orders,setOrders] = useState<OrderView[]>([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [online,setOnline] = useState(navigator.onLine);
  useEffect(() => { void api.me().then(setSession).catch(()=>{}); },[]);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online',up); window.addEventListener('offline',down);
    return () => { window.removeEventListener('online',up); window.removeEventListener('offline',down); };
  },[]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const refresh = async () => { try { const result = await api.orders(); if (active) setOrders(result); } catch { if (active) setError('Connection lost — payment status unverified'); } };
    void refresh(); const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => { active = false; clearInterval(interval); };
  },[session]);
  async function run(operation: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await operation(); setOrders(await api.orders()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); }
    finally { setBusy(false); }
  }
  if (!session) return <main className="shell login">
    <div className="brand"><span className="bolt">₿</span> FlashDrop</div>
    <div className="eyebrow">BITCOIN REGTEST DEMO</div>
    <h1>Payment held until the parcel is handed over.</h1>
    <p>Sign in with the demo code for your role.</p>
    <form onSubmit={e => { e.preventDefault(); void run(async()=>{ setSession(await api.login(role,code)); }); }}>
      <label>Role<select value={role} onChange={e=>setRole(e.target.value as Role)}><option value="seller">Seller</option><option value="buyer">Buyer</option><option value="courier">Courier</option></select></label>
      <label>Access code<input type="password" value={code} onChange={e=>setCode(e.target.value)} required autoComplete="off" /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="fine">This demo uses test funds. Its host controls all three wallets.</p>
  </main>;

  const names: Record<Role,string> = { seller:'Seller', buyer:'Buyer', courier:'Courier' };
  return <main className="shell">
    <header><div className="brand"><span className="bolt">₿</span> FlashDrop</div><div className="header-right"><span className="pill">{names[session.role]}</span><button className="link" onClick={()=>void run(async()=>{await api.logout();setSession(null);setOrders([]);})}>Sign out</button></div></header>
    <div className="demo">REGTEST NETWORK · TEST SATOSHIS</div>
    {!online && <p className="error" role="alert">Offline — handover and payment authorization are unavailable.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="intro"><div className="eyebrow">PAYMENT ON DELIVERY</div><h1>{session.role==='seller'?'Prepare a delivery.':session.role==='buyer'?'Reserve, inspect, confirm.':'Know when the delivery fee is ready.'}</h1></div>
    {session.role==='seller' && <SellerForm run={run} busy={busy}/>}
    <section className="orders"><div className="section-head"><h2>Orders</h2><span>{orders.length}</span></div>
      {orders.length===0 && <div className="empty">No orders yet.</div>}
      {orders.map(order => <OrderCard key={order.id} order={order} role={session.role} run={run} busy={busy || !online}/>) }
    </section>
    <footer>Demo prototype · A release code does not prove physical delivery.</footer>
  </main>;
}

function SellerForm({run,busy}:{run:(op:()=>Promise<unknown>)=>Promise<void>;busy:boolean}) {
  const [description,setDescription]=useState('Handmade basket');
  const [quantity,setQuantity]=useState('1');
  const [goods,setGoods]=useState('10000');
  const [delivery,setDelivery]=useState('1000');
  return <section className="panel">
    <div className="eyebrow">NEW ORDER</div><h2>Start with the details</h2>
    <div className="grid"><label>Item<input value={description} onChange={e=>setDescription(e.target.value)}/></label><label>Quantity<input type="number" min="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><label>Goods total (sat)<input type="number" min="1" value={goods} onChange={e=>setGoods(e.target.value)}/></label><label>Delivery fee (sat)<input type="number" min="1" value={delivery} onChange={e=>setDelivery(e.target.value)}/></label></div>
    <div className="form-end"><span>Total <strong>{sat((Number(goods)||0)+(Number(delivery)||0))}</strong></span><button disabled={busy} onClick={()=>void run(()=>api.createOrder({description,quantity:Number(quantity),goodsSat:Number(goods),deliverySat:Number(delivery)}))}>Create order</button></div>
  </section>;
}

function OrderCard({order,role,run,busy}:{order:OrderView;role:Role;run:(op:()=>Promise<unknown>)=>Promise<void>;busy:boolean}) {
  const [qr,setQr]=useState('');
  const [releasePayload,setReleasePayload]=useState('');
  const [copied,setCopied]=useState(false);
  const [payload,setPayload]=useState('');
  const [show,setShow]=useState(false);
  const [localError,setLocalError]=useState('');
  const [scanning,setScanning]=useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!scanning || !video.current) return;
    let stopped = false;
    let stop: (() => void) | undefined;
    void import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (stopped || !video.current) return;
      const controls = await new BrowserQRCodeReader().decodeFromVideoDevice(undefined, video.current, result => {
        if (!result) return;
        const value = result.getText();
        if (value.length > 2048) { setLocalError('Code is too long'); return; }
        setPayload(value); setScanning(false);
      });
      stop = () => controls.stop();
      if (stopped) stop();
    }).catch(() => { if (!stopped) { setLocalError('Camera unavailable. Paste the code below.'); setScanning(false); } });
    return () => { stopped = true; stop?.(); };
  }, [scanning]);
  async function showCode(){
    const secret=await loadSecret(order.id);
    if(!secret||!order.hash){setLocalError('The code is missing from this device. Cancel this order before starting another payment.');return;}
    const value=JSON.stringify({version:1,network:'regtest',orderId:order.id,hash:order.hash,secret});
    setQr(await QRCode.toDataURL(value,{width:280,margin:2}));setReleasePayload(value);setCopied(false);setShow(true);setLocalError('');
  }
  const fresh = order.lastCheckedAt!==null && Date.now()-order.lastCheckedAt<8000;
  return <article className="order">
    <div className="order-head"><div><div className="eyebrow">ORDER {order.id.slice(0,8).toUpperCase()}</div><h3>{order.description}</h3></div><span className="status">{phaseLabel[order.phase]}</span></div>
    <div className="amounts"><div><span>Goods</span><strong>{sat(order.goodsSat)}</strong></div><div><span>Delivery</span><strong>{sat(order.deliverySat)}</strong></div><div className="total"><span>Total held</span><strong>{sat(order.totalSat)}</strong></div></div>
    <div className="steps"><p>Buyer payment: <strong>{invoiceLabel(order.buyerInvoiceState)}</strong></p><p>Courier fee: <strong>{invoiceLabel(order.courierInvoiceState)}</strong></p><p>Authorize by: <strong>{formatTime(order.deliveryDeadline)}</strong></p><p>Last checked: <strong>{fresh?formatTime(order.lastCheckedAt):'status unverified'}</strong></p></div>
    {order.error&&<p className="error">{orderErrorMessage(order.error)}</p>}{localError&&<p className="error">{localError}</p>}
    <div className="actions">
    {role==='buyer'&&order.phase==='OFFERED'&&<button disabled={busy} onClick={()=>void run(async()=>{const {hash}=await newSecret(order.id);await api.action(order.id,'hash',{hash});})}>Prepare payment</button>}
    {role==='buyer'&&order.phase==='AWAITING_PAYMENT'&&order.invoice&&order.buyerInvoiceState!=='ACCEPTED'&&<button disabled={busy} onClick={()=>void run(()=>api.action(order.id,'fund'))}>Hold {sat(order.totalSat)}</button>}
    {role==='seller'&&order.phase==='AWAITING_PAYMENT'&&order.buyerInvoiceState==='ACCEPTED'&&<button disabled={busy||!fresh} onClick={()=>void run(()=>api.action(order.id,'prepare-dispatch'))}>Prepare delivery</button>}
    {role==='courier'&&order.phase==='READY_FOR_PICKUP'&&<button disabled={busy||!fresh} onClick={()=>void run(()=>api.action(order.id,'pickup'))}>Parcel picked up</button>}
    {role==='buyer'&&order.phase==='DISPATCHED'&&<><button disabled={busy||!fresh} onClick={()=>void showCode()}>I inspected the parcel · show release code</button><button className="secondary" disabled={busy} onClick={()=>void run(()=>api.action(order.id,'refuse'))}>Refuse parcel</button></>}
    {role==='buyer'&&order.phase==='DISPATCHED'&&show&&qr&&<div className="qr"><p>Show this code only after inspection. It authorizes payment.</p><img src={qr} alt="Payment release code" /><button className="secondary" onClick={()=>void navigator.clipboard.writeText(releasePayload).then(()=>setCopied(true)).catch(()=>setLocalError('Could not copy the code. Scan the QR instead.'))}>{copied?'Code copied':'Copy release code'}</button></div>}
    {role==='courier'&&order.phase==='DISPATCHED'&&<div className="scanner"><button className="secondary" disabled={busy} onClick={()=>setScanning(value=>!value)}>{scanning?'Close camera':'Scan QR code'}</button>{scanning&&<video ref={video} autoPlay muted playsInline aria-label="Camera scanning the buyer's code" />}<label>Code shown by buyer<textarea value={payload} maxLength={2048} onChange={e=>setPayload(e.target.value)} placeholder="Or paste the QR code contents" /></label><button disabled={busy||!fresh||!payload} onClick={()=>void run(async()=>{let p:unknown;try{p=JSON.parse(payload);}catch{throw new Error('Unreadable code');}const v=p as {orderId?:string;hash?:string;secret?:string;version?:number;network?:string};if(v.version!==1||v.network!=='regtest'||v.orderId!==order.id||v.hash!==order.hash||!v.secret)throw new Error('Invalid code');await api.action(order.id,'release',{hash:v.hash,secret:v.secret});setPayload('');})}>Confirm code</button></div>}
    {['buyer','seller'].includes(role)&&!['COMPLETED','CANCELED','RELEASE_PENDING','CANCEL_PENDING'].includes(order.phase)&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>api.action(order.id,'cancel'))}>Cancel payment hold</button>}
    </div>
    <p className="fine">The code authorizes release of funds. It does not prove physical handover.</p>
  </article>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
