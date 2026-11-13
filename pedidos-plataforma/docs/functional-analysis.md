# Análisis funcional (Etapa 1)

Plataforma web responsive y PWA para pedir y pagar comida y bebida desde el celular en locales gastronómicos, bares, pubs y eventos. La única instancia presencial es el retiro.

## 1. Alcance excluido (permanente)

No hay reservas, asignación de mesas, gestión de ocupación ni turnos. La ubicación (mesa, sector, barra) **solo identifica el origen del pedido**. No existe entrega en el lugar del cliente: **siempre se retira en un punto de retiro** (barra o mostrador).

## 2. Decisiones cerradas

| Tema | Decisión |
|---|---|
| Entrega | Siempre en punto de retiro. La ubicación es metadato de origen. |
| Puntos de retiro | Configurables por local. Modalidad por local: `single_point` (un punto por pedido) o `per_item` (cada ítem o categoría tiene su punto; el pedido se divide en partes con estado propio). Se define al configurar, no al pedir. |
| Medios de pago | Los habilita cada local: tarjeta asociada o app de pagos (se cobra al pedir); efectivo o tarjeta física (se cobra al retirar). |
| Efectivo | No se registra vuelto, solo método y monto cobrado. |
| Cobro de la plataforma | Suscripción fija por local. Los pagos electrónicos van directo a la cuenta de Mercado Pago del local (OAuth). Comisión por transacción en una fase posterior. |
| Punto de retiro con varios puntos que sirven todo el menú (`single_point`) | Lo asigna el empleado al marcar el pedido como listo. |
| Pago al retiro | MVP 2 (el esquema ya lo soporta). MVP 1 es solo prepago. |
| Stack | TypeScript de punta a punta. |

## 3. Reglas por defecto (configurables)

- Aceptación manual por defecto. Sin respuesta en 5 minutos, el pedido prepago se cancela y se reembolsa. Aceptación automática opcional (eventos).
- Registro obligatorio en el MVP.
- Alcohol: declaración de mayoría de edad al registrarse; verificación de DNI en el retiro como opción del local.
- **Límites por pedido:** gasto máximo de $100.000 y 20 productos individuales u 8 combos. Se pueden mezclar: un combo equivale a 2,5 productos (8 combos = 20 productos). Son valores por defecto, configurables por local. En el carrito se muestran como una lista de requisitos (✓ / ✕) con un mensaje que indica cuánto hay que quitar, y el botón de pago se bloquea; el servidor los valida siempre.
- Sin propinas. Disponibilidad solo disponible/no disponible (sin conteo de stock).
- Facturación fiscal fuera del alcance (la hace el local).
- Pedido no retirado: pasa a `no_retirado` al vencer el plazo; sin reembolso automático.
- El cliente cancela solo antes de la aceptación. Español y ARS.

## 4. Roles

Cliente, Owner, Manager, Operador de pedidos, Operador de entrega, Super admin. Un usuario puede tener roles en varios locales (tabla de membresías).

| Acción | Owner | Manager | Op. pedidos | Op. entrega | Super admin |
|---|---|---|---|---|---|
| Configuración y pagos del local | ✔ | | | | ✔ |
| Empleados y roles | ✔ | | | | ✔ |
| Catálogo, precios | ✔ | ✔ | | | ✔ |
| Disponibilidad | ✔ | ✔ | ✔ | | ✔ |
| Sectores, QR, puntos de retiro | ✔ | ✔ | | | ✔ |
| Aceptar, rechazar, preparar | ✔ | ✔ | ✔ | | ✔ |
| Validar entrega | ✔ | ✔ | ✔ | ✔ | ✔ |
| Reembolso manual | ✔ | ✔ | | | ✔ |
| Estadísticas | ✔ | ✔ | | | ✔ |
| Alta/suspensión de locales, auditoría global | | | | | ✔ |

## 5. Máquinas de estado

**Pago:** `pendiente → aprobado → reembolso_pendiente → reembolsado | reembolso_parcial`; `pendiente → rechazado | expirado`. Pago al retiro: `pendiente_de_cobro → cobrado_en_retiro | no_cobrado`.

**Operativo (pedido):** `pendiente_aceptacion → aceptado → en_preparacion → listo → entregado`; salidas a `rechazado`, `cancelado`, `no_retirado`.

**Partes (`order_part`):** cada parte tiene `en_preparacion → listo → entregado`. El pedido pasa a `listo` cuando todas están listas y a `entregado` cuando todas se entregaron. Cada parte tiene su propio QR de retiro.

Reglas: solo se avanza en orden; todo cambio queda en el historial con actor y fecha; un pedido prepago no llega al local hasta que el pago esté aprobado; rechazo o cancelación de un prepago dispara reembolso; el QR es de un solo uso.

## 6. Épicas

A. Cuenta y acceso · B. Descubrimiento y menú · C. Carrito y pedido · D. Pago · E. Seguimiento y retiro · F. Operación del local · G. Catálogo y configuración · H. Plataforma (altas, suscripciones, auditoría).

## 7. MVP

**MVP 1:** flujo completo con pago electrónico (Mercado Pago), QR de retiro, panel del local, multi-tenant, reembolsos, auditoría, sectores y puntos de retiro.
**MVP 2:** pago al retiro y sus controles, límites por intervalo, horarios finos, aceptación automática, pantalla de pedidos listos, push y email.
**Después:** eventos completos, promociones, estadísticas, WhatsApp, otros proveedores de pago, comisión por transacción.
