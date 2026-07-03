# Sanitation Backend API

Express + Sequelize backend for the unified sanitation platform.

## Stack

- Node.js + Express 5
- Sequelize ORM
- PostgreSQL (source of truth)
- BullMQ + Redis (optional async queue)
- Cloudinary storage adapter (with local fallback)
- SSE live stream

## Quick Start

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Server defaults to `http://localhost:5000`.

- API base: `http://localhost:5000/api/v1`
- Swagger docs: `http://localhost:5000/docs`
- Health: `http://localhost:5000/health`

## Key Scripts

```bash
npm run dev
npm run start
npm run test
npm run db:migrate
npm run db:rollback
npm run db:seed
npm run db:seed:rbac
npm run db:seed:undo
npm run seed:simulator
```

## Render Deployment

- Blueprint file is available in this backend root: [`render.yaml`](./render.yaml)
- Health endpoint for Render checks: `/health`
- `preDeployCommand` runs migrations (`npm run db:migrate`)

Recommended production env values:

- `NODE_ENV=production`
- `DB_SSL=true`
- `AUTO_RUN_MIGRATIONS=false` (migrate in pre-deploy)
- `CORS_ORIGIN=https://*.vercel.app,https://<your-domain>`
- `API_PUBLIC_BASE_URL=https://<your-render-service>.onrender.com`
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` for push notifications
- `REDIS_REQUIRED_IN_PROD=false` (set `true` only when Redis is configured and reachable)

## Domain Modules

- Auth/session: login, refresh, logout, forgot/reset, `/me`
- Users/RBAC: users, roles, permissions, scoped guards
- Platform hierarchy: tenants, geographies, facilities, blocks, units
- Operations: tasks, inspections, complaints, notifications
- Media: upload-init/upload-complete/get/delete
- Analysis: async inspection scoring + result retrieval
- Sensors: ingestion, readings, facility live metrics
- Alerts: list/get/acknowledge/resolve + live feed
- Dashboard: overview, map, heatmap, trends, facility drilldown, workforce, SLA
- Super Admin: tenant/global platform metrics and controls
- Reports: filtered endpoints and export contract
- Audit logs: privileged action tracking

## Environment

Use `.env.example` as the source for required variables. Main groups:

- API/security (`JWT_*`, CORS, rate limits)
- PostgreSQL (`DATABASE_URL` preferred)
- Storage (`CLOUDINARY_*`, file size)
- Queue (`REDIS_*`, queue attempts/backoff)
- Live updates (`SSE_HEARTBEAT_MS`)
- Analysis and sensor thresholds
- Simulator credentials

## Seed Accounts

Password (default): `11111111`
Override with env: `DEFAULT_SEED_PASSWORD` (or `PERSONA_SEED_PASSWORD`)

- `superadmin@platform.gov`
- `tenantadmin@nmc.gov.in`
- `supervisor@nmc.gov.in`
- `worker1@nmc.gov.in`

## Notes

- Legacy route aliases are still mounted for compatibility during transition.
- For local device simulation, run `npm run seed:simulator` after backend boot.
