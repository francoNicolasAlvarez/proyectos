const { test, expect } = require('@playwright/test');
const { customerUrl } = require('./helpers');

/** Agrega al carrito un producto con una opción obligatoria. */
async function addWithOption(page, productName, optionName) {
  await page.getByRole('button', { name: `Agregar ${productName}`, exact: true }).click();
  await page.getByRole('radio', { name: optionName }).click();
  await page.getByRole('button', { name: /^Agregar ·/ }).click();
}

async function payAndWaitForVenue(page) {
  await page.getByRole('button', { name: /Ver carrito/ }).click();
  await page.getByRole('button', { name: 'Continuar al pago' }).click();
  await page.getByRole('button', { name: /^Pagar/ }).click();
  await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto(customerUrl);
});

test.describe('Menú', () => {
  test('muestra el local, el origen y los productos', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Cervecería El Faro' })).toBeVisible();
    await expect(page.getByText('Mesa 5')).toBeVisible();
    await expect(page.getByText('El pedido se retira en la barra')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rubia Lager' })).toBeVisible();
  });

  test('cambia de categoría', async ({ page }) => {
    await page.getByRole('button', { name: 'Comidas' }).click();
    await expect(page.getByRole('heading', { name: 'Hamburguesa clásica' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rubia Lager' })).toHaveCount(0);
  });

  test('un producto no disponible no se puede agregar', async ({ page }) => {
    await page.getByRole('button', { name: 'Tragos' }).click();
    await expect(page.getByRole('button', { name: 'Agregar Gin tonic' })).toBeDisabled();
    await expect(page.getByText('No disponible')).toBeVisible();
  });

  test('no hay scroll horizontal', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});

test.describe('Producto y carrito', () => {
  test('las opciones obligatorias bloquean el botón de agregar', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Elegí las opciones' })).toBeDisabled();
    await page.getByRole('radio', { name: /Pinta/ }).click();
    await expect(page.getByRole('button', { name: /^Agregar ·/ })).toBeEnabled();
  });

  test('el precio de la hoja suma el extra de la opción', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
    await page.getByRole('radio', { name: /Jarra/ }).click();
    // 4200 + 3800 = 8000
    await expect(page.getByRole('button', { name: /^Agregar ·/ })).toContainText(/8\.000/);
  });

  test('un combo exige elegir las dos cervezas', async ({ page }) => {
    await page.getByRole('button', { name: 'Combos' }).click();
    await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
    const add = page.getByRole('button', { name: /^Agregar ·|Elegí las opciones/ });
    await expect(add).toBeDisabled();
    await page.getByRole('radio', { name: 'Rubia' }).first().click();
    await expect(add).toBeDisabled();
    await page.getByRole('radio', { name: 'IPA' }).last().click();
    await expect(add).toBeEnabled();
  });

  test('los agregados opcionales respetan el máximo', async ({ page }) => {
    await page.getByRole('button', { name: 'Sin alcohol' }).click();
    await page.getByRole('button', { name: 'Agregar Limonada' }).click();
    await page.getByRole('checkbox', { name: /Jengibre/ }).click();
    await page.getByRole('checkbox', { name: /Menta/ }).click();
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
  });

  test('modifica cantidades y elimina productos del carrito', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await page.getByRole('button', { name: 'Agregar uno' }).click();
    await expect(page.getByRole('group', { name: /Cantidad de Rubia Lager/ })).toContainText('2');
    await expect(page.locator('.grand')).toContainText(/8\.400/);
    await page.getByRole('button', { name: 'Quitar uno' }).click();
    await expect(page.locator('.grand')).toContainText(/4\.200/);
    await page.getByRole('button', { name: 'Eliminar Rubia Lager' }).click();
    await expect(page.getByText('Tu carrito está vacío.')).toBeVisible();
  });

  test('el mismo producto con la misma opción se agrupa en una línea', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.locator('.line')).toHaveCount(1);
    await expect(page.getByRole('group', { name: /Cantidad de Rubia Lager/ })).toContainText('2');
  });

  test('avisa cuando el pedido se retira en dos puntos', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: 'Comidas' }).click();
    await page.getByRole('button', { name: 'Agregar Papas fritas' }).click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.getByText('2 puntos')).toBeVisible();
    await expect(page.getByText(/Barra 1 y Punto de comida/)).toBeVisible();
  });
});

test.describe('Origen del pedido', () => {
  test('se puede cambiar el origen y quitarlo', async ({ page }) => {
    await page.getByRole('button', { name: 'Cambiar' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Siempre se retira en la barra');
    await dialog.getByRole('radio', { name: 'Sector VIP' }).click();
    await expect(page.locator('.origin-chip')).toContainText('Sector VIP');
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await page.getByRole('radio', { name: /Estoy afuera/ }).click();
    await expect(page.locator('.origin-chip')).toContainText('Sin ubicación');
  });

  test('Escape cierra la hoja', async ({ page }) => {
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('Pago, seguimiento y retiro', () => {
  test('flujo completo con retiro en dos puntos', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: 'Comidas' }).click();
    await page.getByRole('button', { name: 'Agregar Papas fritas' }).click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await payAndWaitForVenue(page);

    const next = page.getByRole('button', { name: 'Avanzar estado' });
    await next.click();
    await expect(page.getByRole('heading', { name: 'Pedido aceptado' })).toBeVisible();
    await expect(page.getByText(/Tiempo estimado: ~15 min/)).toBeVisible();
    await next.click();
    await expect(page.getByRole('heading', { name: 'En preparación' })).toBeVisible();
    await next.click();
    await expect(page.getByRole('heading', { name: 'Listo para retirar' })).toBeVisible();

    const cards = page.locator('.pickup-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText(/Barra 1|Punto de comida/);
    for (const card of await cards.all()) {
      await expect(card.locator('svg')).toBeVisible();
      await expect(card.locator('.code')).toHaveText(/^[A-Z2-9]{4}$/);
    }

    await next.click();
    await expect(page.getByRole('heading', { name: 'Entregado' })).toBeVisible();
    await page.getByRole('button', { name: 'Hacer otro pedido' }).click();
    await expect(page.getByRole('heading', { name: 'Cervecería El Faro' })).toBeVisible();
  });

  test('con un solo punto hay una sola tarjeta de retiro', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await payAndWaitForVenue(page);
    const next = page.getByRole('button', { name: 'Avanzar estado' });
    for (let i = 0; i < 3; i++) await next.click();
    await expect(page.locator('.pickup-card')).toHaveCount(1);
    await expect(page.locator('.pickup-card')).toContainText('Barra 1');
  });

  test('el rechazo muestra el motivo y el reembolso', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await payAndWaitForVenue(page);
    await page.getByRole('button', { name: 'Simular rechazo' }).click();
    await expect(page.getByText('Producto sin disponibilidad')).toBeVisible();
    await expect(page.getByText(/Iniciamos el reembolso/)).toBeVisible();
  });

  test('con un pedido en curso, el menú muestra un banner y permite pedir más', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await payAndWaitForVenue(page);
    await page.getByRole('button', { name: 'Pedir algo más' }).click();
    const banner = page.locator('.order-banner');
    await expect(banner).toContainText('Esperando al local');
    await banner.click();
    await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();
  });

  test('los números de pedido y los códigos son distintos entre pedidos', async ({ page }) => {
    const codes = [];
    for (let i = 0; i < 2; i++) {
      await addWithOption(page, 'Rubia Lager', /Pinta/);
      await payAndWaitForVenue(page);
      const next = page.getByRole('button', { name: 'Avanzar estado' });
      for (let k = 0; k < 3; k++) await next.click();
      codes.push((await page.locator('.pickup-card .code').first().textContent()) + (await page.getByRole('heading', { name: /Pedido #/ }).textContent()));
      await next.click();
      await page.getByRole('button', { name: 'Hacer otro pedido' }).click();
    }
    expect(new Set(codes).size).toBe(2);
  });
});

test.describe('Marca del local', () => {
  test('cambiar el color del local actualiza los tokens de marca', async ({ page }) => {
    const brand = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
    const before = await brand();
    await page.getByRole('button', { name: 'Color del local' }).click();
    expect(await brand()).not.toBe(before);
  });

  test('reiniciar vuelve al estado inicial', async ({ page }) => {
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: 'Reiniciar' }).click();
    await expect(page.getByRole('button', { name: /Ver carrito/ })).toHaveCount(0);
  });
});
