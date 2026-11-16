import { useEffect, useState } from 'react';
import { Link, Outlet, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Menu, Product } from '../api/types';
import { ProductSheet } from '../components/ProductSheet';
import { money } from '../lib/money';
import { errorMessage } from '../lib/messages';
import { CartProvider, useCart } from '../state/cart';

export const originKey = (slug: string) => `pasamanos.origin.${slug}`;
export interface Origin { id: string; name: string }

export function readOrigin(slug: string): Origin | null {
  try { return JSON.parse(sessionStorage.getItem(originKey(slug)) ?? 'null') as Origin | null; } catch { return null; }
}

/** Carrito por local para todas las pantallas de /v/:slug. */
export function VenueShell() {
  const { slug = '' } = useParams();
  return <CartProvider slug={slug}><Outlet /></CartProvider>;
}

type Load = { s: 'loading' } | { s: 'error'; message: string } | { s: 'ready'; menu: Menu };

export function MenuPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const cart = useCart();
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [open, setOpen] = useState<Product | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(() => readOrigin(slug));
  const [toast, setToast] = useState('');
  const [bump, setBump] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoad({ s: 'loading' });
    api.menu(slug).then((menu) => { if (alive) { setLoad({ s: 'ready', menu }); setCategory((c) => c ?? menu.categories[0]?.id ?? null); } })
      .catch((e) => { if (alive) setLoad({ s: 'error', message: errorMessage(e) }); });
    return () => { alive = false; };
  }, [slug]);

  // El QR del sector trae ?s=<token>: se resuelve a un origen informativo (no cambia dónde se retira).
  const token = params.get('s');
  useEffect(() => {
    if (!token) return;
    let alive = true;
    api.location(slug, token).then((loc) => {
      if (!alive) return;
      setOrigin(loc);
      try { sessionStorage.setItem(originKey(slug), JSON.stringify(loc)); } catch { /* sin almacenamiento */ }
    }).catch(() => { /* un QR inválido no impide pedir */ });
    return () => { alive = false; };
  }, [slug, token]);

  useEffect(() => { if (!bump) return; const t = setTimeout(() => setBump(false), 450); return () => clearTimeout(t); }, [bump]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2200); return () => clearTimeout(t); }, [toast]);

  if (load.s === 'loading') return <main className="page"><p role="status" className="muted center">Cargando el menú…</p></main>;
  if (load.s === 'error') return <main className="page"><p role="alert" className="notice err">{load.message}</p></main>;

  const { menu } = load;
  const current = menu.categories.find((c) => c.id === category) ?? menu.categories[0];

  return (
    <main className="page">
      <header className="venue-head">
        <h1>Menú</h1>
        {origin && <p className="where">Estás en: <strong>{origin.name}</strong>. Solo para ubicarte: el pedido se retira en la barra.</p>}
      </header>

      {menu.paused && <p role="status" className="notice warn">{menu.pauseMessage ?? 'El local pausó los pedidos por un momento.'}</p>}

      <nav className="chips" aria-label="Categorías">
        {menu.categories.map((c) => (
          <button key={c.id} type="button" className="chip" aria-pressed={c.id === current?.id} onClick={() => setCategory(c.id)}>{c.name}</button>
        ))}
      </nav>

      <ul className="products">
        {current?.products.map((p) => (
          <li key={p.id} className="product">
            <div className="thumb" aria-hidden="true">{p.kind === 'combo' ? '🍽️' : '🍺'}</div>
            <div className="info">
              <h2>{p.name}</h2>
              {p.description && <p className="muted small">{p.description}</p>}
              <p className="price">{money(p.priceCents)}</p>
            </div>
            <button type="button" className="btn small primary" disabled={!p.available || menu.paused}
              aria-label={`Agregar ${p.name}`} onClick={() => setOpen(p)}>{p.available ? 'Agregar' : 'Agotado'}</button>
          </li>
        ))}
        {current && current.products.length === 0 && <li className="muted center">Todavía no hay productos en esta categoría.</li>}
      </ul>

      {cart.count > 0 && (
        <Link to={`/v/${slug}/carrito`} className={`cartbar${bump ? ' bump' : ''}`}>
          <span>Ver carrito · {cart.count} {cart.count === 1 ? 'producto' : 'productos'}</span>
          <strong>{money(cart.subtotalCents)}</strong>
        </Link>
      )}

      {open && (
        <ProductSheet product={open} onClose={() => setOpen(null)}
          onAdd={(selections, quantity) => { cart.dispatch({ type: 'add', product: open, selections, quantity }); setOpen(null); setBump(true); setToast(`${open.name} agregado`); }} />
      )}
      <div id="toast" className={toast ? 'show' : ''} role="status" aria-live="polite">{toast}</div>
    </main>
  );
}
