import type { CreatedOrder, Menu, OrderRequest, OrderView, User } from './types';

/** Error de la API: `code` es el código de negocio (p. ej. EMAIL_TAKEN); status 0 = sin conexión. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: unknown) {
    super(code);
    this.name = 'ApiError';
  }
}

const BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api';

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try { data = await res.json(); } catch { /* cuerpo vacío o no JSON */ }
  if (!res.ok) {
    const code = (data as { code?: string } | null)?.code ?? 'UNKNOWN';
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

export const api = {
  register: (b: { email: string; name: string; password: string; phone?: string | null; adultDeclared: boolean }) =>
    request<{ id: string }>('POST', '/auth/register', b),
  login: (b: { email: string; password: string }) => request<{ id: string }>('POST', '/auth/login', b),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<User>('GET', '/me'),

  menu: (slug: string) => request<Menu>('GET', `/venues/${encodeURIComponent(slug)}/menu`),
  location: (slug: string, token: string) =>
    request<{ id: string; name: string }>('GET', `/venues/${encodeURIComponent(slug)}/locations/by-token/${encodeURIComponent(token)}`),

  createOrder: (slug: string, body: OrderRequest, idempotencyKey: string) =>
    request<CreatedOrder>('POST', `/venues/${encodeURIComponent(slug)}/orders`, body, { 'Idempotency-Key': idempotencyKey }),
  order: (id: string) => request<OrderView>('GET', `/orders/${id}`),
  checkout: (id: string) => request<{ checkoutUrl: string; expiresAt: string }>('POST', `/orders/${id}/checkout`),
  cancel: (id: string) => request<unknown>('POST', `/orders/${id}/cancel`, {}),
};

/** Dirección del canal de eventos en vivo (SSE). */
export const eventsUrl = `${BASE}/events`;
