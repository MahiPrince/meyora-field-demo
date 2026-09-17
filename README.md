# Meyora Field Demo

Conversational Field Service demo backend for Maya Iyer.

V1 is intentionally chat-first and static: no simulator engine. Relative terms such as "today" resolve to the authored demo date in `demo_meta.demo_context`.

## Endpoints
- `GET /health`
- `GET /me`
- `GET /my-day`
- `GET /context/work-order/{work_order_id}`

The service seeds Render Postgres idempotently on startup when `DATABASE_URL` is configured.
