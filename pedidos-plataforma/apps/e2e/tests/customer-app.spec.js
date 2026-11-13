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

test.describe('Límites del pedido ($100.000, 20 productos u 8 combos)', () => {
  async function addCombo(page) {
    await page.getByRole('button', { name: 'Combos' }).click();
    await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
    await page.getByRole('radio', { name: 'Rubia' }).first().click();
    await page.getByRole('radio', { name: 'Rubia' }).last().click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
  }
  async function addBeer(page) {
    await page.getByRole('button', { name: 'Cervezas' }).click();
    await addWithOption(page, 'Rubia Lager', /Pinta/);
  }
  async function setQty(page, productName, qty) {
    const group = page.getByRole('group', { name: `Cantidad de ${productName}` });
    const current = Number((await group.locator('span').textContent()).trim());
    const button = group.getByRole('button', { name: qty > current ? 'Agregar uno' : 'Quitar uno' });
    for (let i = 0; i < Math.abs(qty - current); i++) await button.click();
  }
  const rows = (page) => page.locator('.limits li');
  const pay = (page) => page.getByRole('button', { name: /Continuar al pago|Revisá los límites/ });

  test('la lista de requisitos muestra ✓ mientras el pedido cumple', async ({ page }) => {
    await addBeer(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.getByRole('region', { name: 'Límites del pedido' })).toBeVisible();
    await expect(rows(page).nth(0)).toHaveClass(/ok/);
    await expect(rows(page).nth(1)).toHaveClass(/ok/);
    await expect(rows(page).nth(1)).toContainText('Hasta 20 productos o 8 combos');
    await expect(page.locator('.limits [role="alert"]')).toHaveCount(0);
    await expect(pay(page)).toHaveText('Continuar al pago');
  });

  test('7 combos entran; el octavo supera los $100.000 y bloquea el pago', async ({ page }) => {
    await addCombo(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Combo 3', 7);                                    // 7 × $12.900 = $90.300
    await expect(rows(page).nth(0)).toHaveClass(/ok/);
    await expect(pay(page)).toBeEnabled();

    await setQty(page, 'Combo 3', 8);                                    // $103.200: 8 combos cumplen la cantidad pero no el gasto
    await expect(rows(page).nth(0)).toHaveClass(/bad/);
    await expect(rows(page).nth(1)).toHaveClass(/ok/);
    const alert = page.locator('.limits [role="alert"]');
    await expect(alert).toContainText('El total no puede superar');
    await expect(alert).toContainText(/3\.200/);                         // cuánto hay que quitar
    await expect(pay(page)).toBeDisabled();
    await expect(pay(page)).toHaveText('Revisá los límites del pedido');

    await setQty(page, 'Combo 3', 7);                                    // al corregirlo, el aviso desaparece
    await expect(page.locator('.limits [role="alert"]')).toHaveCount(0);
    await expect(pay(page)).toBeEnabled();
  });

  test('20 productos entran; el 21 supera la cantidad aunque el gasto esté bien', async ({ page }) => {
    await addBeer(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Rubia Lager', 20);                               // 20 × $4.200 = $84.000
    await expect(rows(page).nth(1)).toHaveClass(/ok/);
    await expect(pay(page)).toBeEnabled();

    await setQty(page, 'Rubia Lager', 21);                               // $88.200: el gasto sigue bien
    await expect(rows(page).nth(0)).toHaveClass(/ok/);
    await expect(rows(page).nth(1)).toHaveClass(/bad/);
    await expect(page.locator('.limits [role="alert"]')).toContainText('Superás el máximo de 20 productos o 8 combos');
    await expect(pay(page)).toBeDisabled();
  });

  test('mezclar: un combo equivale a 2,5 productos', async ({ page }) => {
    await addCombo(page);
    await addBeer(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Combo 3', 5);
    await setQty(page, 'Rubia Lager', 7);                                // 12,5 + 7 = 19,5 · gasto $64.500 + $29.400
    await expect(rows(page).nth(1)).toContainText('equivale a 19,5');
    await expect(pay(page)).toBeEnabled();

    await setQty(page, 'Rubia Lager', 8);                                // 20,5
    await expect(rows(page).nth(1)).toHaveClass(/bad/);
    await expect(rows(page).nth(1)).toContainText('equivale a 20,5');
    await expect(page.locator('.limits [role="alert"]')).toContainText('equivalente a 20,5');
    await expect(pay(page)).toBeDisabled();
  });

  test('la barra de carrito del menú avisa cuando se supera un límite', async ({ page }) => {
    await addBeer(page);
    await expect(page.locator('.cartbar.over')).toHaveCount(0);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Rubia Lager', 21);
    await page.getByRole('button', { name: 'Volver al menú' }).click();
    await expect(page.locator('.cartbar.over')).toContainText('⚠');
  });
});

test.describe('Límites por persona: se suma el pedido abierto', () => {
  async function addCombo(page) {
    await page.getByRole('button', { name: 'Combos' }).click();
    await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
    await page.getByRole('radio', { name: 'Rubia' }).first().click();
    await page.getByRole('radio', { name: 'Rubia' }).last().click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
  }
  async function setQty(page, productName, qty) {
    const group = page.getByRole('group', { name: `Cantidad de ${productName}` });
    const current = Number((await group.locator('span').textContent()).trim());
    const button = group.getByRole('button', { name: qty > current ? 'Agregar uno' : 'Quitar uno' });
    for (let i = 0; i < Math.abs(qty - current); i++) await button.click();
  }

  test('con $90.300 en un pedido abierto, un segundo pedido que suma más de $100.000 se bloquea hasta que el primero se entregue', async ({ page }) => {
    // Primer pedido: 7 combos = $90.300, pagado y en curso
    await addCombo(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Combo 3', 7);
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await page.getByRole('button', { name: /^Pagar/ }).click();
    await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });

    // Segundo pedido: 3 cervezas = $12.600 → $102.900 entre ambos
    await page.getByRole('button', { name: 'Pedir algo más' }).click();
    await page.getByRole('button', { name: 'Cervezas' }).click();
    await addWithOption(page, 'Rubia Lager', /Pinta/);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Rubia Lager', 3);

    const rows = page.locator('.limits li');
    await expect(rows.nth(0)).toHaveClass(/bad/);
    await expect(rows.nth(0)).toContainText('de tu pedido abierto');
    await expect(page.locator('.limits [role="alert"]')).toContainText('Entre este pedido y tu pedido abierto');
    await expect(page.getByRole('button', { name: 'Revisá los límites del pedido' })).toBeDisabled();

    // Con 1 cerveza ($4.200) sí entra: $94.500 en total
    await setQty(page, 'Rubia Lager', 1);
    await expect(rows.nth(0)).toHaveClass(/ok/);
    await expect(page.getByRole('button', { name: 'Continuar al pago' })).toBeEnabled();

    // Al entregarse el primer pedido, deja de contar
    await setQty(page, 'Rubia Lager', 3);
    await expect(rows.nth(0)).toHaveClass(/bad/);
    const next = page.getByRole('button', { name: 'Avanzar estado' });
    for (let i = 0; i < 4; i++) await next.click();                       // aceptado → preparación → listo → entregado
    await page.getByRole('button', { name: 'Hacer otro pedido' }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.locator('.limits li').nth(0)).toHaveClass(/ok/);
    await expect(page.getByRole('button', { name: 'Continuar al pago' })).toBeEnabled();
  });

  test('un pedido rechazado por el local tampoco cuenta', async ({ page }) => {
    await addCombo(page);
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await setQty(page, 'Combo 3', 7);
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await page.getByRole('button', { name: /^Pagar/ }).click();
    await expect(page.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: 'Simular rechazo' }).click();
    await page.getByRole('button', { name: 'Volver al menú' }).last().click();   // el botón principal (el otro es la flecha)
    await page.getByRole('button', { name: 'Combos' }).click();
    await page.getByRole('button', { name: 'Agregar Combo 3' }).click();
    await page.getByRole('radio', { name: 'Rubia' }).first().click();
    await page.getByRole('radio', { name: 'Rubia' }).last().click();
    await page.getByRole('button', { name: /^Agregar ·/ }).click();
    await page.getByRole('button', { name: /Ver carrito/ }).click();
    await expect(page.locator('.limits li').nth(0)).toHaveClass(/ok/);
  });
});
