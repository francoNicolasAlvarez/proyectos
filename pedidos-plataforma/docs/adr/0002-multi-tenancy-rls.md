# ADR 0002: Multi-tenant con esquema compartido y RLS

**Estado:** aceptada

**Decisión:** una base de datos, un esquema, `tenant_id` en toda tabla de negocio y Row-Level Security de PostgreSQL. El tenant se fija por request desde la sesión (nunca desde parámetros del cliente). El rol de la aplicación no tiene `BYPASSRLS`. Claves foráneas compuestas `(tenant_id, id)` impiden referencias entre locales.

**Alternativas descartadas:** esquema o base por tenant (migraciones y operación más complejas sin necesidad a esta escala).

**Consecuencias:** el aislamiento no depende solo del código de la aplicación. Cada consulta corre dentro de una transacción que fija el contexto. Los tests de aislamiento son obligatorios en CI.
