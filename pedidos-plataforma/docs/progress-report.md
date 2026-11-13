# Informe de avance

Estado al **13 de noviembre de 2026, 14:30 (Argentina)**. Este documento resume lo hecho mientras el responsable del proyecto estuvo ausente, las decisiones tomadas en su nombre, lo que no se hizo y lo que hay que revisar.

## 1. Resumen

| Etapa | Estado |
|---|---|
| 1. Análisis funcional | Completa (`docs/functional-analysis.md`) |
| 2. Arquitectura técnica | Completa (`docs/architecture.md`, 6 ADR) |
| 3. Base de datos | **Implementada y probada** (`apps/api/db/migrations/0001_init.sql`) |
| 4. UX/UI | Prototipos navegables del cliente y del panel, conectados entre sí |
| 5. Backend | **Núcleo de negocio y capa HTTP implementados y probados**; falta ejecutar el arranque contra PostgreSQL real y el cobro (preferencia de pago) |
| 6. Frontend | No iniciado (solo prototipos) |
| 7. Pagos y QR | Lógica implementada y probada con proveedor simulado; **falta verificar contra el sandbox real de Mercado Pago** |
| 8. Pruebas | Suite automatizada de 395 pruebas (más 7 de concurrencia opcionales, no ejecutadas), ejecutable en CI |
| 9. Despliegue | No iniciado |

## 2. Qué existe

- **Dominio puro** (`packages/shared`): máquinas de estado de pedido, pago y partes con actores permitidos; validación y cálculo de precios (variantes, agregados, combos); división en partes de retiro (modo punto único y por ítem, decisión D1); reembolsos; capacidad y horarios; matriz de permisos por rol.
- **Base de datos** (`apps/api/db`): 36 tablas, claves foráneas compuestas por local, Row-Level Security en las 30 tablas con datos por local (más la política de lectura abierta del directorio de cuentas), tablas de solo inserción (auditoría e historial), restricciones de coherencia entre pago y estado.
- **Servicios** (`apps/api/src`): crear pedido (idempotente, capacidad, horarios, menú vigente, snapshots de precios); confirmar pago; aceptar, rechazar y cancelar con reembolso; preparar; asignar punto de retiro; retirar con QR de un solo uso; webhook de Mercado Pago (firma, deduplicación, consulta al proveedor, importe verificado); vencimiento de pedidos sin pagar; trabajador de reembolsos con reintentos; autenticación y sesiones; menús por evento; consultas de menú público, cola del local y seguimiento del cliente; consumidor del outbox que genera las notificaciones del cliente por cada hito (pago aprobado, recibido, aceptado, en preparación, listo con punto de retiro, entregado, rechazo o cancelación con motivo, reembolso) y las difunde por canales de usuario y de local.
- **Prototipos** (`docs/ux/prototype`): app del cliente y panel del local, conectados entre sí por almacenamiento local del navegador.
- **Pruebas**: 97 (dominio) + 158 y 32 (API y base de datos, contra PostgreSQL real vía PGlite) + 108 (E2E y accesibilidad con Playwright en móvil y tablet).

## 3. Cómo ejecutarlo

Requiere Node 20+ (se usó Node 24) y pnpm 9. Sin Docker: la base de datos de las pruebas es PGlite (PostgreSQL en WebAssembly).

```
pnpm install
pnpm --filter @pasamanos/e2e exec playwright install chromium   # una sola vez
pnpm typecheck
pnpm test
```

Prototipos: abrir `docs/ux/prototype/customer-app/index.html` y `docs/ux/prototype/venue-panel/index.html` en dos pestañas del mismo navegador.

## 4. Decisiones tomadas sin consulta (revisar)

1. **Herramientas de prueba:** Playwright (E2E y accesibilidad con axe-core), Vitest y `node:test`, PGlite.
2. **Hosting provisional:** Railway más Cloudflare (Pages y R2). No contratado ni verificado.
3. **QR de retiro firmado con HMAC** en lugar de aleatorio con hash, para que el cliente pueda volver a mostrar su QR (enmienda en el ADR 0005). Hace crítico el secreto del servidor.
4. **Capacidad:** un pedido sin pagar RESERVA cupo durante la ventana de pago del local (10 minutos por defecto, configurable); pasada la ventana deja de contar y un job lo cancela. Antes no contaba y se podía sobrevender cuando muchos pedidos se creaban antes de pagarse. Costo: un carrito abandonado bloquea cupo hasta 10 minutos.
5. **Un pago rechazado no cancela el pedido** (el cliente puede reintentar); los pedidos sin pagar se cancelan por vencimiento.
6. **Un pago que llega tarde** (pedido cancelado o vencido) se registra y se reembolsa.
7. **Fuera de la ventana de pedidos de un evento** rige el menú habitual del local.
8. **Contraseñas con scrypt** de Node en lugar de argon2 (evita compilación nativa en Windows). Costo 2^15.
9. **Declaración de mayoría de edad obligatoria** al registrarse.
10. **Nombre de marca y logo:** los definió el responsable; el logo se revisó visualmente solo en captura.
11. **Límites por pedido (pedido posterior):** $100.000 de gasto y 20 productos individuales u 8 combos. "20 u 8" se implementó como equivalencia (un combo = 2,5 productos, se pueden mezclar). Los límites **suman los pedidos abiertos de la misma persona en el local** (sin entregar, y los sin pagar solo dentro de la ventana de pago), así no se esquivan partiendo la compra. Son configurables por local, con aviso de coherencia contra el catálogo y de revisión cada 60 días por inflación. Con pago al retiro (MVP 2) rige además un tope de gasto menor ($30.000 por defecto).

## 5. Hallazgos durante el trabajo

- **Los dos límites interactuaban (resuelto con un aviso):** un combo de más de $12.500 hace que el tope de gasto salte antes que el de 8 combos (con el combo de ejemplo de $12.900, 8 combos suman $103.200). Ahora `GET /venues/:slug/staff/limits` informa al local qué productos hacen inalcanzable un tope (`COMBO_LIMIT_UNREACHABLE`, `PRODUCT_EXCEEDS_TOTAL`, `ITEM_LIMIT_UNREACHABLE`) para que ajuste precios o topes. El sistema no los cambia solo: es decisión del local.
- **El límite era por pedido y no por persona (resuelto):** ahora se suma el pedido nuevo más los pedidos abiertos de la persona en ese local. Quien ya entregó o canceló no queda penalizado. Sigue siendo posible esquivarlo entre locales distintos, o esperando a que se entregue el primer pedido, lo cual es razonable.
- **Inflación (resuelto en parte):** los topes en pesos se desactualizan. Cada local tiene fecha de última revisión y el informe de límites avisa (`reviewDue`) pasados 60 días; el propietario confirma que siguen vigentes o los cambia, y queda auditado. No hay ajuste automático por índice: sería una decisión de producto.

- **Carrito del prototipo:** los botones de cantidad y eliminar no funcionaban (clave con comillas rota en un atributo HTML). Lo detectó la primera prueba E2E.
- **Falta de RLS** en `provider_account_directory`: la prueba que exige RLS en toda tabla con `tenant_id` lo detectó.
- **IDOR entre clientes (seguridad):** con contexto de local fijado, la política de seguridad por fila deja ver todos los pedidos del local, de modo que un cliente podía ver o cancelar el pedido de otro adivinando su id. Corregido con verificación explícita de propiedad en `getCustomerOrder` y `transitionOrder`. **Regla para la capa HTTP:** las lecturas del cliente deben pasar su `userId` y las rutas de cliente no deben depender solo de RLS.
- **Capacidad: sobreventa (resuelto):** los pedidos sin pagar reservan cupo durante la ventana de pago. Con varias conexiones reales la verificación se serializa por el bloqueo de `tenant_settings`, pero esa prueba sigue sin ejecutarse (ver la limitación de concurrencia real).
- **Idempotencia bajo concurrencia (corregido en el código, sin verificar con carreras reales):** la clave se re-verifica tras tomar el bloqueo del local.
- Un commit intermedio se subió con una prueba fallando (la de RLS anterior); se corrigió en el commit siguiente.

## 6. Lo que NO está hecho ni verificado

- **Capa HTTP: lo que falta.** Están las rutas de cuenta, menú, pedidos, personal, notificaciones y webhook (Fastify, Zod, cookie de sesión, CSRF por origen, límite de intentos de login). Falta: creación de la preferencia de pago, CORS configurable, límite general de peticiones, y la limitación de login usa memoria (debe pasar a Redis para varias instancias).
- **Tiempo real con varias instancias:** el SSE funciona (hub en memoria, endpoints `/events` y `/venues/:slug/staff/events`, probado con streaming HTTP real), pero con más de una instancia del servidor hay que reemplazar el hub por Redis pub/sub. Push, email y WhatsApp quedan para después. El despacho periódico del outbox, de los reembolsos y del vencimiento de pedidos está en `server.ts` y no se ejecutó nunca.
- **Conexión OAuth con Mercado Pago**, creación de la preferencia de pago y obtención de credenciales por local.
- **El adaptador de Mercado Pago** está escrito de la documentación pública y probado solo con respuestas simuladas. Hay que verificar firma, campos y reembolsos contra el sandbox real, y revisar condiciones y tarifas vigentes.
- **Concurrencia real (verificada el 13/11/2026):** las 7 pruebas de `apps/api/test/postgres.integration.test.ts` se ejecutaron contra un PostgreSQL 17.2 real con varias conexiones, tres corridas seguidas, 7/7: 10 escaneos simultáneos del mismo QR (uno solo entrega), 8 pedidos con la misma clave de idempotencia (uno solo se crea), 20 pedidos simultáneos con numeración consecutiva, webhook repetido en paralelo (se aprueba una vez), cupo lleno, flujo completo con el adaptador `pg` y RLS con conexiones reales. El PostgreSQL embebido por npm no inicializaba por un límite de Windows (la ruta dentro de `node_modules` supera los 260 caracteres); se resolvió copiando los binarios a una ruta corta con `infra/local-postgres.ps1`. La prueba reinicia el esquema, por eso **solo corre sobre bases cuyo nombre termina en `_test`**. `server.ts` también se ejecutó contra la base real (el 13/11/2026) y una prueba de humo por HTTP de 18 comprobaciones pasó completa: login, menú, pedido con límites, idempotencia, cancelación, notificación generada por el outbox, permisos por rol, CSRF y SSE. Esa ejecución encontró un error que ninguna prueba automática había detectado: `import { Pool } from 'pg'` falla al ejecutarse con Node directamente (pg es CommonJS); Vitest lo resuelve distinto y por eso los tests no lo veían. Corregido. Los flujos de reembolso y vencimiento reales dependen de Mercado Pago y no se ejercitaron de punta a punta.
- **Suscripciones de la plataforma**, panel de super admin, facturación.
- **Frontends reales**, PWA, notificaciones push.
- **Pago al retiro** (efectivo y tarjeta física): el esquema lo soporta, la lógica no.
- **Pruebas E2E sobre la aplicación real:** hoy corren sobre los prototipos.
- **Disponibilidad del nombre "Pasamanos"** (INPI y dominio) sin verificar.

## 7. Próximos pasos recomendados

1. Completar la capa HTTP: SSE, creación del cobro, administración de catálogo, sectores y puntos de retiro, y alta de empleados.
2. Hacer correr `server.ts` contra un PostgreSQL real (local o servicio de CI) y verificar las tareas periódicas; pasar el hub a Redis.
3. Flujo OAuth y creación de cobros con Mercado Pago, probando contra el sandbox.
4. Servicio de PostgreSQL en CI para pruebas de concurrencia.
5. Frontends reales a partir de los prototipos aprobados.

## 8. Decisiones pendientes del responsable

- Revisar y aprobar o ajustar la lista de la sección 4.
- Plazo de retención de datos de pagos (D3 en `docs/database-design.md`).
- Hosting definitivo y presupuesto.
- Confirmar que fuera de la ventana de un evento se vende el menú habitual.
- ¿La ventana de pago de 10 minutos es adecuada? Más corta libera cupo antes pero cancela pagos lentos; hay que alinearla con el vencimiento de la preferencia de pago de Mercado Pago.
- Pago al retiro (MVP 2): el tope de $30.000 es un valor propuesto; la lógica de ese medio de pago todavía no está implementada.
- Política de pedidos no retirados (plazo y reembolso) y de "strikes" (MVP 2).
