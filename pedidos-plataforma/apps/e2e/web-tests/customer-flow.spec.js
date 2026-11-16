const { test, expect } = require('@playwright/test');
const { expectAccessible } = require('../tests/helpers');
const { SLUG, addBeerAndOpenCart, orderIdFrom, signIn, staffApi } = require('./helpers');

let staff;
test.beforeAll(async () => { staff = await staffApi(); });
test.afterAll(async () => { await staff.dispose(); });

/** Paga en la página simulada y vuelve a la app. */
async function payAs(page, outcome) {
  await page.getByRole('button', { name: /^Pagar/ }).click();
  await page.waitForURL(/\/dev\/pay\//);
  await page.getByRole('button', { name: outcome === 'approve' ? 'Aprobar pago' : 'Rechazar pago' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}\?pago=/);
}

test('recorrido completo: registrarse, pedir, pagar, seguir el pedido y retirarlo con el código', async ({ page }) => {
  // El carrito se arma sin cuenta; al pagar se pide registrarse y se vuelve al carrito.
  await addBeerAndOpenCart(page);
  await expect(page.getByRole('heading', { name: 'Tu pedido' })).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar sesión para pagar' }).click();
  await page.getByRole('link', { name: 'Creá una' }).click();
  await page.getByLabel('Nombre').fill('Ana Prueba');
  await page.getByLabel('Email', { exact: true }).fill(`ana${Date.now()}@e2e.test`);
  await page.getByLabel(/^Contraseña/).fill('una-clave-larga-1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Tu pedido' })).toBeVisible();
  await expect(page.getByText('Rubia Lager')).toBeVisible();

  await payAs(page, 'approve');
  const id = orderIdFrom(page);
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Avance del pedido' })).toHaveAttribute('aria-valuenow', '1');

  // El local avanza el pedido: la pantalla del cliente se actualiza sola (tiempo real).
  await staff.accept(id);
  await expect(page.getByRole('heading', { name: 'Pedido aceptado' })).toBeVisible();
  await staff.prepare(id);
  await expect(page.getByRole('heading', { name: 'En preparación' })).toBeVisible();
  await staff.ready(id);
  await expect(page.getByRole('heading', { name: 'Listo para retirar' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible();
  const code = (await page.locator('.code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

  // El empleado valida el código; el cliente ve la entrega con la celebración.
  await staff.redeem(code);
  await expect(page.getByRole('heading', { name: 'Entregado' })).toBeVisible();
  await expect(page.locator('.confetti i')).toHaveCount(14);
  await expect(page.getByRole('progressbar', { name: 'Avance del pedido' })).toHaveAttribute('aria-valuenow', '5');
});

test('el código de retiro es de un solo uso', async ({ page }) => {
  await signIn(page);
  await addBeerAndOpenCart(page);
  await payAs(page, 'approve');
  const id = orderIdFrom(page);
  await staff.accept(id); await staff.prepare(id); await staff.ready(id);
  await expect(page.locator('.code')).toBeVisible();
  const code = (await page.locator('.code').innerText()).trim();
  await staff.redeem(code);
  expect(await staff.redeemStatus(code)).toBe(409);   // ya fue usado
  await expect(page.getByRole('heading', { name: 'Entregado' })).toBeVisible();
});

test('un pago rechazado no pierde el pedido: se puede reintentar y pagar', async ({ page }) => {
  await signIn(page);
  await addBeerAndOpenCart(page);
  await payAs(page, 'reject');
  await expect(page.getByRole('alert')).toContainText('El pago no se pudo completar');
  await page.getByRole('button', { name: 'Pagar ahora' }).click();
  await page.waitForURL(/\/dev\/pay\//);
  await page.getByRole('button', { name: 'Aprobar pago' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}\?pago=ok/);
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible();
});

test('si el local rechaza el pedido, el cliente ve el motivo del reembolso', async ({ page }) => {
  await signIn(page);
  await addBeerAndOpenCart(page);
  await payAs(page, 'approve');
  const id = orderIdFrom(page);
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible();
  await staff.reject(id);
  await expect(page.getByRole('heading', { name: 'El local no pudo tomar el pedido' })).toBeVisible();
  await expect(page.getByText('Iniciamos el reembolso de tu pago.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

test('el cliente puede cancelar antes de que el local acepte', async ({ page }) => {
  await signIn(page);
  await addBeerAndOpenCart(page);
  await payAs(page, 'approve');
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancelar pedido' }).click();
  await expect(page.getByRole('heading', { name: 'Pedido cancelado' })).toBeVisible();
});

test('el QR de una mesa muestra el origen y viaja con el pedido, pero se retira en la barra', async ({ page }) => {
  const locs = await staff.locations();
  const mesa = locs.find((l) => l.name === 'Mesa 4');
  const token = new URL(mesa.qrUrl).searchParams.get('s');
  await signIn(page);
  await page.goto(`/v/${SLUG}?s=${token}`);
  await expect(page.getByText('Mesa 4')).toBeVisible();
  await expect(page.getByText(/el pedido se retira en la barra/)).toBeVisible();
  await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
  await page.getByRole('radio', { name: /Pinta/ }).click();
  await page.getByRole('button', { name: /^Agregar ·/ }).click();
  await page.getByRole('link', { name: /Ver carrito/ }).click();
  await payAs(page, 'approve');
  await expect(page.getByText(/Mesa 4/)).toBeVisible();
  const id = orderIdFrom(page);
  await staff.accept(id); await staff.prepare(id); await staff.ready(id);
  await expect(page.getByText(/Retirá tu pedido en Barra principal/)).toBeVisible();
});

test('8 combos superan el monto máximo: avisa y no deja pagar; con 7 sí', async ({ page }) => {
  await signIn(page);
  await page.goto(`/v/${SLUG}`);
  await page.getByRole('button', { name: 'Combos' }).click();
  await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
  await page.getByRole('button', { name: /^Agregar ·/ }).click();
  await page.getByRole('link', { name: /Ver carrito/ }).click();
  const plus = page.getByRole('button', { name: 'Agregar uno de Combo 3' });
  for (let i = 0; i < 7; i++) await plus.click();
  await expect(page.getByText(/supera el monto máximo/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pagar/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Quitar uno de Combo 3' }).click();
  await expect(page.getByRole('button', { name: /^Pagar/ })).toBeEnabled();
});

test('el carrito sobrevive a recargar y se puede vaciar', async ({ page }) => {
  await addBeerAndOpenCart(page);
  await page.reload();
  await expect(page.getByText('Rubia Lager')).toBeVisible();
  await page.getByRole('button', { name: 'Eliminar Rubia Lager' }).click();
  await expect(page.getByText(/Sumá algo rico del menú/)).toBeVisible();
});

test('un producto agotado no se puede pedir y un local inexistente se explica', async ({ page }) => {
  await page.goto(`/v/${SLUG}`);
  await expect(page.getByRole('button', { name: 'Agregar IPA Especial' })).toBeDisabled();
  await page.goto('/v/no-existe');
  await expect(page.getByRole('alert')).toContainText('No encontramos ese local');
});

test('ver el pedido de otra persona no muestra datos', async ({ page, browser }) => {
  await signIn(page);
  await addBeerAndOpenCart(page);
  await payAs(page, 'approve');
  const id = orderIdFrom(page);
  const other = await browser.newContext({ baseURL: 'http://localhost:5174' });
  const p2 = await other.newPage();
  await signIn(p2);
  await p2.goto(`/orders/${id}`);
  await expect(p2.getByRole('alert')).toContainText('No encontramos ese pedido');
  await other.close();
});

test.describe('accesibilidad (WCAG A/AA) en claro y en oscuro', () => {
  for (const scheme of ['light', 'dark']) {
    test(`menú, hoja de producto, carrito y seguimiento · ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      await page.goto(`/v/${SLUG}`);
      await expect(page.getByRole('heading', { name: 'Rubia Lager' })).toBeVisible();
      await expectAccessible(page, `menú ${scheme}`);
      await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
      await page.getByRole('button', { name: /^Agregar ·/ }).click();   // dispara los avisos de selección
      await expectAccessible(page, `hoja ${scheme}`);
      await page.getByRole('radio', { name: /Jarra/ }).click();
      await page.getByRole('button', { name: /^Agregar ·/ }).click();
      await page.getByRole('link', { name: /Ver carrito/ }).click();
      await expect(page.getByRole('heading', { name: 'Tu pedido' })).toBeVisible();
      await expectAccessible(page, `carrito ${scheme}`);
      await payAs(page, 'approve');
      const id = orderIdFrom(page);
      await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible();
      await expectAccessible(page, `seguimiento ${scheme}`);
      await staff.accept(id); await staff.prepare(id); await staff.ready(id);
      await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible();
      await expectAccessible(page, `retiro ${scheme}`);
    });
  }
  test('inicio de sesión y registro', async ({ page }) => {
    await page.goto('/login');
    await expectAccessible(page, 'login');
    await page.goto('/registro');
    await expectAccessible(page, 'registro');
  });
});
