import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Menu, OrderView } from '../src/api/types';

vi.mock('../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      register: vi.fn(), login: vi.fn(), logout: vi.fn(), me: vi.fn(), menu: vi.fn(), location: vi.fn(),
      createOrder: vi.fn(), order: vi.fn(), checkout: vi.fn(), cancel: vi.fn(),
    },
  };
});
vi.mock('../src/lib/nav', () => ({ redirectTo: vi.fn() }));

import { api, ApiError } from '../src/api/client';
import { App } from '../src/App';
import { redirectTo } from '../src/lib/nav';
import { AuthProvider } from '../src/state/auth';

const m = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const MENU: Menu = {
  menuId: 'm1', eventId: null, paused: false, pauseMessage: null,
  limits: { maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 },
  categories: [
    {
      id: 'c-beer', name: 'Cervezas', paused: false,
      products: [
        {
          id: 'p-lager', name: 'Rubia Lager', description: 'Clásica y fresca', ingredients: null, imageUrl: null, priceCents: 400_000, prepMinutes: 2, available: true, kind: 'simple',
          groups: [{ id: 'g-size', name: 'Tamaño', min: 1, max: 1, options: [{ id: 'o-pinta', name: 'Pinta', priceDeltaCents: 0, available: true }, { id: 'o-jarra', name: 'Jarra', priceDeltaCents: 300_000, available: true }] }],
        },
        { id: 'p-agotada', name: 'IPA Especial', description: null, ingredients: null, imageUrl: null, priceCents: 500_000, prepMinutes: 2, available: false, kind: 'simple', groups: [] },
      ],
    },
    {
      id: 'c-combo', name: 'Combos', paused: false,
      products: [{ id: 'p-combo', name: 'Combo 3', description: null, ingredients: null, imageUrl: null, priceCents: 1_290_000, prepMinutes: 10, available: true, kind: 'combo', groups: [] }],
    },
  ],
};

const ORDER: OrderView = {
  id: 'o1', number: 7, status: 'pending_acceptance', paymentStatus: 'approved', totalCents: 400_000, estimatedReadyAt: null,
  cancelReason: null, originName: null, parts: [{ id: 'part1', status: 'pending', pickupPoint: null, pickup: null }],
};

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}
const logged = () => m(api.me).mockResolvedValue({ id: 'u1', name: 'Ana', isPlatformAdmin: false });
const anonymous = () => m(api.me).mockImplementation(() => Promise.reject(new ApiError(401, 'UNAUTHENTICATED')));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  m(api.menu).mockResolvedValue(MENU);
  anonymous();
});

describe('menú', () => {
  it('muestra categorías y productos con precio; el agotado no se puede pedir', async () => {
    renderAt('/v/el-faro');
    expect(await screen.findByRole('heading', { name: 'Rubia Lager' })).toBeInTheDocument();
    expect(screen.getByText(/4\.000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar IPA Especial' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Combos' }));
    expect(screen.getByRole('heading', { name: 'Combo 3' })).toBeInTheDocument();
  });

  it('un local inexistente muestra un mensaje claro', async () => {
    m(api.menu).mockRejectedValue(new ApiError(404, 'TENANT_NOT_FOUND'));
    renderAt('/v/nadie');
    expect(await screen.findByRole('alert')).toHaveTextContent('No encontramos ese local');
  });

  it('con pedidos pausados avisa y bloquea el botón de agregar', async () => {
    m(api.menu).mockResolvedValue({ ...MENU, paused: true, pauseMessage: 'Volvemos en 10 minutos' });
    renderAt('/v/el-faro');
    expect(await screen.findByText('Volvemos en 10 minutos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar Rubia Lager' })).toBeDisabled();
  });

  it('un QR de sector muestra dónde está el cliente (solo informativo)', async () => {
    m(api.location).mockResolvedValue({ id: 'loc1', name: 'Mesa 4' });
    renderAt(`/v/el-faro?s=${'a'.repeat(64)}`);
    expect(await screen.findByText('Mesa 4')).toBeInTheDocument();
    expect(screen.getByText(/el pedido se retira en la barra/)).toBeInTheDocument();
  });

  it('un QR inválido no impide pedir', async () => {
    m(api.location).mockRejectedValue(new ApiError(404, 'LOCATION_NOT_FOUND'));
    renderAt(`/v/el-faro?s=${'b'.repeat(64)}`);
    expect(await screen.findByRole('heading', { name: 'Rubia Lager' })).toBeInTheDocument();
    expect(screen.queryByText(/Estás en/)).not.toBeInTheDocument();
  });
});

describe('hoja de producto y carrito', () => {
  it('exige elegir el tamaño; luego agrega con el precio correcto y muestra la barra del carrito', async () => {
    renderAt('/v/el-faro');
    await userEvent.click(await screen.findByRole('button', { name: 'Agregar Rubia Lager' }));
    const dialog = screen.getByRole('dialog', { name: 'Rubia Lager' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^Agregar ·/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Elegí una opción de "Tamaño"');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Jarra/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Agregar uno' }));
    expect(within(dialog).getByRole('button', { name: /^Agregar ·/ })).toHaveTextContent(/14\.000/);
    await userEvent.click(within(dialog).getByRole('button', { name: /^Agregar ·/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ver carrito · 2 productos/ })).toHaveTextContent(/14\.000/);
  });

  it('Escape cierra la hoja sin agregar', async () => {
    renderAt('/v/el-faro');
    await userEvent.click(await screen.findByRole('button', { name: 'Agregar Rubia Lager' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ver carrito/ })).not.toBeInTheDocument();
  });

  it('el carrito se conserva al recargar la página', async () => {
    const first = renderAt('/v/el-faro');
    await userEvent.click(await screen.findByRole('button', { name: 'Combos' }));
    await userEvent.click(screen.getByRole('button', { name: 'Agregar Combo 3' }));
    await userEvent.click(screen.getByRole('button', { name: /^Agregar ·/ }));
    first.unmount();
    renderAt('/v/el-faro');
    expect(await screen.findByRole('link', { name: /Ver carrito · 1 producto/ })).toBeInTheDocument();
  });

  it('carrito vacío invita a volver al menú', async () => {
    renderAt('/v/el-faro/carrito');
    expect(await screen.findByText(/Sumá algo rico del menú/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver el menú' })).toHaveAttribute('href', '/v/el-faro');
  });
});

async function fillCart(path = '/v/el-faro', category = 'Combos', product = 'Combo 3') {
  renderAt(path);
  await userEvent.click(await screen.findByRole('button', { name: category }));
  await userEvent.click(screen.getByRole('button', { name: `Agregar ${product}` }));
  await userEvent.click(screen.getByRole('button', { name: /^Agregar ·/ }));
  await userEvent.click(screen.getByRole('link', { name: /Ver carrito/ }));
}

describe('pagar', () => {
  it('sin sesión el botón lleva a iniciar sesión y vuelve al carrito', async () => {
    await fillCart();
    await userEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión para pagar' }));
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    m(api.login).mockResolvedValue({ id: 'u1' });
    logged();
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'clave-larga-1');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { name: 'Tu pedido' })).toBeInTheDocument();   // volvió al carrito
  });

  it('con sesión: crea el pedido con clave de idempotencia, inicia el cobro y redirige al pago', async () => {
    logged();
    m(api.createOrder).mockResolvedValue({ orderId: 'o1', orderNumber: 1, totalCents: 1_290_000, replayed: false });
    m(api.checkout).mockResolvedValue({ checkoutUrl: 'https://pago.example/abc', expiresAt: '2026-01-01T00:00:00Z' });
    await fillCart();
    await userEvent.click(await screen.findByRole('button', { name: /^Pagar/ }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://pago.example/abc'));
    const [slug, body, key] = m(api.createOrder).mock.calls[0] as [string, { paymentMethod: string; items: unknown[] }, string];
    expect(slug).toBe('el-faro');
    expect(body.paymentMethod).toBe('card_online');
    expect(body.items).toEqual([{ productId: 'p-combo', quantity: 1, selections: {} }]);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(api.checkout).toHaveBeenCalledWith('o1');
  });

  it('si el cobro falla tras crear el pedido, el reintento usa la MISMA clave (no duplica pedidos)', async () => {
    logged();
    m(api.createOrder).mockResolvedValue({ orderId: 'o1', orderNumber: 1, totalCents: 1, replayed: false });
    m(api.checkout).mockRejectedValueOnce(new ApiError(409, 'PAYMENT_ACCOUNT_NOT_CONNECTED')).mockResolvedValueOnce({ checkoutUrl: 'https://pago.example/x', expiresAt: '' });
    await fillCart();
    await userEvent.click(await screen.findByRole('button', { name: /^Pagar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('todavía no puede cobrar');
    await userEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalled());
    const keys = m(api.createOrder).mock.calls.map((c) => (c as unknown[])[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('un error del servidor se muestra en lenguaje claro y no se redirige', async () => {
    logged();
    m(api.createOrder).mockRejectedValue(new ApiError(409, 'PAUSED'));
    await fillCart();
    await userEvent.click(await screen.findByRole('button', { name: /^Pagar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('pausó los pedidos');
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it('si el pedido supera el monto máximo avisa y no deja pagar', async () => {
    logged();
    await fillCart();   // 1 combo de $12.900 está bien
    const plus = screen.getByRole('button', { name: 'Agregar uno de Combo 3' });
    for (let i = 0; i < 7; i++) await userEvent.click(plus);   // 8 combos = $103.200
    expect(await screen.findByText(/supera el monto máximo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Pagar/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar uno de Combo 3' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Pagar/ })).toBeEnabled());
  });

  it('el sector escaneado viaja como origen del pedido', async () => {
    logged();
    m(api.location).mockResolvedValue({ id: 'loc-9', name: 'Mesa 9' });
    m(api.createOrder).mockResolvedValue({ orderId: 'o1', orderNumber: 1, totalCents: 1, replayed: false });
    m(api.checkout).mockResolvedValue({ checkoutUrl: 'https://p', expiresAt: '' });
    await fillCart(`/v/el-faro?s=${'c'.repeat(64)}`);
    await userEvent.click(await screen.findByRole('button', { name: /^Pagar/ }));
    await waitFor(() => expect(api.createOrder).toHaveBeenCalled());
    expect((m(api.createOrder).mock.calls[0] as [string, { originLocationId?: string }])[1].originLocationId).toBe('loc-9');
  });
});

describe('cuenta', () => {
  it('login con datos incorrectos muestra el error y no navega', async () => {
    m(api.login).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS'));
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'mala');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no son correctos');
    expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('el registro exige declarar mayoría de edad y una contraseña de 8 caracteres', async () => {
    renderAt('/registro');
    const submit = await screen.findByRole('button', { name: 'Crear cuenta' });
    await userEvent.type(screen.getByLabelText('Nombre'), 'Ana');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'corta');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Contraseña/), '1234');
    expect(submit).toBeDisabled();   // falta declarar la edad
    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('registrarse inicia la sesión y envía la declaración de edad', async () => {
    m(api.register).mockResolvedValue({ id: 'u1' });
    m(api.login).mockResolvedValue({ id: 'u1' });
    renderAt('/registro');
    await userEvent.type(await screen.findByLabelText('Nombre'), 'Ana');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'clave-larga-1');
    await userEvent.click(screen.getByRole('checkbox'));
    logged();
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    await waitFor(() => expect(api.register).toHaveBeenCalledWith({ name: 'Ana', email: 'ana@example.com', password: 'clave-larga-1', phone: null, adultDeclared: true }));
    expect(api.login).toHaveBeenCalled();
  });

  it('un email repetido se explica con claridad', async () => {
    m(api.register).mockRejectedValue(new ApiError(409, 'EMAIL_TAKEN'));
    renderAt('/registro');
    await userEvent.type(await screen.findByLabelText('Nombre'), 'Ana');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'clave-larga-1');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una cuenta');
  });

  it('un next externo no redirige fuera de la app', async () => {
    m(api.login).mockResolvedValue({ id: 'u1' });
    renderAt('/login?next=https://malo.com');
    logged();
    await userEvent.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'clave-larga-1');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { name: 'Pedí y pagá desde tu celular' })).toBeInTheDocument();
  });
});

describe('seguimiento sin sesión', () => {
  it('sin sesión lleva a iniciar sesión', async () => {
    m(api.order).mockImplementation(() => Promise.reject(new ApiError(401, 'UNAUTHENTICATED')));
    renderAt('/orders/o1');
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });
});

describe('seguimiento del pedido', () => {
  beforeEach(() => logged());

  it('esperando al local: sin QR, con progreso y opción de cancelar', async () => {
    m(api.order).mockResolvedValue(ORDER);
    renderAt('/orders/o1');
    expect(await screen.findByRole('heading', { name: 'Esperando al local' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Avance del pedido' })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.queryByRole('img', { name: /Código QR/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar pedido' })).toBeInTheDocument();
  });

  it('listo para retirar: muestra el QR y el código corto bien visibles', async () => {
    m(api.order).mockResolvedValue({
      ...ORDER, status: 'ready', parts: [{ id: 'part1', status: 'ready', pickupPoint: 'Barra principal', pickup: { token: 'tok-123', shortCode: 'K7M2', used: false } }],
    });
    renderAt('/orders/o1');
    expect(await screen.findByRole('heading', { name: 'Listo para retirar' })).toBeInTheDocument();
    expect(screen.getByText(/Retirá tu pedido en Barra principal/)).toBeInTheDocument();
    expect(screen.getByText('K7M2')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Código QR/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).not.toBeInTheDocument();
  });

  it('entregado: celebración y barra completa; sin cancelar', async () => {
    m(api.order).mockResolvedValue({ ...ORDER, status: 'delivered', parts: [{ id: 'part1', status: 'delivered', pickupPoint: 'Barra', pickup: null }] });
    renderAt('/orders/o1');
    expect(await screen.findByRole('heading', { name: 'Entregado' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
    expect(document.querySelectorAll('.confetti i')).toHaveLength(14);
    expect(screen.getByText(/Retirado/)).toBeInTheDocument();
  });

  it('rechazado: explica el reembolso y no muestra la barra de avance', async () => {
    m(api.order).mockResolvedValue({ ...ORDER, status: 'rejected', paymentStatus: 'refund_pending' });
    renderAt('/orders/o1');
    expect(await screen.findByText('Iniciamos el reembolso de tu pago.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('volver de un pago fallido ofrece reintentar', async () => {
    m(api.order).mockResolvedValue({ ...ORDER, status: 'awaiting_payment', paymentStatus: 'pending' });
    m(api.checkout).mockResolvedValue({ checkoutUrl: 'https://pago.example/r', expiresAt: '' });
    renderAt('/orders/o1?pago=error');
    expect(await screen.findByRole('alert')).toHaveTextContent('El pago no se pudo completar');
    await userEvent.click(screen.getByRole('button', { name: 'Pagar ahora' }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://pago.example/r'));
  });

  it('cancelar pide confirmación y llama a la API solo si se acepta', async () => {
    m(api.order).mockResolvedValue(ORDER);
    m(api.cancel).mockResolvedValue({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderAt('/orders/o1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    expect(api.cancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('o1'));
    confirm.mockRestore();
  });

  it('un pedido ajeno o inexistente muestra un mensaje y no datos', async () => {
    m(api.order).mockRejectedValue(new ApiError(404, 'ORDER_NOT_FOUND'));
    renderAt('/orders/otro');
    expect(await screen.findByRole('alert')).toHaveTextContent('No encontramos ese pedido');
  });

});
