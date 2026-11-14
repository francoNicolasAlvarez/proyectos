# Rendimiento

Medido el **14/11/2026** contra PostgreSQL 17.2 **real** con 100.000 pedidos históricos, el filtro de seguridad por fila (RLS) activo y el rol de la aplicación, igual que en producción. Cómo repetirlo: `pnpm run perf` dentro de `apps/api` (solo corre sobre una base cuyo nombre termina en `_test`, porque reinicia el esquema; variables opcionales `PERF_HISTORY`, `PERF_ORDERS`, `PERF_CONCURRENCY`).

> **Advertencia sobre los números:** la API, la prueba de carga y PostgreSQL comparten los núcleos de una misma PC de escritorio, y las conexiones son locales (sin latencia de red). Sirven para comparar antes y después y para detectar cuellos de botella, **no** para dimensionar producción. Hay que repetirlas en el hosting real.

## Hallazgos y correcciones

| # | Hallazgo | Evidencia | Corrección |
|---|---|---|---|
| 1 | **Faltaban índices en las claves foráneas compuestas.** PostgreSQL no crea el índice del lado que referencia. | "Pedidos abiertos de una persona" (se ejecuta en **cada** pedido nuevo): **269 ms** con un Seq Scan de 100.800 ítems. "Ítems de la cola del local": **261 ms**. | Migración `0003_foreign_key_indexes.sql` (14 índices). Resultado: **0,35 ms** y **5,5 ms**. |
| 2 | **Cola detrás del bloqueo por local.** El bloqueo de `tenant_settings` (que serializa cupo, límite por persona y numeración) se tomaba *antes* de leer el catálogo. | Un pedido solo tarda ~11 ms, pero con 5 clientes simultáneos la mediana subía a 49 ms y con 20 a 222 ms: espera pura en fila. | `createOrder` hace primero todas las lecturas de catálogo, punto de retiro y origen, y toma el bloqueo solo para lo serializable. |
| 3 | La prueba contaba la apertura de conexiones nuevas (autenticación scram, ≥100 ms cada una). | p95 inflado en la primera ráfaga. | Calentamiento del pool antes de medir. |

## Antes y después (creación de pedidos, un solo local, 2 líneas en 2 puntos de retiro)

| Clientes simultáneos | Antes: mediana / p95 / pedidos por segundo | Después |
|---|---|---|
| 1 | 11 ms / 205 ms (arranque en frío) / 37 | 11 ms / 15 ms / 71 |
| 5 | 49 ms / 185 ms / 63 | **34 ms / 66 ms / 131** |
| 20 | 213 ms / 605 ms / 77 | **138 ms / 341 ms / 118** |
| 50 | — | 459 ms / 1.237 ms / 73 (el equipo de prueba se satura) |

Otras operaciones (400 pedidos abiertos): confirmar un pago 33 ms mediana (513 por segundo); cola del local 112 ms (de 126); menú público de 200 productos 30 ms.

## Qué significa en la práctica

Un local procesa del orden de **120 pedidos por segundo** (≈7.000 por minuto), muy por encima de lo necesario: un festival muy concurrido ronda decenas por minuto. El techo es por local, porque el bloqueo es por local; varios locales no se frenan entre sí.

## Pendiente y recomendaciones (no aplicadas: sin evidencia todavía)

- **Medir en el hosting real**, con la API y la base en máquinas separadas y latencia de red de por medio. Cada ida y vuelta a la base pesa mucho más que en esta PC.
- **Agrupador de conexiones (PgBouncer)** si hay varias instancias de la API; dimensionar el pool (`max`) contra `max_connections` de la base.
- **Insertar los ítems de un pedido en una sola sentencia** (hoy es una por ítem y una por selección): reduce las idas y vueltas dentro del bloqueo. Vale la pena si en el hosting real la latencia a la base supera ~2 ms.
- **Particionar o archivar `orders`** (por mes) cuando pase de decenas de millones de filas. Con 100.000 las consultas calientes ya tardan menos de 6 ms.
- **Cola del local:** 112 ms con 400 pedidos abiertos es aceptable; si el panel la pide cada segundo conviene empujar solo cambios por SSE en lugar de repetir la consulta completa.
