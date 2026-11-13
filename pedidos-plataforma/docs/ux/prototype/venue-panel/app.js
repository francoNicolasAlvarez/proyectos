'use strict';
/* Prototipo navegable del panel del local (Pasamanos). Datos compartidos con el prototipo del cliente. */

const POINTS = { barra: 'Barra 1', comida: 'Punto de comida' };
const REASONS = ['Producto sin disponibilidad', 'Falta de ingredientes', 'Capacidad operativa excedida', 'Establecimiento temporalmente cerrado', 'Problemas técnicos', 'Otro motivo'];
const CATALOG = [
  { id: 'p1', name: 'Rubia Lager' }, { id: 'p2', name: 'IPA de la casa' }, { id: 'p3', name: 'Daikiri' }, { id: 'p4', name: 'Gin tonic' },
  { id: 'p5', name: 'Limonada' }, { id: 'p6', name: 'Papas fritas' }, { id: 'p7', name: 'Hamburguesa clásica' }, { id: 'p8', name: 'Combo 3' },
];
const DEFAULT_UNAVAILABLE = ['p4'];
const ACCEPT_SECONDS = 300;
const ORIGINS = ['Mesa 5', 'Barra principal', 'Sector VIP', 'Patio exterior', null];

const $ = (s) => document.querySelector(s);
const ui = { modal: null, scan: { code: '', result: null, found: null } };
let data = Store.read();

const unavailable = () => (Array.isArray(data.unavailable) ? data.unavailable : DEFAULT_UNAVAILABLE);
const ago = (ts) => { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? 'hace instantes' : `hace ${m} min`; };
const mmss = (s) => `${String(Math.floor(Math.abs(s) / 60)).padStart(2, '0')}:${String(Math.abs(s) % 60).padStart(2, '0')}`;
const pointName = (p) => (p ? POINTS[p] : 'Sin asignar');

function save(fn) { data = Store.update(fn); render(); }
function order(n) { return data.orders.find((o) => o.number === n); }

/* ---------- Tablero ---------- */
function orderCard(o) {
  const items = o.parts.flatMap((p) => p.items);
  const pts = o.parts.map((p) => pointName(p.point)).join(' · ');
  let actions = '';
  let extra = '';
  if (o.status === 1) {
    const left = ACCEPT_SECONDS - Math.floor((Date.now() - o.createdAt) / 1000);
    extra = `<p class="meta">Responder en <span class="countdown ${left < 0 ? 'late' : ''}" data-deadline="${o.createdAt + ACCEPT_SECONDS * 1000}">${left < 0 ? '-' : ''}${mmss(left)}</span></p>`;
    actions = `<div class="btns"><button class="btn" data-a="accept" data-n="${o.number}">Aceptar</button><button class="btn danger" data-a="reject" data-n="${o.number}">Rechazar</button></div>`;
  } else if (o.status === 2) {
    actions = `<div class="btns"><button class="btn" data-a="prepare" data-n="${o.number}">Empezar a preparar</button></div>`;
  } else if (o.status === 3) {
    actions = o.parts.map((p, i) => `<div class="row"><span>${pointName(p.point)}</span>${p.status === 'preparing'
      ? `<button class="btn small" data-a="ready" data-n="${o.number}" data-i="${i}">Marcar listo</button>` : '<span class="tag ok">Listo ✓</span>'}</div>`).join('');
  } else if (o.status === 4) {
    actions = o.parts.map((p) => `<div class="row"><span>${pointName(p.point)}</span><span class="tag ${p.status === 'delivered' ? 'ok' : 'warn'}">${p.status === 'delivered' ? 'Entregado ✓' : 'Esperando retiro'}</span></div>`).join('')
      + `<div class="btns"><button class="btn sec" data-a="scan">Escanear entrega</button></div>`;
  }
  return `<article class="ocard ${o.status === 1 ? 'new' : ''}" data-n="${o.number}">
    <header><strong>${o.number}</strong><span class="tag">${o.origin ? 'Origen: ' + o.origin : 'Sin origen'}</span></header>
    <p class="meta">${ago(o.createdAt)} · <span class="tag ok">Pago aprobado</span> · ~${o.eta} min</p>
    <ul>${items.map((it) => `<li>${it.qty}× ${it.name}${it.detail ? `<small>${it.detail}</small>` : ''}</li>`).join('')}</ul>
    <p class="meta">Retiro: ${pts}</p>${extra}${actions}</article>`;
}

function render() {
  const vis = data.orders.filter((o) => o.status >= 1 && !o.rejected);
  const cols = [
    ['Nuevos', vis.filter((o) => o.status === 1)],
    ['En preparación', vis.filter((o) => o.status === 2 || o.status === 3)],
    ['Listos para retirar', vis.filter((o) => o.status === 4)],
  ];
  $('#board').innerHTML = cols.map(([name, list]) => `<section class="col" aria-label="${name}">
    <h2>${name} <span class="count">${list.length}</span></h2>
    ${list.length ? list.sort((a, b) => a.createdAt - b.createdAt).map(orderCard).join('') : '<p class="empty">Sin pedidos</p>'}</section>`).join('');
  const done = data.orders.filter((o) => o.status === 5).length, rej = data.orders.filter((o) => o.rejected).length;
  $('#summary').textContent = `Entregados: ${done} · Rechazados: ${rej}`;
  const pb = $('#pause-btn');
  pb.textContent = data.paused ? 'Reanudar pedidos' : 'Pausar pedidos';
  pb.setAttribute('aria-pressed', String(!!data.paused));
  $('#paused-banner').hidden = !data.paused;
  renderModal();
}

/* ---------- Diálogos ---------- */
function dialog(title, body) {
  return `<div class="backdrop" data-a="close"></div><div class="dialog" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2>${body}</div>`;
}
function renderModal() {
  const m = ui.modal, el = $('#modal');
  if (!m) { el.innerHTML = ''; return; }
  if (m.kind === 'accept') {
    const o = order(m.n);
    el.innerHTML = dialog(`Aceptar ${m.n}`, `<label class="field">Tiempo estimado (minutos)<input id="eta" type="number" min="1" max="120" value="${o.eta}"></label>
      <div class="btns"><button class="btn sec" data-a="close">Cancelar</button><button class="btn" data-a="accept-ok" data-n="${m.n}">Aceptar pedido</button></div>`);
  } else if (m.kind === 'reject') {
    el.innerHTML = dialog(`Rechazar ${m.n}`, `<p class="meta">El cliente recibe el motivo y se inicia el reembolso automáticamente.</p>
      <div role="radiogroup" aria-label="Motivo">${REASONS.map((r) => `<button class="radio" role="radio" aria-checked="${m.reason === r}" data-a="reason" data-v="${r}">${r}</button>`).join('')}</div>
      <div class="btns"><button class="btn sec" data-a="close">Volver</button><button class="btn danger" data-a="reject-ok" data-n="${m.n}" ${m.reason ? '' : 'disabled'}>Rechazar y reembolsar</button></div>`);
  } else if (m.kind === 'assign') {
    el.innerHTML = dialog(`¿Dónde retira el ${m.n}?`, `<p class="meta">Elegí el punto de retiro. El cliente recibe el aviso con el punto indicado.</p>
      <div role="radiogroup" aria-label="Punto de retiro">${Object.entries(POINTS).map(([k, v]) => `<button class="radio" role="radio" aria-checked="${m.point === k}" data-a="point" data-v="${k}">${v}</button>`).join('')}</div>
      <div class="btns"><button class="btn sec" data-a="close">Cancelar</button><button class="btn" data-a="assign-ok" ${m.point ? '' : 'disabled'}>Marcar listo</button></div>`);
  } else if (m.kind === 'avail') {
    el.innerHTML = dialog('Disponibilidad', CATALOG.map((p) => { const on = !unavailable().includes(p.id);
      return `<button class="switch" role="switch" aria-checked="${on}" aria-label="${p.name}" data-a="toggle" data-v="${p.id}"><span>${p.name}</span><span class="st">${on ? 'Disponible' : 'Agotado'}</span></button>`; }).join('')
      + '<div class="btns"><button class="btn sec" data-a="close">Cerrar</button></div>');
  } else if (m.kind === 'scan') {
    const s = ui.scan;
    let res = '';
    if (s.result === 'invalid') res = '<div class="result err" role="alert">Código inválido. Revisá e intentá de nuevo.</div>';
    if (s.result === 'used') res = `<div class="result err" role="alert">Ya utilizado: se entregó a las ${s.when}.</div>`;
    if (s.result === 'notready') res = '<div class="result err" role="alert">Este pedido todavía no está listo para retirar.</div>';
    if (s.result === 'done') res = '<div class="result ok" role="status">Entrega confirmada ✓</div>';
    if (s.result === 'found') {
      const o = order(s.found.n), p = o.parts[s.found.i];
      res = `<div class="result info"><strong>${o.number}</strong> · ${pointName(p.point)}<br>${p.items.map((it) => `${it.qty}× ${it.name}`).join(', ')}</div>
        <div class="btns"><button class="btn" data-a="confirm-delivery">Confirmar entrega</button></div>`;
    }
    el.innerHTML = dialog('Escanear entrega', `<p class="meta">Apuntá la cámara al QR del cliente o ingresá el código de 4 caracteres.</p>
      <label class="field">Código<input id="code" class="code-in" maxlength="4" autocomplete="off" value="${s.code}"></label>
      <div class="btns"><button class="btn sec" data-a="close">Cerrar</button><button class="btn" data-a="validate">Validar</button></div>${res}`);
    const inp = $('#code'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
}

/* ---------- Escáner ---------- */
function findPart(code) {
  for (const o of data.orders) for (let i = 0; i < o.parts.length; i++) if (o.parts[i].code === code && !o.rejected) return { n: o.number, i };
  return null;
}
function validate(code) {
  const s = ui.scan; s.code = code; s.found = null;
  const f = findPart(code);
  if (!f) { s.result = 'invalid'; return; }
  const p = order(f.n).parts[f.i];
  if (p.status === 'delivered') { s.result = 'used'; s.when = new Date(p.deliveredAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); return; }
  if (p.status !== 'ready') { s.result = 'notready'; return; }
  s.result = 'found'; s.found = f;
}

/* ---------- Acciones ---------- */
function markReady(n, i, point) {
  save((d) => {
    const o = d.orders.find((x) => x.number === n), p = o.parts[i];
    if (point) p.point = point;
    p.status = 'ready';
    if (o.parts.every((x) => x.status !== 'preparing')) o.status = 4;
  });
}
const actions = {
  close: () => { ui.modal = null; },
  accept: (d) => { ui.modal = { kind: 'accept', n: d.n }; },
  'accept-ok': (d) => { const eta = Math.max(1, parseInt($('#eta').value, 10) || 1); ui.modal = null; save((s) => { const o = s.orders.find((x) => x.number === d.n); o.status = 2; o.eta = eta; o.acceptedAt = Date.now(); }); },
  reject: (d) => { ui.modal = { kind: 'reject', n: d.n, reason: null }; },
  reason: (d) => { ui.modal.reason = d.v; },
  'reject-ok': (d) => { const reason = ui.modal.reason; ui.modal = null; save((s) => { const o = s.orders.find((x) => x.number === d.n); o.rejected = true; o.rejectReason = reason; o.finished = true; }); },
  prepare: (d) => { save((s) => { s.orders.find((x) => x.number === d.n).status = 3; }); },
  ready: (d) => {
    const p = order(d.n).parts[+d.i];
    if (!p.point) ui.modal = { kind: 'assign', n: d.n, i: +d.i, point: null }; else markReady(d.n, +d.i);
  },
  point: (d) => { ui.modal.point = d.v; },
  'assign-ok': () => { const m = ui.modal; ui.modal = null; markReady(m.n, m.i, m.point); },
  avail: () => { ui.modal = { kind: 'avail' }; },
  toggle: (d) => { const cur = unavailable(); save((s) => { s.unavailable = cur.includes(d.v) ? cur.filter((x) => x !== d.v) : [...cur, d.v]; }); },
  pause: () => { save((s) => { s.paused = !s.paused; }); },
  scan: () => { ui.scan = { code: '', result: null, found: null }; ui.modal = { kind: 'scan' }; },
  validate: () => { validate($('#code').value.trim().toUpperCase()); },
  'confirm-delivery': () => {
    const f = ui.scan.found;
    save((s) => {
      const o = s.orders.find((x) => x.number === f.n), p = o.parts[f.i];
      p.status = 'delivered'; p.deliveredAt = Date.now(); p.deliveredBy = 'Operador de entrega';
      if (o.parts.every((x) => x.status === 'delivered')) { o.status = 5; o.finished = true; o.deliveredAt = Date.now(); }
    });
    ui.scan = { code: '', result: 'done', found: null };
  },
  'demo-order': () => {
    const n = Store.nextNumber();
    const pool = [{ qty: 2, name: 'IPA de la casa', detail: 'Tamaño: Pinta (473 ml)' }, { qty: 1, name: 'Hamburguesa clásica', detail: 'Agregados: Huevo' }, { qty: 1, name: 'Papas fritas', detail: '' }];
    const items = pool.slice(0, 1 + (parseInt(n.slice(1), 10) % 3));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    save((s) => s.orders.push({ number: n, status: 1, rejected: false, rejectReason: null, finished: false, total: 9000, eta: 10, createdAt: Date.now(),
      origin: ORIGINS[parseInt(n.slice(1), 10) % ORIGINS.length], parts: [{ point: null, code: code(), status: 'preparing', items }] }));
  },
  'demo-reset': () => { Store.reset(); data = Store.read(); ui.modal = null; },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || !actions[el.dataset.a]) return;
  actions[el.dataset.a](el.dataset);
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.modal) { ui.modal = null; render(); }
  if (e.key === 'Enter' && ui.modal && ui.modal.kind === 'scan' && e.target.id === 'code') { actions.validate(); render(); }
});
Store.onChange((d) => { data = d; render(); });

/* Los contadores se actualizan sin redibujar el tablero. */
setInterval(() => {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const left = Math.round((+el.dataset.deadline - Date.now()) / 1000);
    el.textContent = (left < 0 ? '-' : '') + mmss(left);
    el.classList.toggle('late', left < 0);
  });
}, 1000);

render();
