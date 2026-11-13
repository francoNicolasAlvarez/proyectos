# Informe de avance

Estado al **13 de noviembre de 2026, 14:30 (Argentina)**. Este documento resume lo hecho mientras el responsable del proyecto estuvo ausente, las decisiones tomadas en su nombre, lo que no se hizo y lo que hay que revisar.

## 1. Resumen

| Etapa | Estado |
|---|---|
| 1. Análisis funcional | Completa (`docs/functional-analysis.md`) |
| 2. Arquitectura técnica | Completa (`docs/architecture.md`, 6 ADR) |
| 3. Base de datos | **Implementada y probada** (`apps/api/db/migrations/0001_init.sql`) |
| 4. UX/UI | Prototipos navegables del cliente y del panel, conectados entre sí |
| 5. Backend | **Núcleo de negocio implementado y probado**; falta la capa HTTP |
| 6. Frontend | No iniciado (solo prototipos) |
| 7. Pagos y QR | Lógica implementada y probada con proveedor simulado; **falta verificar contra el sandbox real de Mercado Pago** |
| 8. Pruebas | Suite automatizada de 286 pruebas, ejecutable en CI |
| 9. Despliegue | No iniciado |

## 2. Qué existe

- **Dominio puro** (`packages/shared`): máquinas de estado de pedido, pago y partes con actores permitidos; validación y cálculo de precios (variantes, agregados, combos); división en partes de retiro (modo punto único y por ítem, decisión D1); reembolsos; capacidad y horarios; matriz de permisos por rol.
- **Base de datos** (`apps/api/db`): 36 tablas, claves foráneas compuestas por local, Row-Level Security en las 30 tablas con datos por local (más la política de lectura abierta del directorio de cuentas), tablas de solo inserción (auditoría e historial), restricciones de coherencia entre pago y estado.
- **Servicios** (`apps/api/src`): crear pedido (idempotente, capacidad, horarios, menú vigente, snapshots de precios); confirmar pago; aceptar, rechazar y cancelar con reembolso; preparar; asignar punto de retiro; retirar con QR de un solo uso; webhook de Mercado Pago (firma, deduplicación, consulta al proveedor, importe verificado); vencimiento de pedidos sin pagar; trabajador de reembolsos con reintentos; autenticación y sesiones; menús por evento; consultas de menú público, cola del local y seguimiento del cliente.
- **Prototipos** (`docs/ux/prototype`): app del cliente y panel del local, conectados entre sí por almacenamiento local del navegador.
- **Pruebas**: 67 (dominio) + 95 y 32 (API y base de datos, contra PostgreSQL real vía PGlite) + 92 (E2E y accesibilidad con Playwright en móvil y tablet).

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
4. **Capacidad:** los pedidos sin pagar no ocupan cupo; sí los pendientes de aceptación, aceptados, en preparación y listos.
5. **Un pago rechazado no cancela el pedido** (el cliente puede reintentar); los pedidos sin pagar se cancelan por vencimiento.
6. **Un pago que llega tarde** (pedido cancelado o vencido) se registra y se reembolsa.
7. **Fuera de la ventana de pedidos de un evento** rige el menú habitual del local.
8. **Contraseñas con scrypt** de Node en lugar de argon2 (evita compilación nativa en Windows). Costo 2^15.
9. **Declaración de mayoría de edad obligatoria** al registrarse.
10. **Nombre de marca y logo:** los definió el responsable; el logo se revisó visualmente solo en captura.

## 5. Hallazgos durante el trabajo (ya corregidos)

- **Carrito del prototipo:** los botones de cantidad y eliminar no funcionaban (clave con comillas rota en un atributo HTML). Lo detectó la primera prueba E2E.
- **Falta de RLS** en `provider_account_directory`: la prueba que exige RLS en toda tabla con `tenant_id` lo detectó.
- **IDOR entre clientes (seguridad):** con contexto de local fijado, la política de seguridad por fila deja ver todos los pedidos del local, de modo que un cliente podía ver o cancelar el pedido de otro adivinando su id. Corregido con verificación explícita de propiedad en `getCustomerOrder` y `transitionOrder`. **Regla para la capa HTTP:** las lecturas del cliente deben pasar su `userId` y las rutas de cliente no deben depender solo de RLS.
- Un commit intermedio se subió con una prueba fallando (la de RLS anterior); se corrigió en el commit siguiente.

## 6. Lo que NO está hecho ni verificado

- **Capa HTTP** (Fastify o NestJS): rutas, validación de entrada con Zod, cookies de sesión, CSRF, CORS, limitación de intentos de login y de peticiones. Hoy todo es llamable solo como funciones.
- **Tiempo real (SSE) y notificaciones:** el outbox se escribe pero nada lo consume todavía.
- **Conexión OAuth con Mercado Pago**, creación de la preferencia de pago y obtención de credenciales por local.
- **El adaptador de Mercado Pago** está escrito de la documentación pública y probado solo con respuestas simuladas. Hay que verificar firma, campos y reembolsos contra el sandbox real, y revisar condiciones y tarifas vigentes.
- **Concurrencia real:** PGlite usa una conexión; las pruebas de "dos escaneos simultáneos" no ejercitan carrera real. Hay que repetirlas contra PostgreSQL con varias conexiones (servicio en CI).
- **Suscripciones de la plataforma**, panel de super admin, facturación.
- **Frontends reales**, PWA, notificaciones push.
- **Pago al retiro** (efectivo y tarjeta física): el esquema lo soporta, la lógica no.
- **Pruebas E2E sobre la aplicación real:** hoy corren sobre los prototipos.
- **Disponibilidad del nombre "Pasamanos"** (INPI y dominio) sin verificar.

## 7. Próximos pasos recomendados

1. Capa HTTP con autenticación y los endpoints del MVP, usando los servicios existentes y pruebas de integración HTTP.
2. Consumidor del outbox (notificaciones in-app y SSE).
3. Flujo OAuth y creación de cobros con Mercado Pago, probando contra el sandbox.
4. Servicio de PostgreSQL en CI para pruebas de concurrencia.
5. Frontends reales a partir de los prototipos aprobados.

## 8. Decisiones pendientes del responsable

- Revisar y aprobar o ajustar la lista de la sección 4.
- Plazo de retención de datos de pagos (D3 en `docs/database-design.md`).
- Hosting definitivo y presupuesto.
- Confirmar que fuera de la ventana de un evento se vende el menú habitual.
- Política de pedidos no retirados (plazo y reembolso) y de "strikes" (MVP 2).
