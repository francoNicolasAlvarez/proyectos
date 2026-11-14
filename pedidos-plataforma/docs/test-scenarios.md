# Matriz de escenarios de prueba

Cada fila es un escenario, el resultado esperado y dónde se verifica. Los nombres de archivo son los reales del repositorio; para ver el detalle de cada caso, abrir el archivo y buscar el nombre del `describe`.

Cómo correr todo: `npx -y pnpm@9 test` (dominio, API y E2E). Pruebas contra PostgreSQL real: definir `TEST_DATABASE_URL` apuntando a una base cuyo nombre termine en `_test` (el script borra y recrea el esquema, por eso se niega a correr en cualquier otra).

## 1. Cuentas y permisos

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Registro con email repetido (mayúsculas distintas) | 409, no crea la cuenta | `auth.test.ts`, `http.test.ts` |
| Contraseña igual al email | Rechazada | `auth.test.ts` |
| Login con email inexistente o clave errónea | Mismo error en ambos casos (no revela cuál) | `auth.test.ts` |
| Varios intentos fallidos | Bloqueo, incluso con la clave correcta | `http.test.ts` |
| Cerrar sesión / cambiar contraseña | Sesión revocada; las demás se cierran | `auth.test.ts` |
| Ruta de personal sin sesión | 401 | `http.test.ts` y todos los `*-admin` |
| Cliente o personal de otro local en ruta de personal | 403/404, sin filtrar datos | `http.test.ts`, `*-admin.test.ts` |
| Operador de entrega intenta aceptar un pedido | Rechazado: cada rol hace solo lo suyo | `http.test.ts` |
| Quitar al último propietario | Rechazado (LAST_OWNER) | `staff-admin.test.ts` |

## 2. Aislamiento entre locales (multi-tenant)

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Producto, sector, punto o pedido de otro local con id conocido | 404 / rechazado | `catalog-service`, `locations-admin`, `order-service` |
| Cliente intenta operar o cancelar el pedido de otro cliente del mismo local | Rechazado (comprobación de pertenencia, no solo RLS) | `order-service.test.ts` |
| Pago de un local sobre pedido de otro | No afecta nada | `payments.test.ts` |
| Clave de idempotencia repetida en otro local | No se reutiliza | `order-service.test.ts` |
| Rol de la aplicación en PostgreSQL real | Sin superusuario ni BYPASSRLS; RLS forzado | `postgres.integration.test.ts`, `database.test.mjs` |

## 3. Pedido: límites, capacidad y horarios

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Total mayor a $100.000, más de 20 individuales o más de 8 combos | 422 con detalle; no se crea | `limits.test.ts`, `http.test.ts` |
| Suma con otros pedidos abiertos de la misma persona | Cuenta contra el mismo tope | `limits.test.ts` |
| Tope configurable por local | Se respeta el valor del local | `limits-config.test.ts` |
| Combo que hace inalcanzable el tope de 8 | Aviso en el informe de coherencia | `limits-config`, `catalog-service` |
| Más de 60 días sin revisar topes | Aviso de revisión | `limits-config.test.ts` |
| Local pausado, suspendido o fuera de horario | No recibe pedidos, con mensaje claro | `order-service`, `catalog-admin` |
| Capacidad de pedidos simultáneos | Cuentan los en curso y los sin pagar dentro de la ventana | `order-service.test.ts` |
| Pedido sin pagar vencido | Libera cupo; un pago tardío se reembolsa | `order-service`, `payments` |
| Categoría pausada o producto agotado | No se puede pedir; reactivar lo devuelve | `catalog-admin.test.ts` |
| Precio cambia después de pedir | El pedido conserva el precio original | `order-service`, `catalog-service` |
| Misma clave de idempotencia | Mismo pedido, sin duplicar | `order-service`, `http` |

## 4. Pago y reembolso

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Pago aprobado | Pedido pendiente de aceptación del local | `checkout`, `order-service` |
| Pago rechazado | El pedido sigue abierto; se puede reintentar | `checkout`, `payments` |
| Pagar dos veces | El segundo cobro se reembolsa | `checkout.test.ts` |
| Webhook con firma falsa | 401, no escribe nada | `payments`, `checkout`, `http` |
| Webhook repetido o dos avisos del mismo pago | Se procesa una sola vez | `payments.test.ts` |
| Importe distinto al del pedido | Queda para revisión humana, no aprueba | `payments`, `order-service` |
| Formato antiguo de aviso de Mercado Pago | 200 y se ignora (no reintenta) | `checkout.test.ts` |
| Pago tras cancelar o vencer el pedido | Se registra y se reembolsa | `order-service.test.ts` |
| Rechazo del local con pago hecho | Reembolso total automático | `order-service`, `refunds-admin` |
| Fallo del proveedor al reembolsar | Reintenta hasta 5 veces; luego `failed` con alerta | `payments`, `refunds-admin` |
| Producción con pago simulado | El servidor se niega a arrancar; no existen rutas `/dev` | `checkout.test.ts` |
| Credenciales de cobro | Cifradas (AES-256-GCM); detecta manipulación | `payments.test.ts` |

## 5. Preparación y retiro

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Saltear pasos del pedido | Rechazado | `order-service.test.ts` |
| Marcar listo sin punto de retiro (varios puntos) | El empleado debe asignarlo; se emite el QR | `order-service.test.ts` |
| QR visible | Solo cuando la parte está lista y solo a su dueño | `menu-and-views.test.ts` |
| Retirar con QR o código | Una sola vez (consumo atómico) | `order-service`, `database.test.mjs` |
| Pedido con varios puntos | Una parte por punto, cada una con su QR | `order-service.test.ts` |
| Cliente cancela antes de aceptar / después | Con reembolso / rechazado | `http`, `order-service` |

## 6. Notificaciones y tiempo real

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Recorrido completo del pedido | Una notificación por hito, en orden | `notifications.test.ts` |
| Evento repetido | No duplica | `notifications.test.ts` |
| Cada cliente | Ve y marca solo las suyas | `notifications.test.ts` |
| Falla el canal en vivo | No se pierden las guardadas | `notifications.test.ts`, `realtime.test.ts` |

## 7. Administración del local

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Alta, edición, archivo de productos y categorías | Menú actualizado; pedidos ya hechos intactos | `catalog-service.test.ts` |
| Alta inválida | No deja nada a medias | `catalog-service.test.ts` |
| Rotar el QR de un sector | El anterior deja de resolver; auditado | `locations-admin.test.ts` |
| Un solo punto predeterminado | Siempre uno; no se desactiva | `pickup-points-admin.test.ts` |
| Cambios de configuración | Auditados con el antes y el después | todos los `*-admin` |

## 8. Interfaz (E2E, móvil y tablet)

| Escenario | Resultado esperado | Archivo |
|---|---|---|
| Flujo cliente: menú, opciones, carrito, pago, seguimiento, retiro | Completo y accesible | `customer-app.spec.js` y afines |
| Panel: aceptar, rechazar, preparar, listo, escanear | Estados correctos | `venue-panel.spec.js` y afines |
| Modo oscuro en cada pantalla | Sin violaciones WCAG A/AA serias | `visual-customer`, `visual-panel` |
| Movimiento reducido | Cero animaciones activas; sin confeti | `visual-customer`, `visual-panel` |
| Animaciones con propósito | Hoja y rebote solo al abrir/agregar; cambio de vista se limpia solo | `visual-customer.spec.js` |
| Pedido nuevo envejece | Ámbar a 2 min, rojo a 4 min; aceptado deja de envejecer | `visual-panel.spec.js` |
| Sonido del panel | Apagado por defecto, se recuerda, suena solo con pedidos nuevos | `visual-panel.spec.js` |

## 9. Rendimiento

Medido con 100.000 pedidos históricos y 20 clientes concurrentes (`pnpm perf`, ver `performance.md`). No es una prueba pasa/no pasa: documenta tiempos y planes de consulta.

## Escenarios conocidos sin cubrir

- Reembolso real de pagos con tarjeta de otro usuario de prueba (rechazo 401 del lado de Mercado Pago, documentado).
- Interfaces reales (hoy se prueban los prototipos): pendiente de la etapa de frontends.
- Carga sostenida con varios locales a la vez.
