-- Índices que faltaban en las claves foráneas compuestas y en consultas calientes.
-- Medido con 100.000 pedidos históricos (apps/api/scripts/perf.ts): sin estos índices, "pedidos abiertos de una persona"
-- (se ejecuta en CADA pedido nuevo) y "ítems de la cola del local" hacían un Seq Scan de todos los ítems (≈265 ms cada una).
-- PostgreSQL no crea índices automáticos del lado que referencia en una clave foránea.

-- Pedido → partes → ítems → selecciones
CREATE INDEX order_items_by_order ON order_items (tenant_id, order_id);
CREATE INDEX order_items_by_part ON order_items (tenant_id, order_part_id);
CREATE INDEX order_parts_by_order ON order_parts (tenant_id, order_id);
CREATE INDEX order_item_selections_by_item ON order_item_selections (tenant_id, order_item_id);
CREATE INDEX order_status_history_by_order ON order_status_history (tenant_id, order_id, created_at);

-- Retiro y reembolsos
CREATE INDEX pickup_tokens_by_part ON pickup_tokens (tenant_id, order_part_id);
CREATE INDEX refunds_by_payment ON refunds (tenant_id, payment_id);
CREATE INDEX refunds_pending ON refunds (created_at) WHERE status = 'pending';   -- lo recorre el trabajador cada 30 s

-- Catálogo (menú público)
CREATE INDEX option_groups_by_product ON option_groups (tenant_id, product_id);
CREATE INDEX options_by_group ON options (tenant_id, group_id);
CREATE INDEX categories_by_menu ON categories (tenant_id, menu_id) WHERE archived_at IS NULL;

-- Cuenta y consulta
CREATE INDEX tenant_memberships_by_user ON tenant_memberships (user_id) WHERE active;   -- "¿con qué locales trabaja esta persona?"
CREATE INDEX notifications_by_user ON notifications (user_id, seq DESC);
CREATE INDEX audit_log_by_tenant ON audit_log (tenant_id, created_at DESC);
