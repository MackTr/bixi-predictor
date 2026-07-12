# BIXI Predictor — when will station 345 run out?

Nightly run-out prediction for BIXI station 345 (Regina / de Verdun), on Cloudflare Workers + D1.
Every night at 9pm Montreal time it predicts what time the station will run out of usable bikes
**tomorrow** — weighing historical run-outs by day-of-week, Quebec holidays, morning weather
(Open-Meteo) and recency — stores the prediction with its full reasoning basis, tracks accuracy
against what actually happened, and sends a Web Push notification to the
[bixi-monitor](https://github.com/MackTr/bixi-monitor) dashboard installed as a Home-Screen app.

Client #2 of bixi-monitor's `/api/v1` (it never touches the monitor's database). The model is a
pure-TypeScript similarity-weighted estimate — no ML, every prediction ships with the days it was
based on. See [docs/api.md](docs/api.md) for the API contract.

## Develop locally
```bash
npm install
npm run db:migrate:local      # create tables in the local D1
npx web-push generate-vapid-keys   # once; put both keys in .dev.vars
cat > .dev.vars <<'EOF'
ADMIN_TOKEN = "dev-token"
VAPID_PUBLIC_KEY = "<public>"
VAPID_PRIVATE_KEY = "<private>"
EOF
npm run dev                   # wrangler dev -> http://localhost:8788
```
Dev talks to the **live** monitor API (public, read-only), so real history is available locally:
```bash
curl -X POST -H "Authorization: Bearer dev-token" "http://localhost:8788/api/v1/admin/backfill?days=20"
curl -X POST -H "Authorization: Bearer dev-token" "http://localhost:8788/api/v1/admin/run"
curl "http://localhost:8788/api/v1/stations/345/prediction"
```

## Deploy (free Cloudflare account)
```bash
npx wrangler d1 create bixi_predictor   # paste the printed database_id into wrangler.toml
npm run db:migrate
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put ADMIN_TOKEN     # e.g. openssl rand -hex 24
npm run deploy                          # crons start automatically
```
Then backfill once (`POST /api/v1/admin/backfill?days=20` with the Bearer token) and subscribe from
the dashboard on the phone.

## Layout
- `src/pipeline.ts` — nightly orchestration (sync → weather → finalize → predict → push)
- `src/model.ts` — the similarity-weighted estimator (pure, explainable)
- `src/sync.ts` — monitor API → per-day run-out facts
- `src/weather.ts` — Open-Meteo forecast + archive → morning-window aggregates
- `src/push.ts` + `src/webpush.ts` — Web Push: hand-rolled VAPID + aes128gcm (RFC 8291) on WebCrypto
  (the npm WebCrypto push libs still emit the pre-standard `aesgcm` encoding, which Apple rejects)
- `src/api.ts` — `/api/v1` router + CORS
- `src/worker.ts` — `scheduled()` (9pm local guard) + `fetch()` entrypoint
