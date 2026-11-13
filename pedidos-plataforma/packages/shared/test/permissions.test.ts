import { describe, expect, it } from 'vitest';
import { ACTIONS, can, canPlatform, rolesAllowed, type Action, type TenantRole } from '../src';

describe('permisos por rol', () => {
  // Tabla del análisis funcional (docs/functional-analysis.md, sección 4)
  const expected: Record<Action, TenantRole[]> = {
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
  const roles: TenantRole[] = ['owner', 'manager', 'order_operator', 'pickup_operator'];

  it.each(ACTIONS)('acción %s: solo los roles esperados', (action) => {
    for (const r of roles) expect(can(r, action), `${r} → ${action}`).toBe(expected[action].includes(r));
    expect([...rolesAllowed(action)].sort()).toEqual([...expected[action]].sort());
  });

  it('cubre todas las acciones de la tabla', () => { expect([...ACTIONS].sort()).toEqual(Object.keys(expected).sort()); });
  it('sin rol no se puede nada', () => { for (const a of ACTIONS) { expect(can(null, a)).toBe(false); expect(can(undefined, a)).toBe(false); } });
  it('el operador de entrega solo ve pedidos y valida entregas', () => {
    expect(ACTIONS.filter((a) => can('pickup_operator', a)).sort()).toEqual(['orders.deliver', 'orders.view']);
  });
  it('solo el administrador de plataforma tiene acciones de plataforma', () => {
    expect(canPlatform(true, 'platform.manage')).toBe(true);
    expect(canPlatform(false, 'platform.manage')).toBe(false);
    expect(canPlatform(true, 'orders.process')).toBe(true);
    expect(canPlatform(false, 'orders.process')).toBe(false);
  });
});
