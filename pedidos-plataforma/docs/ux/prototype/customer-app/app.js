'use strict';
/* Prototipo navegable de la app del cliente (Pasamanos).
   Datos y pagos simulados. No es código de producción. */

const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

const VENUE = { name: 'Cervecería El Faro', initial: 'F', tagline: 'Abierto hasta las 02:00' };
const POINTS = { barra: 'Barra 1', comida: 'Punto de comida' };
const ORIGINS = ['Mesa 5', 'Barra principal', 'Sector VIP', 'Patio exterior', 'Sector general'];
const THEMES = [
  { a: '#3451d1', b: '#6741d9' },
  { a: '#1a56c8', b: '#2563d9' },
  { a: '#4338ca', b: '#7c3aed' },
];
const CATS = [
  { id: 'beer', name: 'Cervezas' },
  { id: 'drinks', name: 'Tragos' },
  { id: 'soft', name: 'Sin alcohol' },
  { id: 'food', name: 'Comidas' },
  { id: 'combo', name: 'Combos' },
];
const SIZES = { id: 'size', name: 'Tamaño', min: 1, max: 1, options: [
  { id: 'pint', name: 'Pinta (473 ml)', delta: 0 },
  { id: 'half', name: 'Jarra (1 L)', delta: 3800 },
] };
const BEERS = (id, name) => ({ id, name, min: 1, max: 1, options: [
  { id: 'rubia', name: 'Rubia', delta: 0 },
  { id: 'ipa', name: 'IPA', delta: 400 },
  { id: 'roja', name: 'Roja', delta: 0 },
] });
const PRODUCTS = [
  { id: 'p1', cat: 'beer', emoji: '🍺', name: 'Rubia Lager', desc: 'Suave y refrescante.', ingredients: 'Malta, lúpulo, levadura', price: 4200, prep: 2, point: 'barra', available: true, groups: [SIZES] },
  { id: 'p2', cat: 'beer', emoji: '🍻', name: 'IPA de la casa', desc: 'Amarga, cítrica, intensa.', ingredients: 'Malta, lúpulo cítrico', price: 4600, prep: 2, point: 'barra', available: true, groups: [SIZES] },
  { id: 'p3', cat: 'drinks', emoji: '🍹', name: 'Daikiri', desc: 'Ron, limón y azúcar.', ingredients: 'Ron blanco, limón, azúcar', price: 6500, prep: 6, point: 'barra', available: true,
    groups: [{ id: 'flavor', name: 'Sabor', min: 1, max: 1, options: [
      { id: 'classic', name: 'Clásico', delta: 0 }, { id: 'straw', name: 'Frutilla', delta: 500 }, { id: 'peach', name: 'Durazno', delta: 500 } ] }] },
  { id: 'p4', cat: 'drinks', emoji: '🍸', name: 'Gin tonic', desc: 'Gin, tónica y pepino.', ingredients: 'Gin, tónica, pepino', price: 7000, prep: 5, point: 'barra', available: false, groups: [] },
  { id: 'p5', cat: 'soft', emoji: '🍋', name: 'Limonada', desc: 'Exprimida al momento.', ingredients: 'Limón, azúcar, agua', price: 3200, prep: 3, point: 'barra', available: true,
    groups: [{ id: 'extra', name: 'Agregados', min: 0, max: 2, options: [
      { id: 'gin', name: 'Jengibre', delta: 300 }, { id: 'menta', name: 'Menta', delta: 300 } ] }] },
  { id: 'p6', cat: 'food', emoji: '🍟', name: 'Papas fritas', desc: 'Porción para compartir.', ingredients: 'Papa, sal', price: 5200, prep: 12, point: 'comida', available: true,
    groups: [{ id: 'extra', name: 'Agregados', min: 0, max: 1, options: [{ id: 'ched', name: 'Cheddar y panceta', delta: 1800 }] }] },
  { id: 'p7', cat: 'food', emoji: '🍔', name: 'Hamburguesa clásica', desc: 'Carne, queso, lechuga y tomate.', ingredients: 'Pan, carne 150 g, queso, lechuga, tomate', price: 9800, prep: 15, point: 'comida', available: true,
    groups: [{ id: 'extra', name: 'Agregados', min: 0, max: 2, options: [
      { id: 'egg', name: 'Huevo', delta: 800 }, { id: 'bacon', name: 'Panceta', delta: 1200 } ] }] },
  { id: 'p8', cat: 'combo', emoji: '🎉', name: 'Combo 3', desc: 'Dos cervezas a elección y una porción de papas.', ingredients: '2 cervezas (pinta) + papas fritas',
    price: 12900, prep: 12, point: 'comida', available: true, groups: [BEERS('beer1', 'Cerveza 1'), BEERS('beer2', 'Cerveza 2')] },
];

/* Límites por pedido (configurables por local en el producto real): $100.000, 20 productos individuales u 8 combos.
   Un combo equivale a 20/8 = 2,5 productos, así que se pueden mezclar. */
const LIMITS = { maxTotal: 100000, maxIndividual: 20, maxCombos: 8 };
const fmtNum = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(n);
const isCombo = (p) => p.cat === 'combo';

const state = { view: 'menu', cat: 'beer', cart: [], origin: 'Mesa 5', sheet: null, order: null, pay: 'mp', theme: 0, paused: false };
let flowToken = 0;
let toastTimer = null;

const $ = (s) => document.querySelector(s);
const prod = (id) => PRODUCTS.find((p) => p.id === id);
const opt = (p, g, o) => p.groups.find((x) => x.id === g).options.find((x) => x.id === o);

function unitPrice(p, sel) {
  let t = p.price;
  for (const g of p.groups) for (const o of sel[g.id] || []) t += opt(p, g.id, o).delta;
  return t;
}
function selText(p, sel) {
  const out = [];
  for (const g of p.groups) {
    const names = (sel[g.id] || []).map((o) => opt(p, g.id, o).name);
    if (names.length) out.push(`${g.name}: ${names.join(', ')}`);
  }
  return out.join(' · ');
}
const cartCount = () => state.cart.reduce((a, l) => a + l.qty, 0);
function usage() {
  let individual = 0, combos = 0;
  for (const l of state.cart) { if (isCombo(prod(l.pid))) combos += l.qty; else individual += l.qty; }
  const equivalent = individual + combos * (LIMITS.maxIndividual / LIMITS.maxCombos);
  const total = cartTotal();
  return { individual, combos, equivalent, total, totalOk: total <= LIMITS.maxTotal, itemsOk: equivalent <= LIMITS.maxIndividual };
}
const limitsOk = () => { const u = usage(); return u.totalOk && u.itemsOk; };

/* Lista de requisitos al estilo de las contraseñas: cada línea muestra ✓ o ✕ y se actualiza al cambiar el carrito. */
function limitsBox() {
  const u = usage();
  const mix = [u.individual ? `${u.individual} producto${u.individual === 1 ? '' : 's'}` : '', u.combos ? `${u.combos} combo${u.combos === 1 ? '' : 's'}` : ''].filter(Boolean).join(' y ');
  const line = (ok, title, detail) => `<li class="${ok ? 'ok' : 'bad'}"><span class="mark" aria-hidden="true">${ok ? '✓' : '✕'}</span><span><strong>${title}</strong><small>${detail}</small></span><span class="sr-only">${ok ? 'Cumple' : 'No cumple'}</span></li>`;
  const msgs = [];
  if (!u.totalOk) msgs.push(`El total no puede superar ${fmt(LIMITS.maxTotal)}. El tuyo es ${fmt(u.total)}: quitá productos por ${fmt(u.total - LIMITS.maxTotal)} o más para continuar.`);
  if (!u.itemsOk) msgs.push(`Superás el máximo de ${LIMITS.maxIndividual} productos o ${LIMITS.maxCombos} combos por pedido (un combo equivale a ${fmtNum(LIMITS.maxIndividual / LIMITS.maxCombos)} productos). Llevás el equivalente a ${fmtNum(u.equivalent)}: quitá el equivalente a ${fmtNum(u.equivalent - LIMITS.maxIndividual)} o más.`);
  return `<section class="limits" aria-label="Límites del pedido">
    <h3>Límites del pedido</h3>
    <ul>
      ${line(u.totalOk, `Total hasta ${fmt(LIMITS.maxTotal)}`, `Tu total: ${fmt(u.total)}`)}
      ${line(u.itemsOk, `Hasta ${LIMITS.maxIndividual} productos o ${LIMITS.maxCombos} combos`, `Llevás ${mix || 'nada todavía'} (equivale a ${fmtNum(u.equivalent)})`)}
    </ul>
    ${msgs.length ? `<div class="notice error" role="alert">${msgs.map((m) => `<span>${m}</span>`).join('<br>')}</div>` : ''}
  </section>`;
}
const cartTotal = () => state.cart.reduce((a, l) => a + l.qty * unitPrice(prod(l.pid), l.sel), 0);
// Clave segura para usar dentro de atributos HTML (solo letras, números y separadores simples).
const lineKey = (pid, sel) => [pid, ...Object.keys(sel).sort().map((k) => `${k}-${[...sel[k]].sort().join('_')}`)].join('~');
const pointsInCart = () => [...new Set(state.cart.map((l) => prod(l.pid).point))];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* QR de demostración (patrón decorativo, NO escaneable) */
function fakeQr(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  const N = 25, cells = [];
  const finder = (x, y) => {
    for (const [ox, oy] of [[0, 0], [N - 7, 0], [0, N - 7]]) {
      if (x >= ox && x < ox + 7 && y >= oy && y < oy + 7) {
        const dx = x - ox, dy = y - oy;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? 1 : 0;
      }
      if (x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7) return 0;
    }
    return null;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = finder(x, y);
    if ((f === null ? rnd() > 0.52 : f === 1)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  }
  return `<svg viewBox="-1 -1 ${N + 2} ${N + 2}" role="img" aria-label="Código QR de retiro (demostración)" shape-rendering="crispEdges" fill="#1b1f3b"><rect x="-1" y="-1" width="${N + 2}" height="${N + 2}" fill="#fff"/>${cells.join('')}</svg>`;
}

/* ---------- Vistas ---------- */
function viewMenu() {
  const list = PRODUCTS.filter((p) => p.cat === state.cat);
  const ord = state.order;
  const banner = ord && !ord.finished
    ? `<button class="order-banner" data-a="go-tracking"><span><strong>Pedido ${ord.number}</strong> · ${statusLabel(ord)}</span><span aria-hidden="true">›</span></button>` : '';
  return `
  <header class="venue-head">
    <div class="venue-logo" aria-hidden="true">${VENUE.initial}</div>
    <div><h1>${VENUE.name}</h1><p>${VENUE.tagline}</p></div>
  </header>
  <div class="origin-chip">
    <div>${state.origin ? `📍 <strong>${state.origin}</strong>` : '📍 Sin ubicación'}
      <small>Solo para ubicarte. El pedido se retira en la barra.</small></div>
    <button class="link-btn" data-a="origin-open">Cambiar</button>
  </div>
  ${state.paused ? '<div class="notice error" style="margin:0 16px 8px">El local pausó los pedidos por el momento. Podés ver el menú, pero no pagar.</div>' : ''}
  ${banner}
  <nav class="tabs" aria-label="Categorías">
    ${CATS.map((c) => `<button class="tab" aria-pressed="${c.id === state.cat}" data-a="cat" data-v="${c.id}">${c.name}</button>`).join('')}
  </nav>
  <section class="list" aria-label="Productos">
    ${list.map((p) => `
      <article class="card ${p.available ? '' : 'off'}">
        <div class="thumb" aria-hidden="true">${p.emoji}</div>
        <div class="body">
          <h3>${p.name}</h3>
          <p>${p.desc}</p>
          <div class="meta"><span class="price">${fmt(p.price)}</span><span>⏱ ~${p.prep} min</span>${p.available ? '' : '<span>No disponible</span>'}</div>
        </div>
        <button class="add" aria-label="Agregar ${p.name}" data-a="open" data-v="${p.id}" ${p.available ? '' : 'disabled'}>+</button>
      </article>`).join('')}
  </section>
  <footer class="footer-brand"><img src="../../../../packages/ui/assets/logo-mark.svg" alt=""> Hecho con Pasamanos</footer>
  ${cartCount() ? `<button class="cartbar${limitsOk() ? '' : ' over'}" data-a="go-cart"><span>${limitsOk() ? '' : '⚠ '}Ver carrito (${cartCount()})</span><span>${fmt(cartTotal())}</span></button>` : ''}`;
}

function viewCart() {
  const pts = pointsInCart();
  const items = state.cart.map((l) => {
    const p = prod(l.pid);
    return `<div class="line">
      <div class="info"><strong>${p.name}</strong><small>${selText(p, l.sel) || '&nbsp;'}</small>
        <small>${fmt(unitPrice(p, l.sel))} c/u${pts.length > 1 ? ` · retiro: ${POINTS[p.point]}` : ''}</small></div>
      <div class="qty" role="group" aria-label="Cantidad de ${p.name}">
        <button data-a="dec" data-k="${l.key}" aria-label="Quitar uno">−</button><span>${l.qty}</span>
        <button data-a="inc" data-k="${l.key}" aria-label="Agregar uno">+</button></div>
      <button class="link-btn" data-a="del" data-k="${l.key}" aria-label="Eliminar ${p.name}">🗑</button>
    </div>`;
  }).join('');
  const pickupMsg = pts.length > 1
    ? `Tu pedido se retira en <strong>${pts.length} puntos</strong>: ${pts.map((x) => POINTS[x]).join(' y ')}. Te avisamos cuando cada parte esté lista.`
    : `Retirás en: <strong>${POINTS[pts[0]] || '—'}</strong>.`;
  return `
  <div class="topbar"><button class="back" data-a="go-menu" aria-label="Volver al menú">←</button><h2>Tu pedido</h2></div>
  <div class="pad">
    ${state.cart.length ? `
      ${items}
      <div class="notice pickup" style="margin-top:16px">🛍️ <span>${pickupMsg}</span></div>
      ${state.origin ? `<p class="muted">Origen del pedido: ${state.origin} (solo informativo)</p>` : ''}
      ${limitsBox()}
      <div class="totals">
        <div><span>Subtotal</span><span>${fmt(cartTotal())}</span></div>
        <div class="grand"><span>Total</span><span>${fmt(cartTotal())}</span></div>
      </div>
      <p></p>
      <button class="btn" data-a="go-pay" ${state.paused || !limitsOk() ? 'disabled' : ''}>${state.paused ? 'Pedidos pausados' : !limitsOk() ? 'Revisá los límites del pedido' : 'Continuar al pago'}</button>`
      : `<div class="center" style="padding:48px 0"><p>Tu carrito está vacío.</p><button class="btn secondary" data-a="go-menu">Ver el menú</button></div>`}
  </div>`;
}

function viewPay() {
  return `
  <div class="topbar"><button class="back" data-a="go-cart" aria-label="Volver al carrito">←</button><h2>Pago</h2></div>
  <div class="pad">
    <p class="section-title">Medio de pago</p>
    <div role="radiogroup" aria-label="Medio de pago">
      <button class="radio" role="radio" aria-checked="${state.pay === 'mp'}" data-a="pay-method" data-v="mp"><span class="dot"></span><span class="grow"><strong>Mercado Pago</strong><small>Dinero en cuenta, tarjetas guardadas</small></span></button>
      <button class="radio" role="radio" aria-checked="${state.pay === 'card'}" data-a="pay-method" data-v="card"><span class="dot"></span><span class="grow"><strong>Tarjeta de crédito o débito</strong><small>Pago seguro con Mercado Pago</small></span></button>
    </div>
    <div class="totals"><div class="grand"><span>Total a pagar</span><span>${fmt(cartTotal())}</span></div></div>
    <p class="muted">Si el local no puede preparar tu pedido, te reembolsamos el importe.</p>
    <button class="btn" data-a="pay-go" ${state.paused ? 'disabled' : ''}>Pagar ${fmt(cartTotal())}</button>
  </div>`;
}

function viewPaying() {
  return `<div class="center pad"><div class="spinner" role="progressbar" aria-label="Procesando el pago"></div><h2>Procesando el pago…</h2><p class="muted">No cierres esta pantalla.</p></div>`;
}

const STEPS = ['Pago aprobado', 'Esperando al local', 'Pedido aceptado', 'En preparación', 'Listo para retirar', 'Entregado'];
const statusLabel = (o) => (o.rejected ? 'Rechazado' : STEPS[o.status]);

function viewTracking() {
  const o = state.order;
  if (!o) return viewMenu();
  let hero;
  if (o.rejected) {
    hero = `<div class="status-hero"><div style="font-size:48px">😕</div><h2>No pudimos preparar tu pedido</h2><p>${o.number}</p></div>
      <div class="pad"><div class="notice error">El local rechazó el pedido: <strong>${o.rejectReason || 'Producto sin disponibilidad'}</strong>.</div>
      <div class="notice ok" style="margin-top:8px">Iniciamos el reembolso de ${fmt(o.total)}. Te avisamos cuando se acredite.</div>
      <p></p><button class="btn" data-a="new-order">Volver al menú</button></div>`;
    return `<div class="topbar"><button class="back" data-a="go-menu" aria-label="Volver al menú">←</button><h2>Seguimiento</h2></div>${hero}`;
  }
  const ready = o.status === 4, done = o.status === 5;
  const emoji = ['✅', '⏳', '👍', '👨‍🍳', '🛍️', '🎉'][o.status];
  const msg = ['Recibimos tu pago.', 'Enviamos tu pedido al local.', `Tiempo estimado: ~${o.eta} min`, `Tiempo estimado: ~${o.eta} min`,
    'Retiralo en la barra con este código.', '¡Que lo disfrutes!'][o.status];
  const cards = ready ? o.parts.map((pt) => pt.status === 'delivered' ? `<div class="pickup-card"><p class="where">${POINTS[pt.point] || ''}</p><p class="muted">✓ Esta parte ya fue entregada</p></div>` : `
    <div class="pickup-card"><p class="muted">Retirá en</p><p class="where">${POINTS[pt.point]}</p>
      ${fakeQr(o.number + pt.code)}<p class="code" aria-label="Código ${pt.code.split('').join(' ')}">${pt.code}</p>
      <p class="muted">Mostrá el QR o decí el código al retirar. Se usa una sola vez.</p></div>`).join('') : '';
  return `
  <div class="topbar"><button class="back" data-a="go-menu" aria-label="Volver al menú">←</button><h2>Pedido ${o.number}</h2></div>
  <div class="status-hero"><div style="font-size:48px" aria-hidden="true">${emoji}</div><h2>${STEPS[o.status]}</h2><p>${msg}</p></div>
  <div class="pad">
    ${ready && o.parts.length > 1 ? '<div class="notice pickup">Tu pedido se retira en varios puntos. Cada parte tiene su propio QR.</div><p></p>' : ''}
    ${cards}
    ${done ? '<button class="btn" data-a="new-order">Hacer otro pedido</button>' : `
    <ol class="steps" aria-label="Estado del pedido">
      ${STEPS.map((s, i) => `<li class="${i < o.status ? 'done' : i === o.status ? 'current' : ''}" ${i === o.status ? 'aria-current="step"' : ''}><span class="bullet">${i < o.status ? '✓' : ''}</span>${s}</li>`).join('')}
    </ol>
    <button class="btn secondary" data-a="go-menu">Pedir algo más</button>
    <p class="muted center">¿Querés sumar otra bebida? Hacé un pedido nuevo sin levantarte.</p>`}
  </div>`;
}

function renderSheet() {
  const s = state.sheet, el = $('#sheet');
  if (!s) { el.innerHTML = ''; return; }
  if (s.kind === 'origin') {
    el.innerHTML = `<div class="backdrop" data-a="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="¿Desde dónde pedís?">
        <h2>¿Desde dónde pedís?</h2><p class="desc">Es solo para que el local sepa de dónde viene el pedido. Siempre se retira en la barra.</p>
        ${ORIGINS.map((x) => `<button class="radio" role="radio" aria-checked="${state.origin === x}" data-a="origin-set" data-v="${x}"><span class="dot"></span><span class="grow">${x}</span></button>`).join('')}
        <button class="radio" role="radio" aria-checked="${state.origin === null}" data-a="origin-set" data-v=""><span class="dot"></span><span class="grow">Estoy afuera / prefiero no indicar</span></button>
      </div>`;
    return;
  }
  const p = prod(s.pid);
  const sel = s.sel;
  const valid = p.groups.every((g) => (sel[g.id] || []).length >= g.min);
  const unit = unitPrice(p, sel);
  el.innerHTML = `<div class="backdrop" data-a="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${p.name}">
      <h2>${p.name}</h2><p class="desc">${p.desc}</p>
      <p class="meta"><span>⏱ ~${p.prep} min</span><span>Contiene: ${p.ingredients}</span><span>Retiro: ${POINTS[p.point]}</span></p>
      ${p.groups.map((g) => `<div class="group"><div class="group-head"><strong>${g.name}</strong>
        <span class="tag ${g.min ? 'req' : ''}">${g.min ? 'Obligatorio' : `Opcional${g.max > 1 ? ' · hasta ' + g.max : ''}`}</span></div>
        ${g.options.map((o) => { const on = (sel[g.id] || []).includes(o.id);
          return `<button class="radio" role="${g.max === 1 ? 'radio' : 'checkbox'}" aria-checked="${on}" data-a="opt" data-g="${g.id}" data-o="${o.id}">
            <span class="dot"></span><span class="grow">${o.name}</span>${o.delta ? `<span>+${fmt(o.delta)}</span>` : ''}</button>`; }).join('')}</div>`).join('')}
      <div class="sheet-foot">
        <div class="qty" role="group" aria-label="Cantidad"><button data-a="sheet-dec" aria-label="Quitar uno">−</button><span>${s.qty}</span><button data-a="sheet-inc" aria-label="Agregar uno">+</button></div>
        <button class="btn" data-a="sheet-add" ${valid ? '' : 'disabled'}>${valid ? `Agregar · ${fmt(unit * s.qty)}` : 'Elegí las opciones'}</button>
      </div>
    </div>`;
}

function render() {
  const v = state.view;
  $('#app').innerHTML = v === 'menu' ? viewMenu() : v === 'cart' ? viewCart() : v === 'pay' ? viewPay() : v === 'paying' ? viewPaying() : viewTracking();
  renderSheet();
}

/* ---------- Lógica ---------- */
function addToCart(pid, sel, qty) {
  const key = lineKey(pid, sel);
  const ex = state.cart.find((l) => l.key === key);
  if (ex) ex.qty += qty; else state.cart.push({ key, pid, sel, qty });
}

function createOrder() {
  const byPoint = {};
  state.cart.forEach((l) => { (byPoint[prod(l.pid).point] ||= []).push(l); });
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const maxPrep = Math.max(...state.cart.map((l) => prod(l.pid).prep));
  state.order = {
    number: Store.nextNumber(), status: 0, rejected: false, rejectReason: null, finished: false,
    total: cartTotal(), eta: maxPrep + 3, origin: state.origin, createdAt: Date.now(),
    parts: Object.entries(byPoint).map(([point, lines]) => ({
      point, code: code(), status: 'preparing',
      items: lines.map((l) => ({ name: prod(l.pid).name, qty: l.qty, detail: selText(prod(l.pid), l.sel) })),
    })),
  };
  state.cart = [];
  publish();
}

/* ---------- Sincronización con el panel (demo) ---------- */
function publish() { if (state.order) Store.upsertOrder(state.order); }
function syncParts(o) {
  const st = o.status >= 5 ? 'delivered' : o.status >= 4 ? 'ready' : 'preparing';
  o.parts.forEach((pt) => { pt.status = st; });
}
function applyShared(d) {
  if (Array.isArray(d.unavailable)) PRODUCTS.forEach((p) => { p.available = !d.unavailable.includes(p.id); });
  state.paused = !!d.paused;
}
Store.onChange((d) => {
  applyShared(d);
  if (state.order) {
    const rec = d.orders.find((o) => o.number === state.order.number);
    if (rec) { state.order = { ...state.order, ...rec }; state.order.finished = state.order.rejected || state.order.status >= 5; }
  }
  render();
});

function startPayment() {
  if (state.paused || !limitsOk()) return;   // el servidor vuelve a validar los límites: esto es solo la ayuda en pantalla
  const token = ++flowToken;
  state.view = 'paying';
  render();
  setTimeout(() => {
    if (token !== flowToken) return;
    createOrder();
    state.view = 'tracking';
    render();
    setTimeout(() => {
      if (token === flowToken && state.order && state.order.status === 0 && !state.order.rejected) { state.order.status = 1; publish(); if (state.view === 'tracking') render(); }
    }, 1500);
  }, 1400);
}

function resetAll() {
  flowToken++;
  Store.reset();
  Object.assign(state, { view: 'menu', cat: 'beer', cart: [], sheet: null, order: null, origin: 'Mesa 5', pay: 'mp' });
  render();
}

const actions = {
  cat: (d) => { state.cat = d.v; },
  open: (d) => {
    const p = prod(d.v);
    if (!p.groups.length) { addToCart(p.id, {}, 1); toast(limitsOk() ? `${p.name} agregado` : 'Tu pedido supera el límite: revisalo en el carrito'); } else state.sheet = { kind: 'product', pid: p.id, sel: {}, qty: 1 };
  },
  opt: (d) => {
    const s = state.sheet, p = prod(s.pid), g = p.groups.find((x) => x.id === d.g);
    const cur = s.sel[g.id] || [];
    if (g.max === 1) s.sel[g.id] = cur.includes(d.o) && g.min === 0 ? [] : [d.o];
    else if (cur.includes(d.o)) s.sel[g.id] = cur.filter((x) => x !== d.o);
    else if (cur.length < g.max) s.sel[g.id] = [...cur, d.o];
    else toast(`Podés elegir hasta ${g.max}`);
  },
  'sheet-inc': () => { state.sheet.qty = Math.min(20, state.sheet.qty + 1); },
  'sheet-dec': () => { state.sheet.qty = Math.max(1, state.sheet.qty - 1); },
  'sheet-add': () => { const s = state.sheet; addToCart(s.pid, s.sel, s.qty); toast(limitsOk() ? `${prod(s.pid).name} agregado` : 'Tu pedido supera el límite: revisalo en el carrito'); state.sheet = null; },
  'close-sheet': () => { state.sheet = null; },
  'origin-open': () => { state.sheet = { kind: 'origin' }; },
  'origin-set': (d) => { state.origin = d.v || null; state.sheet = null; },
  'go-menu': () => { state.view = 'menu'; },
  'go-cart': () => { state.view = 'cart'; },
  'go-pay': () => { if (limitsOk() && !state.paused) state.view = 'pay'; },
  'go-tracking': () => { state.view = 'tracking'; },
  inc: (d) => { state.cart.find((l) => l.key === d.k).qty++; },
  dec: (d) => { const l = state.cart.find((x) => x.key === d.k); if (l.qty > 1) l.qty--; },
  del: (d) => { state.cart = state.cart.filter((l) => l.key !== d.k); },
  'pay-method': (d) => { state.pay = d.v; },
  'pay-go': () => startPayment(),
  'new-order': () => { state.order = null; state.view = 'menu'; },
  'demo-next': () => {
    const o = state.order;
    if (!o || o.rejected || o.status >= 5) { toast('Primero hacé un pedido'); return; }
    o.status++; if (o.status === 5) o.finished = true; syncParts(o); publish(); state.view = 'tracking';
  },
  'demo-reject': () => {
    const o = state.order;
    if (!o || o.finished) { toast('Primero hacé un pedido'); return; }
    o.rejected = true; o.rejectReason = 'Producto sin disponibilidad'; o.finished = true; publish(); state.view = 'tracking';
  },
  'demo-theme': () => {
    state.theme = (state.theme + 1) % THEMES.length;
    const t = THEMES[state.theme], r = document.documentElement.style;
    r.setProperty('--brand', t.a); r.setProperty('--brand-2', t.b);
  },
  'demo-reset': () => resetAll(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const fn = actions[el.dataset.a];
  if (!fn) return;
  fn(el.dataset);
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheet) { state.sheet = null; render(); }
});

applyShared(Store.read());
render();
