# Panel del local: pantallas y flujos (wireframes en texto)

Diseñado para tablet horizontal en barra o cocina, y utilizable en escritorio y teléfono. Identidad de Pasamanos.

## 1. Mapa de pantallas

1. **Pedidos** (pantalla principal): cola en tiempo real.
2. **Detalle de pedido** (panel lateral).
3. **Escáner de entrega.**
4. **Disponibilidad rápida.**
5. **Catálogo:** categorías, productos, variantes, combos, precios.
6. **Sectores y QR.**
7. **Puntos de retiro.**
8. **Configuración:** horarios, capacidad y pausas, aceptación, medios de pago, cuenta de Mercado Pago.
9. **Equipo:** empleados y roles.
10. **Estadísticas** (después del MVP).

La navegación se limita según el rol (el operador de entrega ve solo Pedidos y Escáner).

## 2. Pantalla de pedidos

```
┌───────────────────────────────────────────────────────────────┐
│ Pasamanos · El Faro      [Pausar pedidos]   🔔 sonido: ON  ⚙  │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│ NUEVOS (3)   │ EN PREPARAC. │ LISTOS (2)   │ Detalle          │
│ #043 Mesa 5  │ #041 Barra   │ #039 VIP     │ #043 · hace 1min │
│  2 ítems 1m  │  4 ítems     │  Barra 1     │ Pago: aprobado   │
│ [Aceptar]    │ [Marcar      │ [Escanear]   │ Origen: Mesa 5   │
│ [Rechazar]   │  listo]      │              │ Ítems y opciones │
└──────────────┴──────────────┴──────────────┴──────────────────┘
```

- Columnas por estado, ordenadas por hora de recepción. Alerta sonora y visual al llegar un pedido nuevo.
- **Aceptar:** pide el tiempo estimado (propuesto desde el mayor tiempo de preparación de los ítems), editable.
- **Rechazar:** motivo obligatorio de la lista predefinida y aviso de que el reembolso se inicia automáticamente.
- **Marcar listo:** en modo punto único con varios puntos, pide elegir el punto de retiro (decisión D1). En modo por ítem, cada parte se marca por separado.
- Cuenta regresiva visible del plazo de aceptación.
- Filtros por punto de retiro y por origen (informativo).

## 3. Escáner de entrega

Cámara siempre lista, con entrada manual del código corto como alternativa. Al leer: se muestra el pedido (número, ítems, origen) y el operador confirma. Resultados claros: **entregado**, **ya utilizado** (con hora y empleado), **no corresponde a este local** o **inválido**. Si el local activó verificación de DNI, se muestra el recordatorio antes de confirmar.

## 4. Disponibilidad rápida

Lista de productos con interruptor de disponible o agotado, y pausa por categoría. Accesible desde cualquier pantalla en dos toques, porque es la herramienta principal para evitar rechazos.

## 5. Configuración clave

- **Capacidad:** pedidos simultáneos, por intervalo, pausa general y pausa por categoría (MVP 2 para los límites por intervalo).
- **Retiro:** modo punto único o por ítem, y los puntos con su asignación.
- **Aceptación:** manual o automática, y el plazo antes de cancelar.
- **Pagos:** conectar Mercado Pago (OAuth) y medios habilitados.
- **Marca:** logo y color, con verificación de contraste.

## 6. Pendiente

Prototipo visual del panel, alta guiada de un local nuevo (onboarding) y diseño del panel del super admin.
