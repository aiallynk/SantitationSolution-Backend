# EcoVision Backend (Sanitation Monitoring Demo)

Node.js + Express + Sequelize backend for Monday sanitation demo flow:

1. Worker logs in
2. Worker submits `before` and `after` toilet images
3. Images are uploaded to Cloudinary
4. Background simulated AI processing computes scores/findings
5. Admin dashboard consumes summary, trends, heatmap, zones, alerts, and inspection details

## Tech Stack
- Node.js (CommonJS)
- Express
- MySQL + Sequelize
- JWT Auth
- Multer
- Cloudinary

## Run Locally
1. Install dependencies:
```bash
npm install
```
2. Copy env file and configure values:
```bash
cp .env.example .env
```
3. Ensure MySQL DB exists (default: `ecovision`).
4. Start server:
```bash
node src/server.js
```

The server runs at `http://localhost:5000`.

## Environment Variables
Required:
- `PORT`
- `NODE_ENV`
- `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `JWT_SECRET`, `JWT_EXPIRES_IN`

Optional demo controls:
- `SEED_DEMO_DATA=true|false` (default `true`)
- `DEMO_MIN_INSPECTIONS=12`

## Seeded Demo Users
Created idempotently on startup:
- Admin: `admin / admin123`
- Worker 1: `worker1 / worker123`
- Worker 2: `worker2 / worker123`

Idempotent demo seeding also keeps at least 12 inspections (mixed status/severity across Nashik-like zones) and baseline alerts.

## API Response Format
Success:
```json
{
  "status": "success",
  "message": "...",
  "data": {},
  "meta": {}
}
```

Error:
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": ["..."]
}
```

## Auth APIs
- `POST /auth/login`
- `GET /auth/me` (ADMIN/WORKER)

## Inspection APIs
- `POST /inspections/upload` (WORKER, legacy single image via `image` field)
- `POST /inspections/submit` (WORKER, new paired flow)
  - multipart fields: `beforeImage`, `afterImage`, `toiletCode`, `toiletName`, `city`, `ward`, `zone`, `sector`, `latitude`, `longitude`, `remarks`
- `GET /inspections` (ADMIN, filters + pagination)
  - query: `status`, `severity`, `zone`, `ward`, `page`, `limit`
- `GET /inspections/recent` (ADMIN)
- `GET /inspections/:id` (ADMIN)
- `GET /inspections/my` (WORKER)

## Analytics APIs (ADMIN)
- `GET /analytics/summary`
- `GET /analytics/alerts`
- `GET /analytics/heatmap`
- `GET /analytics/trends?days=7`
- `GET /analytics/zones`
- `GET /analytics/critical`
- `PATCH /analytics/alerts/:id/acknowledge`

## Processing Lifecycle
Inspection statuses:
- `pending`
- `processing`
- `completed`
- `failed`

Background simulation behavior:
- waits 2–5 seconds
- computes `scoreBefore`, `scoreAfter`, `improvementScore`, `overallScore`
- builds metric breakdown (`floorCleanliness`, `wallCleanliness`, `wetnessControl`, `litterControl`, `odourRisk`)
- generates findings list
- sets severity (`critical`, `poor`, `moderate`, `good`, `excellent`)
- opens alert for low outcomes (`overallScore <= 60` or `scoreAfter <= 60`)

## Demo Flow Summary
1. Login as worker and call `POST /inspections/submit`.
2. Receive immediate success with `inspectionId` and image URLs.
3. Wait a few seconds and fetch `GET /inspections/my` or admin `GET /inspections/:id`.
4. Login as admin and open analytics endpoints for dashboard KPIs and feeds.

## Notes
- Existing login and legacy upload endpoint remain supported.
- This backend is demo-focused simulated processing, not production ML inference.
