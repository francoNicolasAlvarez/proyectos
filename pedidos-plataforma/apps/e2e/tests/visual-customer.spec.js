const { test, expect } = require('@playwright/test');
const { customerUrl, expectAccessible } = require('./helpers');

async function addBeer(page) {
  await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
  await page.getByRole('radio', { name: /Pinta/ }).click();
  await page.getByRole('button', { name: /^Agregar ·/ }).click();
}
async function payAndAdvance(page, clicks) {
  await page.getByRole('button', { name: /Ver carrito/ }).click();
  await page.getByRole('button', { name: 'Continuar al pago' }).click();
  await page.getByRole('button', { name: /^Pagar/ }).click();
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
  const next = page.getByRole('button', { name: 'Avanzar estado' });
  for (let i = 0; i < clicks; i++) await next.click();
}

test.describe('modo oscuro: accesibilidad en cada pantalla', () => {
  test.use({ colorScheme: 'dark' });
  test.beforeEach(async ({ page }) => { await page.goto(customerUrl); });

  test('menú y hoja de producto', async ({ page }) => {
    await expectAccessible(page, 'menú oscuro');
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await expectAccessible(page, 'hoja de producto oscura');
  });

  test('carrito con productos y con aviso de límites', async ({ page }) => {
    await page.getByRole('button', { name: 'Combos' }).click();
    await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
    await page.getByRole('radio', { name: 'Rubia' }).first().click();
    await page.getByRole('radio', { name: 'Rubia' }).last().click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expectAccessible(page, 'carrito oscuro');
    const plus = page.getByRole('group', { name: /Cantidad de Combo 3/ }).getByRole('button', { name: 'Agregar uno' });
    for (let i = 0; i < 7; i++) await plus.click();                          // 8 combos: supera $100.000
    await expect(page.locator('.limits [role="alert"]')).toBeVisible();
    await expectAccessible(page, 'carrito oscuro con aviso de límites');
  });

  test('carrito vacío', async ({ page }) => {
    await addBeer(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await page.getByRole('button', { name: 'Eliminar Rubia Lager' }).click();
    await expect(page.getByRole('img', { name: 'Carrito vacío' })).toBeVisible();
    await expectAccessible(page, 'carrito vacío oscuro');
  });

  test('seguimiento, retiro con QR y entrega', async ({ page }) => {
    await addBeer(page);
    await payAndAdvance(page, 3);
    await expect(page.locator('.pickup-card')).toBeVisible();
    await expectAccessible(page, 'retiro oscuro');
    await page.getByRole('button', { name: 'Avanzar estado' }).click();
    await expect(page.getByRole('heading', { name: 'Entregado' })).toBeVisible();
    await expectAccessible(page, 'entrega oscura');
  });

  test('rechazo con reembolso', async ({ page }) => {
    await addBeer(page);
    await payAndAdvance(page, 0);
    await page.getByRole('button', { name: 'Simular rechazo' }).click();
    await expect(page.getByText(/Iniciamos el reembolso/)).toBeVisible();
    await expectAccessible(page, 'rechazo oscuro');
  });
});

test.describe('movimiento reducido', () => {
  test('no hay animaciones activas en el seguimiento ni en la entrega', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(customerUrl);
    await addBeer(page);
    await payAndAdvance(page, 3);
    await page.waitForTimeout(300);
    const active = () => page.evaluate(() => document.getAnimations().map((a) => `${a.constructor.name}:${a.animationName || a.transitionProperty}@${a.effect.target && (a.effect.target.id || a.effect.target.className)}`));
    expect(await active()).toEqual([]);
    await page.getByRole('button', { name: 'Avanzar estado' }).click();
    await expect(page.getByRole('heading', { name: 'Entregado' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await active()).toEqual([]);
    await expect(page.locator('.confetti')).toBeHidden();
  });
});

test.describe('animaciones con propósito (solo cuando corresponde)', () => {
  test.beforeEach(async ({ page }) => { await page.goto(customerUrl); });

  test('la hoja de producto anima al abrirse y NO se vuelve a animar al elegir opciones', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await expect(page.locator('#sheet .sheet.enter')).toHaveCount(1);
    await page.getByRole('radio', { name: /Jarra/ }).click();              // redibuja la hoja
    await expect(page.locator('#sheet .sheet')).toHaveCount(1);
    await expect(page.locator('#sheet .sheet.enter')).toHaveCount(0);
  });

  test('la barra de carrito rebota al agregar y no en redibujados posteriores', async ({ page }) => {
    await addBeer(page);
    await expect(page.locator('.cartbar.bump')).toHaveCount(1);
    await page.getByRole('button', { name: 'Tragos' }).click();             // otro redibujado
    await expect(page.locator('.cartbar')).toHaveCount(1);
    await expect(page.locator('.cartbar.bump')).toHaveCount(0);
  });

  test('el cambio de pantalla anima la entrada y la clase se retira sola', async ({ page }) => {
    await addBeer(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.locator('#app.view-enter')).toHaveCount(1);
    await expect(page.locator('#app.view-enter')).toHaveCount(0, { timeout: 2000 });
  });

  test('el seguimiento muestra una barra de avance que acompaña el estado', async ({ page }) => {
    await addBeer(page);
    await payAndAdvance(page, 0);
    const bar = page.getByRole('progressbar', { name: 'Avance del pedido' });
    await expect(bar).toHaveAttribute('aria-valuenow', '1');
    await page.getByRole('button', { name: 'Avanzar estado' }).click();
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await page.getByRole('button', { name: 'Avanzar estado' }).click();
    await page.getByRole('button', { name: 'Avanzar estado' }).click();
    await expect(page.locator('.pickup-card.glow')).toHaveCount(1);          // el QR de retiro "respira" para llamar la atención
  });

  test('al entregar aparece la celebración y la barra queda completa', async ({ page }) => {
    await addBeer(page);
    await payAndAdvance(page, 4);
    await expect(page.locator('.status-hero.done .confetti i')).toHaveCount(14);
    await expect(page.getByRole('progressbar', { name: 'Avance del pedido' })).toHaveAttribute('aria-valuenow', '5');
  });

  test('cada categoría tiene su tono y el carrito vacío invita a pedir', async ({ page }) => {
    await expect(page.locator('.thumb.t-beer').first()).toBeVisible();
    await addBeer(page);
    await page.getByRole('button', { name: 'Combos' }).click();
    await expect(page.locator('.thumb.t-combo').first()).toBeVisible();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await page.getByRole('button', { name: 'Eliminar Rubia Lager' }).click();
    await expect(page.getByText('Sumá algo rico del menú')).toBeVisible();
    await page.getByRole('button', { name: 'Ver el menú' }).click();
    await expect(page.getByRole('heading', { name: 'Cervecería El Faro' })).toBeVisible();
  });
});
