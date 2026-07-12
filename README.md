# BIXI Predictor — when will station 345 run out?

Nightly run-out prediction for BIXI station 345 (Regina / de Verdun), on Cloudflare Workers + D1.
Every night at 9pm Montreal time it predicts what time the station will run out of usable bikes
**tomorrow**, stores the prediction with its full reasoning basis, tracks accuracy against what
actually happened, and sends a Web Push notification to the
[bixi-monitor](https://github.com/MackTr/bixi-monitor) dashboard installed as a Home-Screen app.

Client #2 of bixi-monitor's `/api/v1` (it never touches the monitor's database — the monitor
records *facts*, this service holds *beliefs about the future*). See [docs/api.md](docs/api.md)
for the API contract.

## Prediction strategy

**A run-out** is the day's first usable-bikes `>0 → ≤0` transition, in local (America/Toronto)
time — the same definition the monitor dashboard uses, so both always agree on what "ran out at
7:43" means. Usable = mechanical + ebikes; cargo/trailer bikes are already excluded upstream.

The model is deliberately **not ML**. History starts late June 2026; training anything on a few
weeks of data would fit noise, and a fitted model can't tell you *why* it said 8am. Instead it's a
similarity-weighted estimate — "find the past days that looked like tomorrow, and look at what they
did" — where every prediction ships with the days it was based on.

### Weighing history

Each past day gets a weight: the product of four kernels comparing it to tomorrow
([src/model.ts](src/model.ts), all parameters in `PARAMS`):

| kernel | compares | value |
|---|---|---|
| day type | weekday vs work/off class | same dow **and** same class 1.0 · same class 0.4 · opposite 0.05 |
| temperature | 8am temperature | gaussian on the difference, σ = 5 °C |
| precipitation | 6–11am rain sum | buckets dry <0.5mm / light / wet >4mm: same 1.0 · adjacent 0.5 · dry↔wet 0.15 |
| recency | calendar age | half-life 45 days |

Details that matter:

- **Holidays are off-days**, not excluded: a holiday Monday matches Sundays (class `offday`), never
  working Mondays. Quebec statutory holidays are computed, not maintained ([src/holidays.ts](src/holidays.ts)).
- **Missing weather is uninformative, not dissimilar** — a null temperature scores kernel 1.0, so a
  day without weather data isn't punished, it's just not weather-matched.
- If tomorrow's rain *sum* looks dry but the forecast **probability** of rain is ≥50%, the dry
  bucket is promoted to light — probability is a forecast-only signal the archives don't have.
- Days with fewer than 20 observations are excluded entirely (collector gaps — their "never ran
  out" verdict can't be trusted).

### From weights to a prediction

- **Probability of running out** = weighted fraction of days that ran out.
- **Predicted time** = weighted median of *when* the run-out days ran out; the reported window is
  the weighted P25–P75. Median over mean: one weird 2pm run-out shouldn't drag a 7:40 estimate.
- If probability < 0.5 the notification says **"bikes all day"** and no time is published (the
  median it would have picked is kept in `basis.medianEvenIfUnlikely`).

A real example — predicting Sunday Jul 12 on two weeks of history: last Sunday dominated with
weight 0.84 (same dow+class, similar temp, dry, recent; it ran out at 11:06), Saturday Jul 4 and
the Canada Day holiday contributed 0.25/0.23 as fellow off-days, and every weekday was crushed to
~0.04. Result: 80% probability, predicted 11:06, window 09:21–11:06 — a weekend answer built almost
entirely from weekend evidence.

### Cold start, honestly

The effective sample size `n_eff = (Σw)²/Σw²` measures how many days the estimate *really* rests
on. When it's under 3, the model climbs a fallback ladder instead of faking precision:

1. **Level 0** — all kernels active.
2. **Level 1** — weather kernels dropped (with little data, weather-matching starves the sample).
3. **Level 2** — day-type kernel widened (1.0/0.7/0.2). If `n_eff` is still under 1, the
   prediction is published as **"not enough data"** rather than a made-up time.

The level used is stored and shown on the dashboard card, so a vague answer is visibly vague.

### The accuracy loop

Every prediction row keeps `actual_minutes` and `error_minutes` (predicted − actual), filled in the
night after the target day completes. `GET /api/v1/stations/345/predictions?days=30` is therefore a
running scorecard — and the evidence for whether a smarter model is ever worth it. Each night's
notification also reports how yesterday's prediction did.

### Explainability

`basis_json` on every prediction records the fallback level, `n_eff`, the full parameter set, and
the top-8 contributing days with their weights, run-out times and weather. Any prediction can be
audited months later: *these* were the days it reasoned from, weighted *this* much, under *these*
parameters.

## The nightly pipeline

Both `0 1 * * *` and `0 2 * * *` UTC crons fire; only the one landing at 9pm America/Toronto runs
(DST-proof). Steps ([src/pipeline.ts](src/pipeline.ts)), each isolated so one failure can't kill
the night:

1. **Sync** — pull recent days from the monitor API, digest each into one daily_features row
   (run-out time, observation count). 14-day lookback self-heals missed nights. Today is included
   as `complete=0`: by 9pm the morning — when run-outs happen — is already history.
2. **Weather** — Open-Meteo (free, no key): actuals for unsettled past days, forecast for tomorrow.
   The forecast API also serves recent-past actuals; the ERA5 archive lags ~5 days and is used only
   for deep backfill.
3. **Finalize** — fill actual/error for every past prediction whose target day completed.
4. **Predict** — weigh history against tomorrow's context, upsert one row per target date.
5. **Push** — RFC 8291 Web Push to every subscription. `notified_ts` guarantees a target date is
   never pushed twice, so re-runs and double-fires are safe.

Two implementation notes with scars behind them: at the 9pm firing the **UTC date is already
tomorrow**, so every date flows through the local-time helpers in [src/tz.ts](src/tz.ts) — never
`toISOString()`. And the Web Push encryption is **hand-rolled on WebCrypto**
([src/webpush.ts](src/webpush.ts)): the npm WebCrypto push libraries still emit the pre-standard
`aesgcm` encoding, which Apple's push service rejects. The implementation reproduces RFC 8291's
Appendix A test vector byte-for-byte: `npx tsx scripts/webpush-vector-test.ts`.

## Layout

- `src/model.ts` — the similarity-weighted estimator (pure, explainable, no I/O)
- `src/pipeline.ts` — nightly orchestration (sync → weather → finalize → predict → push)
- `src/sync.ts` — monitor API → per-day run-out facts (service binding in prod: workers.dev blocks
  same-account worker→worker fetches)
- `src/weather.ts` — Open-Meteo forecast + archive → morning-window aggregates
- `src/push.ts` + `src/webpush.ts` — Web Push: hand-rolled VAPID + aes128gcm (RFC 8291)
- `src/api.ts` — `/api/v1` router + CORS
- `src/worker.ts` — `scheduled()` (9pm local guard) + `fetch()` entrypoint

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

VAPID keys must never rotate casually — push subscriptions bind to them. After first deploy:
backfill once (`POST /api/v1/admin/backfill?days=20` with the Bearer token), then subscribe from
the dashboard on the phone (Add to Home Screen → open from the icon → enable alerts).
