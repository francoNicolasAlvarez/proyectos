# Pasamanos

Plataforma web (PWA) de pedidos y autoservicio para locales gastronómicos, bares, pubs y eventos: el cliente pide y paga desde su celular y solo se acerca a retirar.

**Estado:** diseño completo, núcleo de negocio y base de datos implementados y probados; la API HTTP está completa para el MVP; faltan los frontends reales (hoy hay prototipos navegables). Ver el [informe de avance](docs/progress-report.md).

## Documentación

- [Informe de avance](docs/progress-report.md) (empezar por acá)
- [Análisis funcional](docs/functional-analysis.md)
- [Arquitectura técnica](docs/architecture.md)
- [Diseño de base de datos](docs/database-design.md)
- [Diseño UX y sistema de diseño](docs/ux/design-system.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)
- [Matriz de escenarios de prueba](docs/test-scenarios.md)
- [Frontend (app del cliente)](docs/frontend.md)
- [Rendimiento medido](docs/performance.md)
- [Planes, suscripción y promociones (propuesta)](docs/negocio/planes-y-ventas.md)

## Estructura

```
apps/api            servicios de negocio, migraciones y pruebas contra PostgreSQL real
apps/web            app del cliente (React + Vite + TypeScript, PWA)
apps/e2e            pruebas E2E y de accesibilidad (Playwright): prototipos y app real
packages/shared     dominio puro: estados, precios, partes de retiro, capacidad, permisos
packages/ui         logo y recursos de marca
docs/ux/prototype   prototipos navegables del cliente y del panel del local
docs/  infra/
```

## Pruebas

Requiere Node 20+ y pnpm 9. No hace falta Docker (las pruebas de base de datos usan PGlite).

```
pnpm install
pnpm --filter @pasamanos/e2e exec playwright install chromium   # una sola vez
pnpm typecheck
pnpm test
```

## Pagos

Con `PAYMENTS_MODE=simulated` (por defecto en desarrollo) el cobro usa un proveedor falso: al pagar, el cliente llega a una página de
desarrollo con "Aprobar pago" y "Rechazar pago", y el pago pasa por el **mismo** procesamiento de webhook que uno real. Sirve para
recorrer todo el flujo sin Mercado Pago. El servidor se niega a arrancar así con `NODE_ENV=production`.

Para probar con Mercado Pago real: poner `MP_TEST_ACCESS_TOKEN` en `.env`, ejecutar `pnpm run db:connect-mp` y arrancar con
`PAYMENTS_MODE=mercadopago` y `PUBLIC_API_URL` apuntando a una dirección pública (un túnel), configurada también como URL de
notificaciones en la aplicación de Mercado Pago. Creación del cobro, pago, aviso y reembolso reales se verificaron con cuentas de prueba (ver `docs/progress-report.md`); la validación de la firma con la clave secreta real todavía no.

## App del cliente (apps/web)

```
pnpm --filter @pasamanos/api start        # API en :3000 (necesita .env y PostgreSQL local)
pnpm --filter @pasamanos/web dev          # app en http://localhost:5173 (reenvía /api a la API)
pnpm --filter @pasamanos/e2e test:web     # E2E de la app real: levanta una API de prueba en memoria, sin .env
```

Detalles y estado en [docs/frontend.md](docs/frontend.md).

## Ver los prototipos

Abrir `docs/ux/prototype/customer-app/index.html` y `docs/ux/prototype/venue-panel/index.html` en dos pestañas del mismo navegador: comparten los pedidos.

## Base de datos local y servidor

PostgreSQL 17 local, sin administrador ni Docker (usa los binarios de `embedded-postgres`, copiados a una ruta corta
porque dentro de `node_modules` la ruta supera los 260 caracteres de Windows).

```
pnpm install
cp .env.example .env                      # completar DATABASE_URL, MIGRATION_DATABASE_URL, TEST_DATABASE_URL y los secretos
powershell -File infra/local-postgres.ps1 setup   # una sola vez: copia binarios e inicializa
powershell -File infra/local-postgres.ps1 start   # cada vez que se reinicie la PC
cd apps/api
pnpm run db:setup                         # crea bases, aplica las migraciones pendientes, fija contraseñas y las exige
pnpm run db:seed                          # local de demostración "el-faro", una cuenta por rol y su cuenta de cobro simulada
pnpm run start                            # API en http://localhost:3000
```

Pruebas contra PostgreSQL real con varias conexiones (solo corren sobre bases cuyo nombre termina en `_test`, porque reinician el esquema):

```
TEST_DATABASE_URL=postgres://postgres:CONTRASEÑA@localhost:5432/pedidos_test pnpm exec vitest run test/postgres.integration.test.ts
```

Las cuentas de demostración usan la contraseña de prueba definida en `apps/api/scripts/seed-demo.ts` (solo desarrollo).
