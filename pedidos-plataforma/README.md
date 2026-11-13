# Pedidos Plataforma

Plataforma web (PWA) de pedidos y autoservicio para locales gastronómicos, bares, pubs y eventos: el cliente pide y paga desde su celular y solo se acerca a retirar.

**Estado:** diseño (etapas 1 a 3 completas, sin código de aplicación todavía).

## Documentación

- [Análisis funcional](docs/functional-analysis.md)
- [Arquitectura técnica](docs/architecture.md)
- [Diseño de base de datos](docs/database-design.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)

## Estructura prevista

```
apps/api  apps/customer-app  apps/venue-panel
packages/shared  packages/ui  packages/config
docs/  infra/
```

## Desarrollo local

Requiere Node 20+, pnpm y Docker.

```
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm install
```
