const { test, expect } = require('@playwright/test');
const { panelUrl, expectAccessible } = require('./helpers');

const newOrder = (page) => page.getByRole('button', { name: 'Simular pedido entrante' }).click();
const ageOrder = async (page, seconds) => {
  await page.evaluate((s) => { Store.update((d) => { d.orders.forEach((o) => { o.createdAt = Date.now() - s * 1000; }); }); }, seconds);
  await page.reload();   // el panel relee el almacenamiento al cargar
};

test.describe('envejecimiento de pedidos nuevos', () => {
  test('normal al principio, ámbar a los 2 minutos y rojo a los 4 (la aceptación vence a los 5)', async ({ page }) => {
    await page.goto(panelUrl);
    await newOrder(page);
    const card = page.locator('.ocard.new');
    await expect(card).not.toHaveClass(/age-warn|age-late/);
    await ageOrder(page, 130);
    await expect(card).toHaveClass(/age-warn/, { timeout: 3000 });
    await ageOrder(page, 250);
    await expect(card).toHaveClass(/age-late/, { timeout: 3000 });
    await expect(card).not.toHaveClass(/age-warn/);
  });

  test('un pedido ya aceptado deja de envejecer', async ({ page }) => {
    await page.goto(panelUrl);
    await newOrder(page);
    await ageOrder(page, 250);
    await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
    await page.getByRole('button', { name: 'Aceptar pedido' }).click();
    await expect(page.locator('.ocard.age-late')).toHaveCount(0);
    await expect(page.locator('.ocard.age-warn')).toHaveCount(0);
  });
});

test.describe('pedidos nuevos: resalte y sonido', () => {
  test('el pedido que llega se resalta; los que ya estaban al abrir el panel no', async ({ page }) => {
    await page.goto(panelUrl);
    await newOrder(page);
    await expect(page.locator('.ocard.fresh')).toHaveCount(1);
    await page.reload();                                                      // ya estaba: no es "nuevo"
    await expect(page.locator('.ocard')).toHaveCount(1);
    await expect(page.locator('.ocard.fresh')).toHaveCount(0);
  });

  test('el sonido empieza apagado, se activa y recuerda la elección; suena solo con pedidos nuevos y solo si está activado', async ({ page }) => {
    await page.goto(panelUrl);
    const btn = page.getByRole('button', { name: /Sonido/ });
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toContainText('desactivado');
    await newOrder(page);
    expect(await page.evaluate(() => window.__beepCount)).toBe(0);            // apagado: silencio
    await btn.click();                                                         // activar da una confirmación sonora
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toContainText('activado');
    const afterToggle = await page.evaluate(() => window.__beepCount);
    await newOrder(page);
    expect(await page.evaluate(() => window.__beepCount)).toBe(afterToggle + 1);
    await page.reload();                                                       // la preferencia se conserva
    await expect(page.getByRole('button', { name: /Sonido/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /Sonido/ }).click();                // volver a apagar
    await expect(page.getByRole('button', { name: /Sonido/ })).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(page.getByRole('button', { name: /Sonido/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('los estados vacíos muestran un mensaje con icono', async ({ page }) => {
    await page.goto(panelUrl);
    await expect(page.getByRole('region', { name: 'Nuevos' }).locator('.empty')).toContainText('Sin pedidos');
  });
});

test.describe('modo oscuro del panel', () => {
  test.use({ colorScheme: 'dark' });
  test('el tablero, los diálogos y el escáner cumplen accesibilidad', async ({ page }) => {
    await page.goto(panelUrl);
    await expectAccessible(page, 'tablero vacío oscuro');
    await newOrder(page);
    await ageOrder(page, 250);                                                 // tarjeta roja: también debe tener buen contraste
    await expect(page.locator('.ocard.age-late')).toHaveCount(1, { timeout: 3000 });
    await expectAccessible(page, 'tablero con pedido atrasado oscuro');
    await page.getByRole('button', { name: 'Rechazar', exact: true }).click();
    await expectAccessible(page, 'diálogo de rechazo oscuro');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Disponibilidad' }).click();
    await expectAccessible(page, 'disponibilidad oscuro');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Escanear entrega' }).first().click();
    await expectAccessible(page, 'escáner oscuro');
  });
});

test.describe('movimiento reducido del panel', () => {
  test('un pedido nuevo no genera animaciones', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(panelUrl);
    await newOrder(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});
