const { test, expect } = require('@playwright/test');
const { customerUrl, panelUrl } = require('./helpers');

/* Cliente y panel en la misma sesión del navegador: comparten datos como lo harán por la API. */
async function setup(context) {
  const customer = await context.newPage();
  const panel = await context.newPage();
  await customer.goto(customerUrl);
  await panel.goto(panelUrl);
  return { customer, panel };
}

async function orderOneBeer(customer) {
  await customer.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
  await customer.getByRole('radio', { name: /Pinta/ }).click();
  await customer.getByRole('button', { name: /^Agregar ·/ }).click();
  await customer.getByRole('button', { name: /Ver carrito/ }).click();
  await customer.getByRole('button', { name: 'Continuar al pago' }).click();
  await customer.getByRole('button', { name: /^Pagar/ }).click();
  await expect(customer.getByRole('heading', { name: 'Esperando al local' })).toBeVisible({ timeout: 8000 });
}

test('ciclo completo: el cliente pide, el local gestiona y el cliente retira', async ({ context }) => {
  const { customer, panel } = await setup(context);
  await orderOneBeer(customer);

  // El pedido llega al local y puede aceptarlo
  const nuevos = panel.getByRole('region', { name: 'Nuevos' });
  await expect(nuevos.locator('.ocard')).toHaveCount(1, { timeout: 8000 });
  await expect(nuevos).toContainText('Origen: Mesa 5');
  await expect(nuevos).toContainText('Rubia Lager');
  await panel.getByRole('button', { name: 'Aceptar', exact: true }).click();
  await panel.getByLabel('Tiempo estimado (minutos)').fill('7');
  await panel.getByRole('button', { name: 'Aceptar pedido' }).click();

  // El cliente ve la aceptación con el tiempo indicado por el local
  await expect(customer.getByRole('heading', { name: 'Pedido aceptado' })).toBeVisible();
  await expect(customer.getByText('Tiempo estimado: ~7 min')).toBeVisible();

  await panel.getByRole('button', { name: 'Empezar a preparar' }).click();
  await expect(customer.getByRole('heading', { name: 'En preparación' })).toBeVisible();
  await panel.getByRole('button', { name: 'Marcar listo' }).click();

  // El cliente ve el QR y el punto de retiro
  await expect(customer.getByRole('heading', { name: 'Listo para retirar' })).toBeVisible();
  const card = customer.locator('.pickup-card');
  await expect(card).toContainText('Barra 1');
  const code = (await card.locator('.code').textContent()).trim();

  // El local valida con el código del cliente
  await panel.getByRole('button', { name: 'Escanear entrega' }).first().click();
  await panel.getByLabel('Código').fill(code);
  await panel.getByRole('button', { name: 'Validar' }).click();
  await panel.getByRole('button', { name: 'Confirmar entrega' }).click();
  await expect(customer.getByRole('heading', { name: 'Entregado' })).toBeVisible();

  // Un segundo intento con el mismo código se rechaza
  await panel.getByLabel('Código').fill(code);
  await panel.getByRole('button', { name: 'Validar' }).click();
  await expect(panel.getByRole('alert')).toContainText('Ya utilizado');
});

test('si el local rechaza, el cliente ve el motivo elegido y el reembolso', async ({ context }) => {
  const { customer, panel } = await setup(context);
  await orderOneBeer(customer);
  await expect(panel.getByRole('region', { name: 'Nuevos' }).locator('.ocard')).toHaveCount(1, { timeout: 8000 });
  await panel.getByRole('button', { name: 'Rechazar', exact: true }).click();
  await panel.getByRole('radio', { name: 'Capacidad operativa excedida' }).click();
  await panel.getByRole('button', { name: 'Rechazar y reembolsar' }).click();
  await expect(customer.getByText('Capacidad operativa excedida')).toBeVisible();
  await expect(customer.getByText(/Iniciamos el reembolso/)).toBeVisible();
});

test('un producto marcado como agotado en el panel no se puede pedir', async ({ context }) => {
  const { customer, panel } = await setup(context);
  await expect(customer.getByRole('button', { name: 'Agregar Rubia Lager', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Disponibilidad' }).click();
  await panel.getByRole('switch', { name: 'Rubia Lager' }).click();
  await expect(customer.getByRole('button', { name: 'Agregar Rubia Lager', exact: true })).toBeDisabled();
  await panel.getByRole('switch', { name: 'Rubia Lager' }).click();
  await expect(customer.getByRole('button', { name: 'Agregar Rubia Lager', exact: true })).toBeEnabled();
});

test('con los pedidos pausados el cliente no puede pagar', async ({ context }) => {
  const { customer, panel } = await setup(context);
  await customer.getByRole('button', { name: 'Agregar Rubia Lager', exact: true }).click();
  await customer.getByRole('radio', { name: /Pinta/ }).click();
  await customer.getByRole('button', { name: /^Agregar ·/ }).click();
  await panel.getByRole('button', { name: 'Pausar pedidos' }).click();
  await expect(customer.getByText(/El local pausó los pedidos/)).toBeVisible();
  await customer.getByRole('button', { name: /Ver carrito/ }).click();
  await expect(customer.getByRole('button', { name: 'Pedidos pausados' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Reanudar pedidos' }).click();
  await expect(customer.getByRole('button', { name: 'Continuar al pago' })).toBeEnabled();
});

test('el pedido del cliente no se mezcla con los de otro cliente: números consecutivos', async ({ context }) => {
  const { customer, panel } = await setup(context);
  await panel.getByRole('button', { name: 'Simular pedido entrante' }).click(); // #042
  await orderOneBeer(customer); // #043
  await expect(customer.getByRole('heading', { name: 'Pedido #043' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Nuevos' }).locator('.ocard')).toHaveCount(2, { timeout: 8000 });
});
