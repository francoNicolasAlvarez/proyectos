# Pasamanos

Plataforma web (PWA) de pedidos y autoservicio para locales gastronómicos, bares, pubs y eventos: el cliente pide y paga desde su celular y solo se acerca a retirar.

**Estado:** diseño completo, núcleo de negocio y base de datos implementados y probados; falta la capa HTTP y los frontends reales. Ver el [informe de avance](docs/progress-report.md).

## Documentación

- [Informe de avance](docs/progress-report.md) (empezar por acá)
- [Análisis funcional](docs/functional-analysis.md)
- [Arquitectura técnica](docs/architecture.md)
- [Diseño de base de datos](docs/database-design.md)
- [Diseño UX y sistema de diseño](docs/ux/design-system.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)

## Estructura

```
apps/api            servicios de negocio, migraciones y pruebas contra PostgreSQL real
apps/e2e            pruebas E2E y de accesibilidad (Playwright)
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

## Ver los prototipos

Abrir `docs/ux/prototype/customer-app/index.html` y `docs/ux/prototype/venue-panel/index.html` en dos pestañas del mismo navegador: comparten los pedidos.

## Desarrollo local

```
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
```
