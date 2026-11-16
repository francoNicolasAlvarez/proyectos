import { ApiError } from '../api/client';

/** Mensajes claros para el cliente según el código de negocio de la API. */
const MESSAGES: Record<string, string> = {
  NETWORK: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  INVALID_CREDENTIALS: 'El email o la contraseña no son correctos.',
  RATE_LIMITED: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
  ACCOUNT_BLOCKED: 'Tu cuenta está bloqueada. Contactá al local o a soporte.',
  EMAIL_TAKEN: 'Ya existe una cuenta con ese email. Probá iniciando sesión.',
  UNAUTHENTICATED: 'Iniciá sesión para continuar.',
  TENANT_NOT_FOUND: 'No encontramos ese local. Revisá el QR o el enlace.',
  TENANT_NOT_ACTIVE: 'Este local no está disponible por ahora.',
  NO_ACTIVE_MENU: 'Este local todavía no tiene un menú disponible.',
  PAUSED: 'El local pausó los pedidos por un momento. Probá en unos minutos.',
  CLOSED: 'El local está cerrado en este momento.',
  CONCURRENT_LIMIT: 'El local tiene muchos pedidos en curso. Probá en unos minutos.',
  INTERVAL_LIMIT: 'El local llegó al máximo de pedidos para este rato. Probá en unos minutos.',
  ORDER_TOTAL_LIMIT_EXCEEDED: 'El pedido supera el monto máximo permitido. Sacá algún producto.',
  ORDER_ITEM_LIMIT_EXCEEDED: 'El pedido supera la cantidad máxima de productos. Sacá alguno.',
  PRODUCT_UNAVAILABLE: 'Algún producto del carrito ya no está disponible. Revisalo y volvé a intentar.',
  PRODUCT_NOT_IN_ACTIVE_MENU: 'Algún producto ya no está en el menú actual. Revisá el carrito.',
  OPTION_UNAVAILABLE: 'Alguna opción elegida ya no está disponible. Revisá el carrito.',
  PAYMENT_METHOD_NOT_AVAILABLE: 'Este local no acepta ese medio de pago.',
  PAYMENT_ACCOUNT_NOT_CONNECTED: 'Este local todavía no puede cobrar en línea.',
  ORDER_NOT_PAYABLE: 'Este pedido ya no se puede pagar.',
  PAYMENT_WINDOW_EXPIRED: 'Se venció el tiempo para pagar. Hacé el pedido de nuevo.',
  ORDER_NOT_FOUND: 'No encontramos ese pedido.',
  IDEMPOTENCY_KEY_REUSED: 'Ya enviaste un pedido distinto con esta operación. Recargá e intentá de nuevo.',
  CSRF: 'La operación fue rechazada por seguridad. Recargá la página.',
  INTERNAL: 'Algo salió mal de nuestro lado. Intentá de nuevo en un momento.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (MESSAGES[e.code]) return MESSAGES[e.code] as string;
    if (e.status === 400 || e.status === 422) return 'Revisá los datos ingresados.';
    if (e.status >= 500) return MESSAGES.INTERNAL as string;
  }
  return 'No pudimos completar la operación. Intentá de nuevo.';
}

/** Etiqueta y descripción de cada estado del pedido para el seguimiento. */
export const STATUS_COPY: Record<string, { title: string; hint: string; step: number }> = {
  awaiting_payment: { title: 'Esperando el pago', hint: 'Completá el pago para que el local reciba tu pedido.', step: 0 },
  pending_acceptance: { title: 'Esperando al local', hint: 'Tu pago está aprobado. El local confirmará el pedido en breve.', step: 1 },
  accepted: { title: 'Pedido aceptado', hint: 'El local aceptó tu pedido.', step: 2 },
  preparing: { title: 'En preparación', hint: 'Estamos preparando tu pedido.', step: 3 },
  ready: { title: 'Listo para retirar', hint: 'Mostrá el QR o el código en el punto de retiro.', step: 4 },
  delivered: { title: 'Entregado', hint: '¡Buen provecho!', step: 5 },
  rejected: { title: 'El local no pudo tomar el pedido', hint: 'Iniciamos el reembolso de tu pago.', step: 0 },
  cancelled: { title: 'Pedido cancelado', hint: 'Si ya habías pagado, se reembolsa.', step: 0 },
  not_picked_up: { title: 'No se retiró', hint: 'El pedido no fue retirado a tiempo.', step: 0 },
};
