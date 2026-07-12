# BIXI Predictor API — `/api/v1`

JSON over HTTPS, **CORS open** (`Access-Control-Allow-Origin: *`). Timestamps are ISO-8601 UTC;
times-of-day are minutes-since-local-midnight plus `"HH:MM"` (America/Toronto). The station id is
in the path, so more stations can be added without breaking this contract.

Base URL: `https://bixi-predictor.<subdomain>.workers.dev/api/v1` (or `http://localhost:8788/api/v1` in dev).

This service is **client #2** of [bixi-monitor](https://github.com/MackTr/bixi-monitor)'s API: it
pulls observation history over HTTP (never the monitor's D1), digests it into per-day facts, joins
Open-Meteo weather, and predicts what time the station runs out of usable bikes tomorrow. A run-out
is the day's first usable-bikes `>0 → ≤0` transition — the same definition the monitor dashboard uses.

## Endpoints

### `GET /health`
`ok` means last night's pipeline produced a prediction for today or later.
```json
{ "ok": true, "latestTargetDate": "2026-07-11", "latestCreatedAt": "2026-07-11T01:00:05Z",
  "featureDays": 20, "latestFeatureDate": "2026-07-10", "weatherDays": 21,
  "subscriptions": 1, "serverTime": "2026-07-11T02:00:00Z" }
```

### `GET /stations/{id}/prediction[?date=YYYY-MM-DD]`
Latest prediction (or the one for an exact target date). 404 until the first nightly run.
`willRunOut` is `null` when the model had too little data; `probability < 0.5` ⇒ `willRunOut: false`
with `predicted: null` (the median it would have picked is kept in `basis.medianEvenIfUnlikely`).
`window` is the weighted P25–P75 of similar days' run-out times. `basis` explains the estimate:
fallback level (0 = full kernels, 1 = weather dropped, 2 = day-type widened + inventory dropped),
effective sample size, the target context it compared against (`basis.target`, including
`startBikes` — tonight's 9pm inventory), and the top contributing days with their weights.
```json
{ "station": "345", "targetDate": "2026-07-11", "createdAt": "2026-07-11T01:00:05Z",
  "willRunOut": true, "probability": 0.86,
  "predicted": { "minutes": 460, "time": "07:40" },
  "window": { "early": "07:15", "late": "08:05" },
  "actual": null, "errorMinutes": null, "notifiedAt": "2026-07-11T01:00:06Z",
  "basis": { "fallbackLevel": 1, "effectiveN": 5.2, "historyDays": 14,
             "topDays": [ { "date": "2026-07-04", "weight": 0.94, "runoutMinutes": 452, "tempC": 21.3, "precipMm": 0 } ] } }
```

### `GET /stations/{id}/predictions?days=`
Prediction history, most recent target first (`days` 1–365, default 14), without `basis`. Once a
target day completes, `actual` and `errorMinutes` (predicted − actual) are filled in — the running
accuracy record.
```json
{ "station": "345", "count": 14, "predictions": [ { "targetDate": "2026-07-10", "willRunOut": true,
  "probability": 0.81, "predicted": { "minutes": 455, "time": "07:35" },
  "window": { "early": "07:20", "late": "07:55" },
  "actual": { "minutes": 464, "time": "07:44" }, "errorMinutes": -9 } ] }
```

### `GET /push/vapid-public-key`
```json
{ "key": "BPz..." }
```

### `POST /push/subscribe` · `POST /push/unsubscribe`
Body = the browser's `PushSubscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`), or just
`{ endpoint }` to unsubscribe. Subscribing twice upserts. Endpoints that answer 404/410 (removed
home-screen app) are pruned automatically on the next send.

### Admin (require `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /admin/backfill?days=N` — digest N days of monitor history + weather actuals (idempotent;
  skips already-complete days). Run once after first deploy. `&force=1` re-syncs complete days too
  (used to fill a newly added derived column for existing history).
- `POST /admin/run?push=0|1` — run the nightly pipeline now, bypassing the 9pm guard. `push`
  defaults to 0; even with `push=1` a target date is never notified twice.
- `POST /admin/test-push` — send a canned notification to every subscription.

## Nightly schedule

Both `0 1 * * *` and `0 2 * * *` UTC fire; only the one landing at **9pm America/Toronto** runs
(DST-proof). Pipeline: sync recent days from the monitor → weather actuals for unsettled past days
→ tomorrow's forecast → finalize past predictions (fills `actual`/`errorMinutes`) → predict
tomorrow → Web Push to all subscriptions. Every step degrades independently — a monitor outage at
9pm still produces a prediction from existing facts.
