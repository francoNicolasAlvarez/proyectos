import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, eventsUrl } from '../api/client';
import type { OrderPart, OrderView } from '../api/types';
import { redirectTo } from '../lib/nav';
import { money } from '../lib/money';
import { errorMessage, STATUS_COPY } from '../lib/messages';
import { useAuth } from '../state/auth';

const FINAL = new Set(['delivered', 'rejected', 'cancelled', 'not_picked_up']);
const STEPS = ['Pago', 'Local', 'Aceptado', 'Preparando', 'Listo', 'Entregado'];

function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then((u) => { if (alive) setSrc(u); }).catch(() => { /* el código corto sigue disponible */ });
    return () => { alive = false; };
  }, [value]);
  return src ? <img className="qr" src={src} alt="Código QR para retirar el pedido" width={240} height={240} /> : <div className="qr placeholder" aria-hidden="true" />;
}

function Part({ part, index, total }: { part: OrderPart; index: number; total: number }) {
  const label = total > 1 ? `Parte ${index + 1}: ` : '';
  if (part.status === 'delivered') return <li className="part ok">{label}Retirado ✓{part.pickupPoint ? ` en ${part.pickupPoint}` : ''}</li>;
  if (part.status !== 'ready' || !part.pickup) return <li className="part">{label}{part.pickupPoint ? `Se retira en ${part.pickupPoint}` : 'Punto de retiro por confirmar'}</li>;
  return (
    <li className="part pickup-card glow">
      <p><strong>{label}Retirá tu pedido en {part.pickupPoint ?? 'la barra'}.</strong></p>
      {!part.pickup.used && <Qr value={part.pickup.token} />}
      <p className="muted small">¿No podés mostrar el QR? Dictá este código:</p>
      <p className="code" aria-label={`Código de retiro ${part.pickup.shortCode.split('').join(' ')}`}>{part.pickup.shortCode}</p>
    </li>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user, ready } = useAuth();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const orderRef = useRef<OrderView | null>(null);
  orderRef.current = order;

  const load = useCallback(async () => {
    try { setOrder(await api.order(id)); setError(''); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) { nav(`/login?next=${encodeURIComponent(`/orders/${id}`)}`, { replace: true }); return; }
      if (!orderRef.current) setError(errorMessage(e));   // un corte pasajero no borra lo que ya se ve
    }
  }, [id, nav]);

  useEffect(() => { if (ready) void load(); }, [ready, load, user]);

  // Tiempo real: el canal solo avisa que hubo un cambio; el estado se vuelve a pedir. Un sondeo cubre cortes del canal.
  useEffect(() => {
    if (!ready || !user) return;
    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(eventsUrl, { withCredentials: true });
      es.onmessage = () => { void load(); };
      es.addEventListener('message', () => { void load(); });
    }
    const timer = setInterval(() => { if (!orderRef.current || !FINAL.has(orderRef.current.status)) void load(); }, 8000);
    return () => { es?.close(); clearInterval(timer); };
  }, [ready, user, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  if (error && !order) return <main className="page"><p role="alert" className="notice err">{error}</p><Link className="btn link" to="/">Volver al inicio</Link></main>;
  if (!order) return <main className="page"><p role="status" className="muted center">Cargando tu pedido…</p></main>;

  const copy = STATUS_COPY[order.status] ?? { title: order.status, hint: '', step: 0 };
  const failed = ['rejected', 'cancelled', 'not_picked_up'].includes(order.status);
  const pago = params.get('pago');
  const canCancel = order.status === 'awaiting_payment' || order.status === 'pending_acceptance';

  return (
    <main className="page">
      <p className="muted small">Pedido #{String(order.number).padStart(3, '0')}{order.originName ? ` · ${order.originName}` : ''}</p>

      {pago === 'ok' && order.status === 'awaiting_payment' && <p role="status" className="notice info">Estamos confirmando tu pago…</p>}
      {pago === 'error' && order.status === 'awaiting_payment' && <p role="alert" className="notice err">El pago no se pudo completar. Podés intentar de nuevo.</p>}

      <section className={`status-hero${order.status === 'delivered' ? ' done' : ''}`} aria-live="polite">
        <h1>{copy.title}</h1>
        <p>{copy.hint}</p>
        {order.status === 'delivered' && <div className="confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}</div>}
      </section>

      {!failed && (
        <div className="progress" role="progressbar" aria-label="Avance del pedido" aria-valuemin={0} aria-valuemax={5} aria-valuenow={copy.step}>
          <ol className="steps">
            {STEPS.map((s, i) => <li key={s} className={i < copy.step ? 'done' : i === copy.step ? 'now' : ''}>{s}</li>)}
          </ol>
        </div>
      )}

      {order.parts.length > 0 && (
        <ul className="parts">{order.parts.map((p, i) => <Part key={p.id} part={p} index={i} total={order.parts.length} />)}</ul>
      )}

      <p className="total"><span>Total</span><strong>{money(order.totalCents)}</strong></p>
      {error && <p role="alert" className="notice err">{error}</p>}

      {order.status === 'awaiting_payment' && (
        <button type="button" className="btn primary block" disabled={busy}
          onClick={() => act(async () => { const { checkoutUrl } = await api.checkout(order.id); redirectTo(checkoutUrl); })}>
          Pagar ahora
        </button>
      )}
      {canCancel && (
        <button type="button" className="btn link" disabled={busy}
          onClick={() => { if (window.confirm('¿Cancelar el pedido? Si ya pagaste, se reembolsa.')) void act(() => api.cancel(order.id)); }}>
          Cancelar pedido
        </button>
      )}
      {FINAL.has(order.status) && <Link className="btn link" to="/">Volver al inicio</Link>}
    </main>
  );
}
