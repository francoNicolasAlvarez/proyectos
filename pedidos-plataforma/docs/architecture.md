# Arquitectura técnica (Etapa 2)

## 1. Decisiones

| Tema | Decisión |
|---|---|
| Estilo | Monolito modular, un solo despliegue |
| Repositorio | Monorepo con pnpm workspaces |
| Backend | NestJS sobre Fastify, TypeScript, API REST |
| Validación | Zod, esquemas compartidos en `packages/shared` |
| Base de datos | PostgreSQL 16 |
| Acceso a datos | Drizzle ORM con migraciones SQL |
| Cache, colas, pub/sub | Redis + BullMQ |
| Frontend | Vite + React + TypeScript + vite-plugin-pwa (dos apps: cliente y panel) |
| Tiempo real | SSE (Redis pub/sub entre instancias) |
| Autenticación | Email y contraseña (argon2), sesión en servidor con cookie httpOnly |
| Pagos | Interfaz `PaymentProvider`; Mercado Pago con OAuth por local |
| Archivos | Almacenamiento compatible con S3 y CDN |

## 2. Estructura

```
apps/api            backend NestJS
apps/customer-app   PWA del cliente
apps/venue-panel    panel del local y super admin
packages/shared     esquemas Zod, tipos, enums de estados
packages/ui         componentes y tokens de diseño
packages/config     tsconfig, eslint, prettier
docs/               análisis, arquitectura, base de datos, ADRs
infra/              docker-compose, scripts de despliegue
```

## 3. Módulos del backend

identity · tenancy · catalog · locations · pickup-points · ordering · payments · fulfillment · pickup · capacity · notifications · platform · audit.

Reglas: los módulos se comunican por servicios públicos o eventos internos, nunca por las tablas del otro. Los estados cambian solo mediante un servicio de transición único que valida la regla, escribe el historial y emite el evento.

## 4. Multi-tenant

Esquema compartido con `tenant_id` en cada tabla de negocio y **Row-Level Security**. El tenant sale de la sesión y la membresía, nunca de un parámetro del cliente. Cada request corre en una transacción con `set_config('app.tenant_id' / 'app.user_id', ..., true)`. La aplicación usa un rol de base de datos sin `BYPASSRLS`; las migraciones usan otro. Un test de aislamiento entre locales corre en cada CI.

## 5. Flujos críticos

- **Pedido:** clave de idempotencia; el servidor recalcula precios, disponibilidad, horario y capacidad; la capacidad se verifica bajo bloqueo (`FOR UPDATE`); se guardan snapshots.
- **Webhook de pago:** verificar firma → responder 200 → guardar evento con restricción única → encolar → el worker consulta el pago a la API de MP → transacción que actualiza pago y orden y escribe en el outbox.
- **Reconciliación:** job periódico contra MP para webhooks perdidos.
- **Timeout de aceptación:** job programado; si vence, cancela y encola reembolso.
- **Reembolsos:** cola con reintentos y backoff.
- **Retiro:** token de 128 bits (se guarda solo su hash) más código corto; consumo atómico; el operador ve el contenido del pedido antes de confirmar.

## 6. Seguridad

argon2, rate limiting, credenciales OAuth cifradas, CORS y CSRF, auditoría de acciones sensibles, ningún dato de tarjetas en nuestro sistema.

## 7. Entornos, CI y hosting

- Local: docker-compose (PostgreSQL y Redis) y Mercado Pago en modo de prueba.
- CI (GitHub Actions): lint, tipos, tests con base real, migraciones, aislamiento entre locales.
- **Hosting inicial (provisional): Railway** para API, PostgreSQL y Redis; frontends estáticos con CDN (por ejemplo Cloudflare Pages); imágenes en Cloudflare R2. Se elige por la poca operación que requiere. Hay que revisar regiones, latencia desde Argentina y precios vigentes antes de contratar, y migrar a otro proveedor si hace falta.

## 8. Pruebas

Unitarias (estados, precios, combos, capacidad), integración con PostgreSQL real (webhooks duplicados y desordenados), aislamiento entre locales, concurrencia (límites y doble escaneo de QR), carga de pico de evento, E2E de los flujos principales.
