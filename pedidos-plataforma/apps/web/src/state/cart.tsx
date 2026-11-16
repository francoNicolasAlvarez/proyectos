import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { cartReducer, EMPTY_CART, itemCount, subtotal, type CartAction, type CartState } from '../lib/cart';

interface CartValue extends CartState {
  slug: string;
  dispatch: Dispatch<CartAction>;
  count: number;
  subtotalCents: number;
}

const CartContext = createContext<CartValue | null>(null);
const key = (slug: string) => `pasamanos.cart.${slug}`;

function load(slug: string): CartState {
  try {
    const raw = localStorage.getItem(key(slug));
    if (!raw) return EMPTY_CART;
    const parsed = JSON.parse(raw) as CartState;
    return Array.isArray(parsed.lines) ? { lines: parsed.lines, attemptKey: parsed.attemptKey ?? null } : EMPTY_CART;
  } catch { return EMPTY_CART; }
}

/** Un carrito por local, guardado en el navegador para sobrevivir a una recarga. */
export function CartProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, slug, load);

  useEffect(() => {
    try { localStorage.setItem(key(slug), JSON.stringify(state)); } catch { /* sin almacenamiento: el carrito vive solo en memoria */ }
  }, [slug, state]);

  const value = useMemo<CartValue>(() => ({ ...state, slug, dispatch, count: itemCount(state.lines), subtotalCents: subtotal(state.lines) }), [state, slug]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const v = useContext(CartContext);
  if (!v) throw new Error('useCart debe usarse dentro de <CartProvider>');
  return v;
}
