import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { OrderRequest } from '../api/types';
import { api } from '../api/client';
import { cartViolations, itemUsage, lineTotal, toOrderRequest } from '../lib/cart';
import { redirectTo } from '../lib/nav';
import { money } from '../lib/money';
import { errorMessage } from '../lib/messages';
import { useAuth } from '../state/auth';
import { useCart } from '../state/cart';
import type { Menu } from '../api/types';
import { readOrigin } from './MenuPage';

const METHODS: { id: OrderRequest['paymentMethod']; label: string }[] = [
  { id: 'card_online', label: 'Tarjeta de crédito o débito' },
  { id: 'payment_app', label: 'Billetera o app de pagos' },
];

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CartPage() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const cart = useCart();
  const { user, ready } = useAuth();
  const [limits, setLimits] = useState<Menu['limits'] | null>(null);
  const [method, setMethod] = useState<OrderRequest['paymentMethod']>('card_online');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Los límites vienen del local (pueden cambiar): se consultan al abrir el carrito.
  useEffect(() => { api.menu(slug).then((m) => setLimits(m.limits)).catch(() => setLimits(null)); }, [slug]);

  const violations = useMemo(() => (limits ? cartViolations(cart.lines, limits) : []), [cart.lines, limits]);
  const usage = limits ? itemUsage(cart.lines, limits) : null;

  if (cart.lines.length === 0) {
    return (
      <main className="page">
        <div className="empty">
          <svg viewBox="0 0 64 64" width="96" height="96" role="img" aria-label="Carrito vacío"><circle cx="24" cy="54" r="4" fill="currentColor" /><circle cx="46" cy="54" r="4" fill="currentColor" /><path d="M6 8h8l6 30h28l6-22H18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <h1>Tu carrito está vacío</h1>
          <p className="muted">Sumá algo rico del menú.</p>
          <Link className="btn primary" to={`/v/${slug}`}>Ver el menú</Link>
        </div>
      </main>
    );
  }

  const pay = async () => {
    setError('');
    if (!user) { nav(`/login?next=${encodeURIComponent(`/v/${slug}/carrito`)}`); return; }
    setBusy(true);
    try {
      // La misma clave en los reintentos evita pedidos duplicados si se corta la conexión.
      let key = cart.attemptKey;
      if (!key) { key = newKey(); cart.dispatch({ type: 'attempt', key }); }
      const origin = readOrigin(slug);
      const order = await api.createOrder(slug, toOrderRequest(cart.lines, origin?.id ?? null, method), key);
      const { checkoutUrl } = await api.checkout(order.orderId);
      cart.dispatch({ type: 'clear' });
      redirectTo(checkoutUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>Tu pedido</h1>
      <ul className="lines">
        {cart.lines.map((l) => (
          <li key={l.id} className="line">
            <div className="info">
              <h2>{l.name}</h2>
              {l.summary && <p className="muted small">{l.summary}</p>}
              <p className="price">{money(lineTotal(l))}</p>
            </div>
            <div className="qty" role="group" aria-label={`Cantidad de ${l.name}`}>
              <button type="button" aria-label={`Quitar uno de ${l.name}`} onClick={() => cart.dispatch({ type: 'setQuantity', id: l.id, quantity: l.quantity - 1 })}>−</button>
              <output>{l.quantity}</output>
              <button type="button" aria-label={`Agregar uno de ${l.name}`} onClick={() => cart.dispatch({ type: 'setQuantity', id: l.id, quantity: l.quantity + 1 })}>+</button>
            </div>
            <button type="button" className="btn link" aria-label={`Eliminar ${l.name}`} onClick={() => cart.dispatch({ type: 'remove', id: l.id })}>Eliminar</button>
          </li>
        ))}
      </ul>

      {limits && usage && (
        <section className="limits" aria-label="Límites del pedido">
          <p className="small muted">Máximo por pedido: {money(limits.maxTotalCents)} y {limits.maxIndividualItems} productos ({limits.maxCombos} combos).</p>
          <progress max={limits.maxIndividualItems} value={Math.min(usage.used, limits.maxIndividualItems)} aria-label="Uso del máximo de productos" />
          {violations.map((v) => (
            <p key={v.code} role="alert" className="notice err">
              {v.code === 'ORDER_TOTAL_LIMIT_EXCEEDED'
                ? `El pedido supera el monto máximo de ${money(v.limit)}.`
                : `El pedido supera el máximo de ${v.limit} productos (los combos cuentan como varios).`}
            </p>
          ))}
        </section>
      )}

      <fieldset className="group">
        <legend>Medio de pago</legend>
        {METHODS.map((m) => (
          <label key={m.id} className={`opt${method === m.id ? ' on' : ''}`}>
            <input type="radio" name="method" checked={method === m.id} onChange={() => setMethod(m.id)} />
            <span>{m.label}</span>
          </label>
        ))}
      </fieldset>

      <p className="total"><span>Total</span><strong>{money(cart.subtotalCents)}</strong></p>
      <p className="muted small">Pagás desde el celular y retirás en la barra. No hace falta esperar en fila.</p>
      {error && <p role="alert" className="notice err">{error}</p>}
      <button type="button" className="btn primary block" disabled={busy || violations.length > 0 || !ready} onClick={pay}>
        {busy ? 'Procesando…' : user ? `Pagar ${money(cart.subtotalCents)}` : 'Iniciar sesión para pagar'}
      </button>
      <Link className="btn link" to={`/v/${slug}`}>Seguir pidiendo</Link>
    </main>
  );
}
