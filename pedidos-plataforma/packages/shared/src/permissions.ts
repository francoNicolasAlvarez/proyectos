/** Permisos por rol (tabla del análisis funcional, sección 4). El cliente no tiene rol de local: opera solo sobre sus pedidos. */

export type TenantRole = 'owner' | 'manager' | 'order_operator' | 'pickup_operator';

export type Action =
  | 'venue.configure'      // configuración del local, pagos, marca
  | 'staff.manage'         // empleados y roles
  | 'catalog.manage'       // categorías, productos, precios, combos
  | 'availability.update'  // agotar o reactivar productos, pausar categorías
  | 'locations.manage'     // sectores, QR y puntos de retiro
  | 'orders.view'
  | 'orders.process'       // aceptar, rechazar, preparar, marcar listo
  | 'orders.deliver'       // validar entregas
  | 'refunds.issue'
  | 'stats.view';

const MATRIX: Record<Action, readonly TenantRole[]> = {
  'venue.configure': ['owner'],
  'staff.manage': ['owner'],
  'catalog.manage': ['owner', 'manager'],
  'availability.update': ['owner', 'manager', 'order_operator'],
  'locations.manage': ['owner', 'manager'],
  'orders.view': ['owner', 'manager', 'order_operator', 'pickup_operator'],
  'orders.process': ['owner', 'manager', 'order_operator'],
  'orders.deliver': ['owner', 'manager', 'order_operator', 'pickup_operator'],
  'refunds.issue': ['owner', 'manager'],
  'stats.view': ['owner', 'manager'],
};

export const ACTIONS = Object.keys(MATRIX) as Action[];

/** ¿Puede este rol de local realizar la acción? El administrador de plataforma se evalúa aparte (isPlatformAdmin). */
export const can = (role: TenantRole | null | undefined, action: Action): boolean => !!role && MATRIX[action].includes(role);

/** El super admin puede todo dentro de un local y tiene además las acciones de plataforma. */
export const canPlatform = (isPlatformAdmin: boolean, action: Action | 'platform.manage'): boolean =>
  isPlatformAdmin && (action === 'platform.manage' || ACTIONS.includes(action));

export const rolesAllowed = (action: Action): readonly TenantRole[] => MATRIX[action];
