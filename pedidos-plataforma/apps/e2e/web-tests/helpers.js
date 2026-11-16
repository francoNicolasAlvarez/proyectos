const { request, expect } = require('@playwright/test');

const API = 'http://127.0.0.1:3100';
const WEB = 'http://localhost:5174';
const SLUG = 'el-faro';
const STAFF = { email: 'staff@e2e.test', password: 'clave-de-prueba-1' };

let seq = 0;
const unique = () => `c${Date.now()}${++seq}@e2e.test`;

/** Crea una cuenta de cliente y deja la sesión iniciada en el navegador de la prueba (vía API, no por pantalla). */
async function signIn(page) {
  const email = unique();
  const password = 'una-clave-larga-1';
  const r = await page.request.post('/api/auth/register', { data: { email, name: 'Cliente E2E', password, adultDeclared: true } });
  expect(r.ok()).toBeTruthy();
  const l = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(l.ok()).toBeTruthy();
  return { email, password };
}

/** Cliente de la API con la sesión del personal del local (para avanzar los pedidos como lo haría el panel). */
async function staffApi() {
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { Origin: WEB } });
  const r = await ctx.post('/auth/login', { data: { email: STAFF.email, password: STAFF.password } });
  expect(r.ok()).toBeTruthy();
  const post = async (path, data = {}) => {
    const res = await ctx.post(`/venues/${SLUG}/staff/${path}`, { data });
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  return {
    queue: async () => (await ctx.get(`/venues/${SLUG}/staff/orders`)).json(),
    locations: async () => (await ctx.get(`/venues/${SLUG}/staff/locations`)).json(),
    accept: (id) => post(`orders/${id}/accept`, {}),
    prepare: (id) => post(`orders/${id}/prepare`, {}),
    reject: (id) => post(`orders/${id}/reject`, { reasonCode: 'out_of_stock' }),
    ready: async (id) => {
      const o = (await (await ctx.get(`/venues/${SLUG}/staff/orders`)).json()).find((x) => x.id === id);
      for (const p of o.parts) await post(`parts/${p.id}/ready`, {});
    },
    redeem: (shortCode) => post('pickup/redeem', { shortCode }),
    redeemStatus: async (shortCode) => (await ctx.post(`/venues/${SLUG}/staff/pickup/redeem`, { data: { shortCode } })).status(),
    dispose: () => ctx.dispose(),
  };
}

const orderIdFrom = (page) => {
  const m = /\/orders\/([0-9a-f-]{36})/.exec(page.url());
  expect(m, `URL sin pedido: ${page.url()}`).toBeTruthy();
  return m[1];
};

/** Agrega una Rubia Lager (Jarra) desde el menú y abre el carrito. */
async function addBeerAndOpenCart(page) {
  await page.goto(`/v/${SLUG}`);
  await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
  await page.getByRole('radio', { name: /Jarra/ }).click();
  await page.getByRole('button', { name: /^Agregar ·/ }).click();
  await page.getByRole('link', { name: /Ver carrito/ }).click();
}

module.exports = { API, WEB, SLUG, signIn, staffApi, orderIdFrom, addBeerAndOpenCart };
