# Frontend: app del cliente

Estado: **primera versión funcional** de la app del cliente (`apps/web`). El panel del local todavía es solo un prototipo (`docs/ux/prototype/venue-panel`).

## Tecnología

React 18, TypeScript, Vite 5 y React Router 6, con Vitest y Testing Library para pruebas de pantallas. Sin librerías de estado ni de estilos: el estado es un contexto de React y el CSS parte de los tokens del [sistema de diseño](ux/design-system.md) (modo oscuro, movimiento reducido).

## Cómo se conecta a la API

En desarrollo la app y la API comparten origen: Vite reenvía `/api/*` a la API (`VITE_API_TARGET`, por defecto `http://localhost:3000`). Así la cookie de sesión (httpOnly) funciona sin CORS y la comprobación CSRF de la API ve un origen permitido (`http://localhost:5173` ya está en `ALLOWED_ORIGINS`). En producción conviene servir la app y la API bajo el mismo dominio por la misma razón.

## Pantallas

| Ruta | Qué hace |
|---|---|
| `/` | Inicio |
| `/v/:slug` | Menú del local. `?s=<token>` es el QR de un sector: muestra "Estás en: Mesa 4" (solo informativo) y envía ese origen con el pedido |
| `/v/:slug/carrito` | Carrito con avisos de límites, medio de pago y pago |
| `/login`, `/registro` | Cuenta (con declaración de mayoría de edad) |
| `/orders/:id` | Seguimiento en vivo, QR y código de retiro, cancelación, reintento de pago. Es también la dirección de retorno de Mercado Pago (`?pago=ok|error|pendiente`) |

## Decisiones de diseño

- **El carrito se arma sin cuenta** y se guarda en el navegador por local; la cuenta se pide recién al pagar y se vuelve al carrito.
- **Mismo cálculo de límites que el servidor**: el carrito usa `@pasamanos/shared` (`orderLimitViolations`), así el aviso aparece antes de pagar y coincide con lo que valida la API.
- **Idempotencia**: cada intento de pago tiene una clave que se conserva en los reintentos y se descarta si cambia el carrito. Un corte de red tras crear el pedido no duplica pedidos.
- **Tiempo real con red de seguridad**: el canal SSE solo avisa que algo cambió; el estado se vuelve a pedir por GET. Un sondeo cada 8 s cubre cortes del canal.
- **Errores en lenguaje claro**: `lib/messages.ts` traduce los códigos de negocio; nunca se muestran códigos técnicos ni detalles internos.
- **Redirecciones seguras**: `next` solo acepta rutas internas.

## Pruebas

- `pnpm --filter @pasamanos/web test`: 55 pruebas (carrito y límites, cliente de la API, pantallas con la API simulada).
- `pnpm --filter @pasamanos/e2e test:web`: 13 pruebas contra la **API real** con PGlite en memoria y pago simulado (`apps/api/scripts/e2e-server.ts`). Cubren el recorrido completo (registro, pedido, pago, seguimiento en tiempo real, QR, código de un solo uso), pago rechazado y reintento, rechazo del local, cancelación, origen por QR, límites, aislamiento entre clientes y accesibilidad WCAG A/AA en claro y oscuro.

Lección registrada: una prueba con la API simulada no detectó que la respuesta de crear pedido era `{ orderId, orderNumber }` y no `{ id, number }`; la detectó la prueba E2E real. Por eso los E2E contra la API real son obligatorios para cada pantalla nueva.

## Pendiente

- **PWA completa**: hay `manifest`, falta el service worker (instalación y uso sin conexión) y los íconos PNG que exigen algunas plataformas.
- Nombre y datos del local en la cabecera: el endpoint del menú todavía no los devuelve (hoy muestra "Menú").
- Notificaciones dentro de la app (la API ya las expone en `/notifications`).
- Lista de "Mis pedidos" y pedidos abiertos sumados en el aviso de límites.
- **Panel del local real** (tablero, escáner con cámara, administración): siguiente etapa.
- Despliegue: definir hosting; servir app y API bajo el mismo dominio.
