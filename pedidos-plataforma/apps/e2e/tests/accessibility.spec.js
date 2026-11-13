const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { customerUrl, panelUrl } = require('./helpers');

/** Falla ante violaciones WCAG A/AA de impacto serio o crítico, e informa dónde están. */
async function expectAccessible(page, label) {
  // Los avisos temporales se desvanecen: medir su contraste a mitad de la transición da falsos positivos.
  await page.waitForFunction(() => !document.querySelector('#toast.show'), undefined, { timeout: 5000 });
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // La barra oscura de "Prototipo" es una ayuda de demostración, no parte del producto.
    .exclude('.demo-bar')
    .analyze();
  const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(report, `${label}: ${report.join('\n')}`).toEqual([]);
}

test.describe('app del cliente', () => {
  test.beforeEach(async ({ page }) => { await page.goto(customerUrl); });

  test('menú', async ({ page }) => { await expectAccessible(page, 'menú'); });

  test('hoja de producto', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await expectAccessible(page, 'hoja de producto');
  });

  test('selector de origen', async ({ page }) => {
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await expectAccessible(page, 'origen');
  });

  test('carrito, pago y seguimiento', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await page.getByRole('radio', { name: /Pinta/ }).click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expectAccessible(page, 'carrito');
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await expectAccessible(page, 'pago');
    await page.getByRole('button', { name: /^Pagar/ }).click();
    await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
    await expectAccessible(page, 'seguimiento');
    const next = page.getByRole('button', { name: 'Avanzar estado' });
    for (let i = 0; i < 3; i++) await next.click();
    await expectAccessible(page, 'retiro con QR');
  });

  test('rechazo', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await page.getByRole('radio', { name: /Pinta/ }).click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await page.getByRole('button', { name: /^Pagar/ }).click();
    await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: 'Simular rechazo' }).click();
    await expectAccessible(page, 'rechazo');
  });
});

test.describe('panel del local', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(panelUrl);
    await page.getByRole('button', { name: 'Simular pedido entrante' }).click();
  });

  test('tablero', async ({ page }) => { await expectAccessible(page, 'tablero'); });

  test('diálogo de rechazo', async ({ page }) => {
    await page.getByRole('button', { name: 'Rechazar', exact: true }).click();
    await expectAccessible(page, 'rechazo');
  });

  test('escáner', async ({ page }) => {
    await page.getByRole('button', { name: 'Escanear entrega' }).first().click();
    await expectAccessible(page, 'escáner');
  });

  test('disponibilidad', async ({ page }) => {
    await page.getByRole('button', { name: 'Disponibilidad' }).click();
    await expectAccessible(page, 'disponibilidad');
  });
});

test.describe('límites del pedido', () => {
  test('carrito que supera los límites (aviso de error y botón deshabilitado)', async ({ page }) => {
    await page.goto(customerUrl);
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await page.getByRole('radio', { name: /Pinta/ }).click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    const plus = page.getByRole('group', { name: /Cantidad de Rubia Lager/ }).getByRole('button', { name: 'Agregar uno' });
    for (let i = 0; i < 24; i++) await plus.click();   // 25 productos, $105.000: incumple gasto y cantidad
    await expect(page.locator('.limits [role="alert"]')).toBeVisible();
    await expectAccessible(page, 'carrito sobre el límite');
  });
});
