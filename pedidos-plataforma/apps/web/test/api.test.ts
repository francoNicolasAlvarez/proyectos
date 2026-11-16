import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { money, delta } from '../src/lib/money';
import { errorMessage } from '../src/lib/messages';
import { safeNext } from '../src/state/auth';

const reply = (status: number, body?: unknown) =>
  vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('sin cuerpo'); return body; } });

afterEach(() => vi.unstubAllGlobals());

describe('cliente de la API', () => {
  it('envía cookies, JSON y la clave de idempotencia', async () => {
    const f = reply(201, { orderId: 'o1', orderNumber: 1, totalCents: 100, replayed: false });
    vi.stubGlobal('fetch', f);
    await api.createOrder('el-faro', { paymentMethod: 'card_online', items: [] }, 'clave-1234');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/venues/el-faro/orders');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('clave-1234');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
  it('escapa el slug y no manda cuerpo en los GET', async () => {
    const f = reply(200, {});
    vi.stubGlobal('fetch', f);
    await api.menu('a b/c');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/venues/a%20b%2Fc/menu');
    expect(init.body).toBeUndefined();
  });
  it('un error de negocio trae su código y estado', async () => {
    vi.stubGlobal('fetch', reply(409, { code: 'EMAIL_TAKEN' }));
    await expect(api.login({ email: 'a', password: 'b' })).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
  });
  it('204 devuelve vacío sin intentar leer el cuerpo', async () => {
    vi.stubGlobal('fetch', reply(204));
    await expect(api.logout()).resolves.toBeUndefined();
  });
  it('un error sin cuerpo JSON no rompe: código UNKNOWN', async () => {
    vi.stubGlobal('fetch', reply(502));
    await expect(api.me()).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' });
  });
  it('sin conexión: ApiError con estado 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });
});

describe('mensajes para el cliente', () => {
  it('traduce los códigos conocidos y nunca muestra códigos técnicos', () => {
    expect(errorMessage(new ApiError(401, 'INVALID_CREDENTIALS'))).toMatch(/no son correctos/);
    expect(errorMessage(new ApiError(409, 'PAUSED'))).toMatch(/pausó/);
    expect(errorMessage(new ApiError(0, 'NETWORK'))).toMatch(/conexión/);
  });
  it('un 422 desconocido pide revisar los datos; un 500 no filtra detalles', () => {
    expect(errorMessage(new ApiError(422, 'ALGO_NUEVO'))).toBe('Revisá los datos ingresados.');
    expect(errorMessage(new ApiError(500, 'INTERNAL'))).not.toMatch(/INTERNAL/);
    expect(errorMessage(new Error('x'))).toMatch(/Intentá de nuevo/);
  });
});

describe('formato de importes', () => {
  it('muestra pesos desde centavos enteros', () => {
    expect(money(1_290_000).replace(/\s/g, ' ')).toMatch(/12\.900/);
    expect(money(150)).toMatch(/1,50/);
  });
  it('sobreprecio con signo y vacío cuando es cero', () => {
    expect(delta(0)).toBe('');
    expect(delta(50_000)).toMatch(/^\+ /);
    expect(delta(-20_000)).toMatch(/^− /);
  });
});

describe('redirección tras iniciar sesión', () => {
  it('solo acepta rutas internas', () => {
    expect(safeNext('/v/el-faro/carrito')).toBe('/v/el-faro/carrito');
    for (const bad of ['https://malo.com', '//malo.com', '\\\\malo', 'javascript:alert(1)', '', null, undefined]) expect(safeNext(bad)).toBe('/');
  });
});
