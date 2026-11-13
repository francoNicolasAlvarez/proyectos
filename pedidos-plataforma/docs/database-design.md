# Diseño de base de datos (Etapa 3)

**Estado:** implementado en `apps/api/db/migrations/0001_init.sql` y verificado con `apps/api/test/database.test.mjs` (31 pruebas contra PostgreSQL real vía PGlite). Dos diferencias respecto del diseño original: `orders.operational_status` incluye `awaiting_payment` como estado inicial (el pedido existe pero no se muestra al local hasta que el pago esté aprobado), y los índices únicos de email y slug usan `lower()` en lugar del tipo `citext`.

**Limitación conocida de las pruebas:** PGlite usa una sola conexión, así que el test de "dos escaneos simultáneos" no ejercita concurrencia real. Debe repetirse contra un PostgreSQL con varias conexiones (servicio en CI) antes del lanzamiento.

PostgreSQL 16. Este documento es el diseño; las migraciones ejecutables (Drizzle, SQL) se generan al comenzar el backend (Etapa 5) y se prueban contra una base real.

## 1. Convenciones

- Claves primarias `uuid` (UUID v7 si hay soporte; si no, `gen_random_uuid()`).
- Fechas `timestamptz` en UTC. Cada tabla lleva `created_at` y `updated_at`.
- Dinero: **enteros en centavos** (`*_cents bigint`) y `currency char(3)` (`ARS`). Nunca decimales ni floats.
- Estados: `text` con `CHECK` (más fácil de migrar que enums nativos).
- Toda tabla de negocio lleva `tenant_id`. Las claves foráneas entre tablas de negocio son **compuestas** `(tenant_id, id)` para que sea imposible referenciar filas de otro local. Para eso, cada tabla referenciada declara `UNIQUE (tenant_id, id)`.
- Catálogo: no se borra, se archiva (`archived_at`), para no romper el historial.
- Texto de usuario con `citext` para email.

## 2. Tablas

### 2.1 Identidad y plataforma (sin `tenant_id`, salvo indicación)

**users**: `id`, `email` (citext, único), `password_hash`, `name`, `phone`, `email_verified_at`, `adult_declared_at`, `is_platform_admin bool`, `status` (`active|blocked`), `no_show_count int` (MVP 2).

**sessions**: `id`, `user_id`, `token_hash` (único), `expires_at`, `revoked_at`, `ip`, `user_agent`.

**password_reset_tokens**: `id`, `user_id`, `token_hash`, `expires_at`, `used_at`.

**tenants**: `id`, `name`, `slug` (único, citext), `status` (`active|suspended|archived`), `timezone`, `currency`, `description`, `logo_url`, `address`.

**tenant_memberships**: `id`, `tenant_id`, `user_id`, `role` (`owner|manager|order_operator|pickup_operator`), `active`. Único `(tenant_id, user_id)`.

**plans** y **tenant_subscriptions**: `plan_id`, `tenant_id`, `status` (`trial|active|past_due|canceled`), `current_period_end`, `notes`. Gestión manual al inicio.

### 2.2 Configuración del local

**tenant_settings** (1 fila por tenant): `tenant_id` (PK), `ordering_paused bool`, `pause_message`, `pickup_mode` (`single_point|per_item`), `acceptance_mode` (`manual|auto`), `acceptance_timeout_seconds` (default 300), `max_concurrent_orders`, `max_orders_per_interval`, `interval_minutes`, `pickup_deadline_minutes`, `default_prep_minutes`, `id_check_on_pickup bool`, `max_order_total_cents` (por defecto 10.000.000 = $100.000), `max_individual_items` (20), `max_combos` (8).

**tenant_payment_methods**: `tenant_id`, `method` (`card_online|payment_app|cash_on_pickup|card_on_pickup`), `enabled`, `config jsonb`. Único `(tenant_id, method)`. En MVP 1 solo se permiten los dos electrónicos (se valida en la aplicación).

**tenant_payment_accounts**: `tenant_id`, `provider` (`mercadopago`), `provider_account_id`, `access_token_enc`, `refresh_token_enc`, `expires_at`, `status`. Tokens **cifrados**; nunca se devuelven por la API.

**opening_hours**: `tenant_id`, `weekday`, `opens_at`, `closes_at` (varias franjas por día; cierre pasada la medianoche permitido).

**pickup_points**: `id`, `tenant_id`, `name` (por ejemplo "Barra 2", "Punto de comida"), `description`, `sort_order`, `is_default bool`, `active`. Un único `is_default` activo por tenant (índice parcial único).

**locations** (sectores de origen, solo informativos): `id`, `tenant_id`, `name`, `kind` (`table|bar|sector|other`), `qr_token` (único, aleatorio, no secuencial), `event_id` nullable, `active`.

### 2.3 Eventos (preparado, UI posterior)

**events**: `id`, `tenant_id`, `name`, `starts_at`, `ends_at`, `orders_open_at`, `orders_close_at`, `status`. Los menús, sectores y pedidos pueden vincularse a un evento mediante `event_id` nullable.

### 2.4 Catálogo

**menus**: `id`, `tenant_id`, `name`, `kind` (`regular|event`), `event_id` nullable, `is_default bool`, `valid_from`, `valid_until`, `active`. **Regla de resolución:** si hay un menú de evento activo dentro de su ventana, reemplaza al menú habitual; si no, se usa el menú por defecto. Un único menú por defecto por tenant.

**categories**: `id`, `tenant_id`, `menu_id`, `name`, `sort_order`, `paused bool`, `pickup_point_id` nullable (para `per_item`), `archived_at`.

**products**: `id`, `tenant_id`, `category_id`, `name`, `description`, `ingredients`, `image_url`, `base_price_cents`, `prep_minutes`, `kind` (`simple|combo`), `available bool`, `pickup_point_id` nullable (anula el de la categoría), `sort_order`, `archived_at`.

**option_groups**: `id`, `tenant_id`, `product_id`, `name`, `min_select`, `max_select`, `sort_order`. Las **variantes** (sabor, tamaño, variedad de cerveza) son un grupo con `min=max=1`; los adicionales son un grupo opcional. Un único mecanismo para ambos.

**options**: `id`, `tenant_id`, `group_id`, `name`, `price_delta_cents`, `available`, `sort_order`.

**combo_slots**: `id`, `tenant_id`, `combo_product_id`, `name` (por ejemplo "Cerveza"), `quantity`, `sort_order`.

**combo_slot_products**: `slot_id`, `product_id`, `price_delta_cents`. Define qué productos puede elegir el cliente en cada ranura.

**Resolución del punto de retiro de un ítem** (modo `per_item`): `products.pickup_point_id` → `categories.pickup_point_id` → punto `is_default`. Un combo se retira completo en un solo punto (el del producto combo). En modo `single_point`, se usa un único punto por pedido (ver decisión pendiente D1).

### 2.5 Pedidos

**order_counters**: `tenant_id`, `counter_date`, `last_number`. Se incrementa dentro de la transacción del pedido para generar el número visible por local y día (por ejemplo `#042`).

**orders**: `id`, `tenant_id`, `user_id`, `order_number`, `counter_date`, `origin_location_id` nullable, `origin_location_name_snapshot`, `event_id` nullable, `operational_status`, `payment_status`, `payment_timing` (`prepaid|on_pickup`), `payment_method`, `subtotal_cents`, `total_cents`, `currency`, `estimated_ready_at`, `notes`, `idempotency_key`, `placed_at`, `accepted_at`, `ready_at`, `delivered_at`, `cancelled_at`, `cancel_reason_code`, `cancel_reason_text`, `cancelled_by`.
Únicos: `(tenant_id, counter_date, order_number)`, `(user_id, idempotency_key)`.
Checks: `total_cents >= 0`; coherencia entre `payment_timing` y los estados de pago permitidos.

**order_parts**: `id`, `tenant_id`, `order_id`, `pickup_point_id` nullable, `status` (`preparing|ready|delivered|not_picked_up|cancelled`), `ready_at`, `delivered_at`, `delivered_by`. **Todo pedido tiene al menos una parte**; en `single_point` hay exactamente una.

**order_items**: `id`, `tenant_id`, `order_id`, `order_part_id`, `product_id` (referencia informativa), `name_snapshot`, `unit_price_cents`, `quantity`, `line_total_cents`, `prep_minutes_snapshot`, `notes`.

**order_item_selections**: `id`, `tenant_id`, `order_item_id`, `kind` (`option|combo_choice`), `group_or_slot_name_snapshot`, `name_snapshot`, `price_delta_cents`, `quantity`. Los snapshots garantizan que cambios futuros del catálogo no alteren pedidos pasados.

**order_status_history**: `id`, `tenant_id`, `order_id`, `order_part_id` nullable, `axis` (`operational|payment|part`), `from_status`, `to_status`, `actor_user_id` nullable, `actor_kind` (`customer|staff|system|provider`), `reason`, `created_at`. Solo se inserta (sin UPDATE ni DELETE).

**cancellation_reasons**: catálogo (`code`, `label`): sin disponibilidad, falta de ingredientes, capacidad excedida, local cerrado, problemas técnicos, otro.

### 2.6 Pagos

**payments**: `id`, `tenant_id`, `order_id`, `provider`, `provider_payment_id` (único con `provider`), `status`, `amount_cents`, `currency`, `method_detail`, `raw jsonb`, `approved_at`. Para pagos al retiro: `collected_by`, `collected_at`.

**payment_events**: `id`, `provider`, `provider_event_id` (único con `provider`), `received_at`, `payload jsonb`, `processed_at`, `error`. La restricción única es la deduplicación de webhooks. `tenant_id` es obligatorio: se resuelve al recibir el webhook a partir de la cuenta de Mercado Pago del vendedor (cada local tiene la suya), por lo que la tabla queda cubierta por RLS.

**refunds**: `id`, `tenant_id`, `payment_id`, `amount_cents`, `reason`, `status` (`pending|succeeded|failed`), `provider_refund_id`, `attempts`, `last_error`, `requested_by`.

### 2.7 Retiro

**pickup_tokens**: `id`, `tenant_id`, `order_part_id`, `token_hash` (único), `short_code`, `expires_at`, `used_at`, `used_by`. Índice único parcial `(tenant_id, short_code) WHERE used_at IS NULL` para que el código corto no colisione entre pedidos vigentes.

### 2.8 Notificaciones, outbox y auditoría

**notifications**: `id`, `tenant_id` nullable, `user_id`, `type`, `payload jsonb`, `read_at`.

**outbox_events**: `id`, `tenant_id`, `type`, `payload jsonb`, `created_at`, `published_at`. Se escribe en la misma transacción que el cambio de estado.

**audit_log**: `id`, `tenant_id` nullable, `actor_user_id`, `action`, `entity`, `entity_id`, `before jsonb`, `after jsonb`, `ip`, `created_at`. Solo inserción: se revocan UPDATE y DELETE al rol de la aplicación.

**push_subscriptions** (MVP 2): `user_id`, `endpoint`, `keys`.

## 3. Seguridad a nivel de base de datos (RLS)

- Dos roles: `app_migrator` (dueño de las tablas, para migraciones) y `app_runtime` (sin `BYPASSRLS`, sin superusuario).
- Toda tabla con `tenant_id` tiene `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY`.
- Política base: `tenant_id = current_setting('app.tenant_id', true)::uuid`.
- Tablas del cliente (`orders`, `notifications`): la política acepta también `user_id = current_setting('app.user_id', true)::uuid`, para que un cliente vea sus pedidos de todos los locales sin pertenecer a ninguno. Las tablas hijas (ítems, partes, historial) se alcanzan por la visibilidad del pedido.
- Rutas públicas (menú): la API resuelve el tenant desde el `slug` y consulta solo filas activas; el rol sin sesión no tiene permisos de escritura.
- Workers y webhooks fijan `app.tenant_id` a partir de la orden que procesan.
- Si el contexto no está fijado, las políticas no devuelven filas (seguro por defecto).

## 4. Concurrencia e integridad

- **Capacidad:** en la transacción de creación del pedido se bloquea la fila de `tenant_settings` (`SELECT ... FOR UPDATE`), se cuentan los pedidos activos y los del intervalo, y recién entonces se inserta. Es simple y correcto; si el volumen lo exige, se pasa a contadores por intervalo.
- **Número de pedido:** `order_counters` incrementado con `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.
- **Idempotencia:** único `(user_id, idempotency_key)` en pedidos; único `(provider, provider_payment_id)` y `(provider, provider_event_id)` en pagos.
- **QR de retiro:** `UPDATE pickup_tokens SET used_at = now(), used_by = ... WHERE token_hash = ... AND used_at IS NULL RETURNING ...` en una única sentencia.
- **Transiciones de estado:** validadas por el servicio de transición. Además, se evalúa un trigger que rechace saltos inválidos ante UPDATE directos, y un `CHECK` de coherencia entre `payment_timing` y `payment_status`.

## 5. Índices principales

- `orders (tenant_id, operational_status, placed_at)`: cola del local.
- `orders (user_id, placed_at desc)`: historial del cliente.
- `order_parts (tenant_id, pickup_point_id, status)`: vista por punto de retiro.
- `payments (tenant_id, status)` y `payments (order_id)`.
- `products (tenant_id, category_id) WHERE archived_at IS NULL`.
- `tenants (slug)`, `locations (qr_token)`.
- Parciales: pedidos activos (no entregados ni cancelados) para los conteos de capacidad.

## 6. Retención y datos personales

Datos mínimos del cliente (email, nombre, teléfono opcional). Sin datos de tarjetas. El payload crudo de pagos se conserva por soporte y conciliación; definir plazo de retención antes del lanzamiento. La auditoría no se borra.

## 7. Datos semilla (para desarrollo y pruebas)

Un local demo con: un owner, un manager, un operador de pedidos y uno de entrega; un menú con cervezas, tragos, comidas y un combo con ranuras; dos puntos de retiro; tres sectores; un cliente de prueba; y un segundo local para los tests de aislamiento.

## 8. Decisiones pendientes que afectan este diseño

- **D1 (resuelta): modo `single_point` con varios puntos numerados.** El **empleado asigna el punto de retiro al marcar el pedido como listo**. Hasta entonces `order_parts.pickup_point_id` queda en `NULL` (salvo que el local tenga un único punto, en cuyo caso se asigna al crear el pedido). La notificación de "listo" indica el punto asignado. Se descartaron la elección por el cliente y la asignación automática; se podrán agregar después sin cambiar el esquema.
- **D2. Combos con productos de puntos distintos:** el modelo actual retira un combo completo en un solo punto. Si algún local necesita partirlo, habría que dividir sus componentes en partes.
- **D3. Plazo de retención del `raw` de pagos y notificaciones.**
