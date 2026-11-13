# App del cliente: pantallas y flujos

Prototipo navegable: `docs/ux/prototype/customer-app/index.html` (abrir en el navegador; usar vista móvil). Los pagos, el QR y las respuestas del local están simulados. Los botones oscuros del encabezado permiten avanzar el estado, simular un rechazo y cambiar el color del local.

## Mapa de pantallas

1. **Entrada** (QR de local o sector, enlace o búsqueda) → **Menú del local**.
2. **Menú:** cabecera del local, chip de origen, banner de pedido en curso, categorías, productos, barra de carrito.
3. **Producto** (hoja inferior): opciones, variantes, combos, cantidad.
4. **Origen** (hoja inferior): sector del cliente o "estoy afuera".
5. **Carrito:** líneas, cantidades, puntos de retiro, total.
6. **Pago:** medios habilitados por el local, confirmación del importe.
7. **Procesando pago.**
8. **Seguimiento:** estado, tiempo estimado, pasos.
9. **Retiro:** una tarjeta por punto con QR, código corto y nombre del punto.
10. **Rechazo y reembolso.**
11. **Historial** y **cuenta** (registro, inicio de sesión): documentados en wireframe, no incluidos en el prototipo.

## Flujos

**A. Pedido anticipado:** entrada por búsqueda o enlace → origen "afuera" → menú → carrito → pago → seguimiento → retiro.

**B. Pedido desde el local:** QR de sector (origen precargado) → menú → carrito → pago → seguimiento. Mientras tiene un pedido en curso, un banner en el menú permite volver al seguimiento y pedir algo más sin perder el estado.

**C. Retiro:** al pasar a "Listo", la pantalla muestra el punto de retiro asignado y el QR con código corto. Si el pedido se divide (modo por ítem), hay una tarjeta por parte.

**D. Rechazo:** se muestra el motivo y el reembolso iniciado.

## Reglas de diseño específicas

- El origen siempre aclara que es solo informativo. No existe ninguna promesa de entrega en mesa.
- El punto de retiro se muestra desde el carrito cuando el local usa modo por ítem. En modo punto único, el punto lo asigna el empleado al marcar el pedido como listo, y el cliente lo ve en ese momento.
- Las opciones obligatorias bloquean el botón de agregar y lo explican ("Elegí las opciones").
- Los productos no disponibles se muestran atenuados y no se pueden agregar.

## Estados a cubrir en la implementación

Sin conexión (menú en caché, aviso claro, QR de pedidos ya pagados disponible sin red), local cerrado o con pedidos pausados, producto que dejó de estar disponible entre el carrito y el pago, pago rechazado o cancelado, pago pendiente, sesión vencida.

## Pendiente del prototipo

Historial, registro e inicio de sesión, selección de local por búsqueda, notificaciones in-app y pantalla de local cerrado.
