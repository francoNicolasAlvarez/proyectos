'use strict';
/* Almacén compartido de demostración entre el prototipo del cliente y el del panel.
   Usa localStorage (se sincroniza entre pestañas con el evento "storage").
   En producción esto lo reemplazan la API y el tiempo real (SSE). */
const Store = {
  key: 'pasamanos.demo.v1',
  empty() { return { orders: [], unavailable: null, paused: false }; },
  read() {
    try { return { ...this.empty(), ...(JSON.parse(localStorage.getItem(this.key)) || {}) }; }
    catch (e) { return this.empty(); }
  },
  write(data) { try { localStorage.setItem(this.key, JSON.stringify(data)); } catch (e) { /* sin almacenamiento */ } },
  update(fn) { const d = this.read(); fn(d); this.write(d); return d; },
  upsertOrder(order) {
    return this.update((d) => {
      const i = d.orders.findIndex((o) => o.number === order.number);
      if (i >= 0) d.orders[i] = order; else d.orders.push(order);
    });
  },
  nextNumber() {
    const max = this.read().orders.reduce((m, o) => Math.max(m, parseInt(o.number.slice(1), 10) || 0), 41);
    return '#' + String(max + 1).padStart(3, '0');
  },
  reset() { try { localStorage.removeItem(this.key); } catch (e) { /* nada */ } },
  onChange(cb) { window.addEventListener('storage', (e) => { if (e.key === this.key) cb(this.read()); }); },
};
