const { test, expect } = require('@playwright/test');
const { panelUrl } = require('./helpers');

const orderCode = (page, i = 0) => page.evaluate((idx) => Store.read().orders[idx].parts[0].code, i);

async function newOrder(page) {
  await page.getByRole('button', { name: 'Simular pedido entrante' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(panelUrl);
});

test('el tablero vacío muestra las tres columnas sin pedidos', async ({ page }) => {
  await expect(page.getByRole('region', { name: 'Nuevos' })).toContainText('Sin pedidos');
  await expect(page.getByRole('region', { name: 'En preparación' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Listos para retirar' })).toBeVisible();
});

test('un pedido entrante aparece en Nuevos con su plazo de respuesta', async ({ page }) => {
  await newOrder(page);
  const nuevos = page.getByRole('region', { name: 'Nuevos' });
  await expect(nuevos.locator('.ocard')).toHaveCount(1);
  await expect(nuevos).toContainText('Pago aprobado');
  await expect(nuevos.locator('.countdown')).toHaveText(/^0[45]:\d\d$/);
});

test('aceptar con un tiempo estimado lo pasa a En preparación', async ({ page }) => {
  await newOrder(page);
  await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
  await page.getByLabel('Tiempo estimado (minutos)').fill('20');
  await page.getByRole('button', { name: 'Aceptar pedido' }).click();
  const prep = page.getByRole('region', { name: 'En preparación' });
  await expect(prep.locator('.ocard')).toHaveCount(1);
  await expect(prep).toContainText('~20 min');
  expect(await page.evaluate(() => Store.read().orders[0].eta)).toBe(20);
});

test('rechazar exige un motivo y registra el rechazo', async ({ page }) => {
  await newOrder(page);
  await page.getByRole('button', { name: 'Rechazar', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Rechazar y reembolsar' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('radio', { name: 'Falta de ingredientes' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole('region', { name: 'Nuevos' })).toContainText('Sin pedidos');
  await expect(page.locator('#summary')).toContainText('Rechazados: 1');
  expect(await page.evaluate(() => Store.read().orders[0].rejectReason)).toBe('Falta de ingredientes');
});

test('Escape cierra los diálogos', async ({ page }) => {
  await newOrder(page);
  await page.getByRole('button', { name: 'Rechazar', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('marcar listo sin punto asignado pide elegir el punto de retiro (D1)', async ({ page }) => {
  await newOrder(page);
  await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar pedido' }).click();
  await page.getByRole('button', { name: 'Empezar a preparar' }).click();
  await page.getByRole('button', { name: 'Marcar listo' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('¿Dónde retira');
  await expect(dlg.getByRole('button', { name: 'Marcar listo' })).toBeDisabled();
  await dlg.getByRole('radio', { name: 'Barra 1' }).click();
  await dlg.getByRole('button', { name: 'Marcar listo' }).click();
  const listos = page.getByRole('region', { name: 'Listos para retirar' });
  await expect(listos.locator('.ocard')).toHaveCount(1);
  await expect(listos).toContainText('Barra 1');
});

test.describe('escáner de entrega', () => {
  async function readyOrder(page) {
    await newOrder(page);
    await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
    await page.getByRole('button', { name: 'Aceptar pedido' }).click();
    await page.getByRole('button', { name: 'Empezar a preparar' }).click();
    await page.getByRole('button', { name: 'Marcar listo' }).click();
    await page.getByRole('dialog').getByRole('radio', { name: 'Barra 1' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Marcar listo' }).click();
  }
  const scan = async (page, code) => {
    await page.getByLabel('Código').fill(code);
    await page.getByRole('button', { name: 'Validar' }).click();
  };

  test('rechaza códigos inexistentes', async ({ page }) => {
    await page.getByRole('button', { name: 'Escanear entrega' }).first().click();
    await scan(page, 'ZZZZ');
    await expect(page.getByRole('alert')).toContainText('Código inválido');
  });

  test('un pedido que no está listo no se puede entregar', async ({ page }) => {
    await newOrder(page);
    const code = await orderCode(page);
    await page.getByRole('button', { name: 'Escanear entrega' }).first().click();
    await scan(page, code);
    await expect(page.getByRole('alert')).toContainText('todavía no está listo');
  });

  test('confirma la entrega una sola vez y registra quién y cuándo', async ({ page }) => {
    await readyOrder(page);
    const code = await orderCode(page);
    await page.getByRole('button', { name: 'Escanear entrega' }).first().click();
    await scan(page, code.toLowerCase());
    await expect(page.getByRole('dialog')).toContainText('Barra 1');
    await page.getByRole('button', { name: 'Confirmar entrega' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entrega confirmada' })).toBeVisible();
    await expect(page.locator('#summary')).toContainText('Entregados: 1');

    const part = await page.evaluate(() => Store.read().orders[0].parts[0]);
    expect(part.status).toBe('delivered');
    expect(part.deliveredBy).toBeTruthy();
    expect(part.deliveredAt).toBeGreaterThan(0);

    await scan(page, code);
    await expect(page.getByRole('alert')).toContainText('Ya utilizado');
  });
});

test('la disponibilidad se puede cambiar y queda guardada', async ({ page }) => {
  await page.getByRole('button', { name: 'Disponibilidad' }).click();
  const sw = page.getByRole('switch', { name: 'Rubia Lager' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => Store.read().unavailable)).toContain('p1');
  await expect(page.getByRole('switch', { name: 'Gin tonic' })).toHaveAttribute('aria-checked', 'false');
});

test('pausar pedidos muestra el aviso y se puede reanudar', async ({ page }) => {
  const btn = page.getByRole('button', { name: 'Pausar pedidos' });
  await btn.click();
  await expect(page.locator('#paused-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reanudar pedidos' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reanudar pedidos' }).click();
  await expect(page.locator('#paused-banner')).toBeHidden();
});

test('los pedidos se numeran en forma consecutiva', async ({ page }) => {
  await newOrder(page);
  await newOrder(page);
  const nums = await page.evaluate(() => Store.read().orders.map((o) => o.number));
  expect(nums).toEqual(['#042', '#043']);
});
