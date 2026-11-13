-- Pasamanos: esquema inicial (Etapa 3). Ver docs/database-design.md.
-- Convenciones: dinero en centavos, estados como text + CHECK, tenant_id en toda tabla de negocio,
-- claves foráneas compuestas (tenant_id, id) y Row-Level Security.

------------------------------------------------------------------
-- Roles y funciones de contexto
------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Contexto fijado por la aplicación en cada transacción (set_config(..., true)).
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
-- Solo el servidor lo activa, tras verificar users.is_platform_admin.
CREATE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.is_admin', true), '') = 'on' $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

------------------------------------------------------------------
-- Identidad y plataforma (sin tenant_id)
------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  name text NOT NULL,
  phone text,
  email_verified_at timestamptz,
  adult_declared_at timestamptz,
  is_platform_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  no_show_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  timezone text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  currency char(3) NOT NULL DEFAULT 'ARS',
  description text,
  logo_url text,
  brand_color_1 text,
  brand_color_2 text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_slug_uq ON tenants (lower(slug));

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  monthly_price_cents bigint NOT NULL CHECK (monthly_price_cents >= 0),
  features jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cancellation_reasons (
  code text PRIMARY KEY,
  label text NOT NULL
);
INSERT INTO cancellation_reasons (code, label) VALUES
  ('out_of_stock', 'Producto sin disponibilidad'),
  ('missing_ingredients', 'Falta de ingredientes'),
  ('capacity_exceeded', 'Capacidad operativa excedida'),
  ('venue_closed', 'Establecimiento temporalmente cerrado'),
  ('technical_issue', 'Problemas técnicos'),
  ('other', 'Otro motivo');

------------------------------------------------------------------
-- Tenancy y configuración del local
------------------------------------------------------------------
CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'order_operator', 'pickup_operator')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans (id),
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  ordering_paused boolean NOT NULL DEFAULT false,
  pause_message text,
  pickup_mode text NOT NULL DEFAULT 'single_point' CHECK (pickup_mode IN ('single_point', 'per_item')),
  acceptance_mode text NOT NULL DEFAULT 'manual' CHECK (acceptance_mode IN ('manual', 'auto')),
  acceptance_timeout_seconds integer NOT NULL DEFAULT 300 CHECK (acceptance_timeout_seconds > 0),
  max_concurrent_orders integer CHECK (max_concurrent_orders > 0),
  max_orders_per_interval integer CHECK (max_orders_per_interval > 0),
  interval_minutes integer CHECK (interval_minutes > 0),
  pickup_deadline_minutes integer CHECK (pickup_deadline_minutes > 0),
  default_prep_minutes integer NOT NULL DEFAULT 10 CHECK (default_prep_minutes >= 0),
  id_check_on_pickup boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('card_online', 'payment_app', 'cash_on_pickup', 'card_on_pickup')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, method)
);

CREATE TABLE tenant_payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('mercadopago')),
  provider_account_id text NOT NULL,
  access_token_enc text NOT NULL,   -- cifrado en la aplicación; nunca se expone por la API
  refresh_token_enc text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider),
  UNIQUE (provider, provider_account_id)
);

-- Directorio sin datos sensibles (sin RLS): permite resolver a qué local pertenece una cuenta del proveedor
-- cuando llega un webhook, antes de conocer el tenant. Se mantiene solo desde tenant_payment_accounts.
CREATE TABLE provider_account_directory (
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_account_id)
);
CREATE FUNCTION sync_provider_directory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM provider_account_directory WHERE provider = OLD.provider AND provider_account_id = OLD.provider_account_id;
    RETURN OLD;
  END IF;
  INSERT INTO provider_account_directory (provider, provider_account_id, tenant_id)
  VALUES (NEW.provider, NEW.provider_account_id, NEW.tenant_id)
  ON CONFLICT (provider, provider_account_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_provider_directory AFTER INSERT OR UPDATE OR DELETE ON tenant_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION sync_provider_directory();

CREATE TABLE opening_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at time NOT NULL,
  closes_at time NOT NULL,   -- puede ser menor que opens_at (cierre pasada la medianoche)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pickup_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX pickup_points_one_default ON pickup_points (tenant_id) WHERE is_default AND active;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  orders_open_at timestamptz,
  orders_close_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, id)
);

CREATE TABLE locations (   -- sectores de origen: solo informativos
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'sector' CHECK (kind IN ('table', 'bar', 'sector', 'other')),
  qr_token text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  event_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES events (tenant_id, id)
);

------------------------------------------------------------------
-- Catálogo
------------------------------------------------------------------
CREATE TABLE menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'event')),
  event_id uuid,
  is_default boolean NOT NULL DEFAULT false,
  valid_from timestamptz,
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES events (tenant_id, id),
  CHECK (kind = 'event' OR event_id IS NULL)
);
CREATE UNIQUE INDEX menus_one_default ON menus (tenant_id) WHERE is_default AND active;

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  menu_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false,
  pickup_point_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_id) REFERENCES menus (tenant_id, id),
  FOREIGN KEY (tenant_id, pickup_point_id) REFERENCES pickup_points (tenant_id, id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  ingredients text,
  image_url text,
  base_price_cents bigint NOT NULL CHECK (base_price_cents >= 0),
  prep_minutes integer NOT NULL DEFAULT 5 CHECK (prep_minutes >= 0),
  kind text NOT NULL DEFAULT 'simple' CHECK (kind IN ('simple', 'combo')),
  available boolean NOT NULL DEFAULT true,
  pickup_point_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, pickup_point_id) REFERENCES pickup_points (tenant_id, id)
);
CREATE INDEX products_by_category ON products (tenant_id, category_id) WHERE archived_at IS NULL;

CREATE TABLE option_groups (   -- variantes (min = max = 1) y agregados
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  name text NOT NULL,
  min_select integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_select <= max_select),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  name text NOT NULL,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES option_groups (tenant_id, id)
);

CREATE TABLE combo_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  combo_product_id uuid NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, combo_product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE combo_slot_products (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  slot_id uuid NOT NULL,
  product_id uuid NOT NULL,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (slot_id, product_id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES combo_slots (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

------------------------------------------------------------------
-- Pedidos
------------------------------------------------------------------
CREATE TABLE order_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  counter_date date NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, counter_date)
);

-- Número visible de pedido por local y día. Atómico bajo concurrencia.
CREATE FUNCTION next_order_number(p_tenant uuid, p_date date) RETURNS integer LANGUAGE sql AS $$
  INSERT INTO order_counters (tenant_id, counter_date, last_number) VALUES (p_tenant, p_date, 1)
  ON CONFLICT (tenant_id, counter_date) DO UPDATE SET last_number = order_counters.last_number + 1
  RETURNING last_number
$$;

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  order_number integer NOT NULL,
  counter_date date NOT NULL,
  origin_location_id uuid,                 -- ORIGEN informativo, nunca destino de entrega
  origin_location_name_snapshot text,
  event_id uuid,
  operational_status text NOT NULL DEFAULT 'awaiting_payment' CHECK (operational_status IN
    ('awaiting_payment', 'pending_acceptance', 'accepted', 'preparing', 'ready', 'delivered', 'rejected', 'cancelled', 'not_picked_up')),
  payment_timing text NOT NULL DEFAULT 'prepaid' CHECK (payment_timing IN ('prepaid', 'on_pickup')),
  payment_method text NOT NULL CHECK (payment_method IN ('card_online', 'payment_app', 'cash_on_pickup', 'card_on_pickup')),
  payment_status text NOT NULL DEFAULT 'pending',
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  estimated_ready_at timestamptz,
  notes text,
  idempotency_key text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason_code text REFERENCES cancellation_reasons (code),
  cancel_reason_text text,
  cancelled_by text CHECK (cancelled_by IN ('customer', 'staff', 'system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, counter_date, order_number),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (tenant_id, origin_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES events (tenant_id, id),
  CONSTRAINT payment_status_matches_timing CHECK (
    (payment_timing = 'prepaid' AND payment_status IN
      ('pending', 'approved', 'rejected', 'expired', 'refund_pending', 'refunded', 'partially_refunded'))
    OR
    (payment_timing = 'on_pickup' AND payment_status IN ('pending_collection', 'collected_on_pickup', 'not_collected'))
  ),
  CONSTRAINT method_matches_timing CHECK (
    (payment_timing = 'prepaid' AND payment_method IN ('card_online', 'payment_app'))
    OR (payment_timing = 'on_pickup' AND payment_method IN ('cash_on_pickup', 'card_on_pickup'))
  )
);
CREATE INDEX orders_queue ON orders (tenant_id, operational_status, placed_at);
CREATE INDEX orders_by_user ON orders (user_id, placed_at DESC);
CREATE INDEX orders_active ON orders (tenant_id, placed_at)
  WHERE operational_status IN ('pending_acceptance', 'accepted', 'preparing', 'ready');

-- Toda orden tiene al menos una parte; en modo single_point hay exactamente una.
CREATE TABLE order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  pickup_point_id uuid,    -- NULL hasta que el empleado lo asigna (decisión D1)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preparing', 'ready', 'delivered', 'not_picked_up', 'cancelled')),
  ready_at timestamptz,
  delivered_at timestamptz,
  delivered_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, pickup_point_id) REFERENCES pickup_points (tenant_id, id)
);
CREATE INDEX order_parts_by_point ON order_parts (tenant_id, pickup_point_id, status);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  order_part_id uuid NOT NULL,
  product_id uuid,   -- referencia informativa; los datos vigentes son los snapshots
  name_snapshot text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL CHECK (quantity >= 1),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0),
  prep_minutes_snapshot integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_part_id) REFERENCES order_parts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE order_item_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('option', 'combo_choice')),
  group_name_snapshot text NOT NULL,
  name_snapshot text NOT NULL,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE order_status_history (   -- solo inserción
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  order_part_id uuid,
  axis text NOT NULL CHECK (axis IN ('operational', 'payment', 'part')),
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('customer', 'staff', 'system', 'provider')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE
);

------------------------------------------------------------------
-- Pagos
------------------------------------------------------------------
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  provider text NOT NULL,
  provider_payment_id text,
  status text NOT NULL DEFAULT 'pending',
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  method_detail text,
  raw jsonb,
  approved_at timestamptz,
  collected_by uuid REFERENCES users (id),
  collected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_payment_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);
CREATE INDEX payments_by_order ON payments (order_id);
CREATE INDEX payments_by_status ON payments (tenant_id, status);

-- tenant_id se resuelve al recibir el webhook (cada local tiene su propia cuenta de Mercado Pago).
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  UNIQUE (provider, provider_event_id)   -- deduplicación de webhooks
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_refund_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  requested_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id)
);

------------------------------------------------------------------
-- Retiro
------------------------------------------------------------------
CREATE TABLE pickup_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_part_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,   -- solo se guarda el hash del token del QR
  short_code text NOT NULL,
  expires_at timestamptz,
  used_at timestamptz,
  used_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_part_id) REFERENCES order_parts (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX pickup_tokens_active_code ON pickup_tokens (tenant_id, short_code) WHERE used_at IS NULL;

------------------------------------------------------------------
-- Notificaciones, outbox y auditoría
------------------------------------------------------------------
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (   -- solo inserción
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users (id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

------------------------------------------------------------------
-- updated_at automático
------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', 'trg_' || t || '_updated', t);
  END LOOP;
END $$;

------------------------------------------------------------------
-- Row-Level Security
------------------------------------------------------------------
-- Aislamiento por local (y acceso total solo para el administrador de plataforma).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_subscriptions', 'tenant_settings', 'tenant_payment_methods', 'tenant_payment_accounts', 'opening_hours',
    'pickup_points', 'events', 'locations', 'menus', 'categories', 'products', 'option_groups', 'options',
    'combo_slots', 'combo_slot_products', 'order_counters', 'payments', 'payment_events', 'refunds',
    'pickup_tokens', 'outbox_events', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant() OR app_is_admin()) WITH CHECK (tenant_id = app_tenant() OR app_is_admin())', t);
  END LOOP;
END $$;

-- Tokens de retiro: el cliente puede LEER los de sus pedidos (para mostrar su QR); nunca modificarlos.
CREATE POLICY customer_read ON pickup_tokens FOR SELECT USING (order_part_id IN (SELECT id FROM order_parts));

-- Pedidos: el local los ve por tenant; el cliente, los suyos en todos los locales.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_access ON orders
  USING (tenant_id = app_tenant() OR user_id = app_user() OR app_is_admin())
  WITH CHECK (tenant_id = app_tenant() OR user_id = app_user() OR app_is_admin());

-- Tablas hijas del pedido: heredan la visibilidad del pedido (el cliente ve las de sus pedidos).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['order_parts', 'order_items', 'order_status_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_order ON %I USING (tenant_id = app_tenant() OR app_is_admin() OR order_id IN (SELECT id FROM orders)) WITH CHECK (tenant_id = app_tenant() OR app_is_admin())', t);
  END LOOP;
END $$;
ALTER TABLE order_item_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY via_item ON order_item_selections
  USING (tenant_id = app_tenant() OR app_is_admin() OR order_item_id IN (SELECT id FROM order_items))
  WITH CHECK (tenant_id = app_tenant() OR app_is_admin());

-- Membresías: el local ve las suyas; cada usuario ve las propias (para elegir con qué local trabajar).
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_access ON tenant_memberships
  USING (tenant_id = app_tenant() OR user_id = app_user() OR app_is_admin())
  WITH CHECK (tenant_id = app_tenant() OR app_is_admin());

-- Notificaciones: del usuario, o del local si están dirigidas a él.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_access ON notifications
  USING (user_id = app_user() OR app_is_admin())
  WITH CHECK (user_id = app_user() OR tenant_id = app_tenant() OR app_is_admin());

------------------------------------------------------------------
-- Permisos del rol de la aplicación
------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;
-- Tablas de solo inserción: ni siquiera la aplicación puede modificar o borrar el historial.
REVOKE UPDATE, DELETE ON audit_log, order_status_history FROM app_runtime;
-- La lista de motivos es un catálogo: la aplicación solo la lee.
REVOKE INSERT, UPDATE, DELETE ON cancellation_reasons FROM app_runtime;
