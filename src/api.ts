// /api/v1 router, mirroring bixi-monitor's conventions (open CORS, JSON errors,
// station id in the path). Deltas from the monitor: POST is allowed (push
// subscribe/unsubscribe, admin actions) and admin routes take a Bearer token.

import type { Env } from "./worker";
import { localToday, minsToHHMM } from "./tz";
import { backfill, runNightly } from "./pipeline";
import { broadcast, buildNotification } from "./push";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
const fail = (status: number, message: string) => json({ error: message }, { status });
const iso = (epoch: number | null) => (epoch == null ? null : new Date(epoch * 1000).toISOString());

function clampDays(v: string | null, def: number): number {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), 365);
}

// Constant-time-ish Bearer check; refuses everything when the secret is unset.
function authorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const got = request.headers.get("Authorization") ?? "";
  const want = `Bearer ${env.ADMIN_TOKEN}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

interface PredictionRow {
  target_date: string;
  created_ts: number;
  predicted_minutes: number | null;
  probability: number | null;
  window_early: number | null;
  window_late: number | null;
  basis_json: string;
  actual_minutes: number | null;
  error_minutes: number | null;
  finalized_ts: number | null;
  notified_ts: number | null;
}

const PRED_COLS =
  "target_date, created_ts, predicted_minutes, probability, window_early, window_late, basis_json, actual_minutes, error_minutes, finalized_ts, notified_ts";

function predictionJson(env: Env, r: PredictionRow, withBasis: boolean) {
  const mins = (m: number | null) => (m == null ? null : { minutes: m, time: minsToHHMM(m) });
  return {
    station: env.STATION_ID,
    targetDate: r.target_date,
    createdAt: iso(r.created_ts),
    // null = model had too little data to say anything either way
    willRunOut: r.probability == null ? null : r.predicted_minutes != null,
    probability: r.probability,
    predicted: mins(r.predicted_minutes),
    window:
      r.window_early != null && r.window_late != null
        ? { early: minsToHHMM(r.window_early), late: minsToHHMM(r.window_late) }
        : null,
    actual: mins(r.actual_minutes),
    errorMinutes: r.error_minutes,
    // non-null = the target day is graded; actual:null then means "never ran out",
    // not "not scored yet" — clients can't tell those apart without this
    finalizedAt: iso(r.finalized_ts),
    notifiedAt: iso(r.notified_ts),
    ...(withBasis ? { basis: JSON.parse(r.basis_json) as unknown } : {}),
  };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "GET" && request.method !== "POST") return fail(405, "method not allowed");

  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api","v1",...]
  if (parts[0] !== "api" || parts[1] !== "v1") return fail(404, "unknown api version");
  const seg = parts.slice(2);
  const GET = request.method === "GET";

  try {
    if (GET && seg.length === 1 && seg[0] === "health") return await health(env);

    if (seg[0] === "stations" && seg[1]) {
      if (seg[1] !== env.STATION_ID) return fail(404, `unknown station ${seg[1]}`);
      if (GET && seg[2] === "prediction") return await latestPrediction(env, url);
      if (GET && seg[2] === "predictions") return await predictionHistory(env, url);
      return fail(404, `unknown resource ${seg[2] ?? ""}`);
    }

    if (seg[0] === "push") {
      if (GET && seg[1] === "vapid-public-key") return json({ key: env.VAPID_PUBLIC_KEY });
      if (!GET && seg[1] === "subscribe") return await subscribe(env, request);
      if (!GET && seg[1] === "unsubscribe") return await unsubscribe(env, request);
      return fail(404, `unknown resource ${seg[1] ?? ""}`);
    }

    if (seg[0] === "admin") {
      if (!authorized(request, env)) return fail(401, "unauthorized");
      if (!GET && seg[1] === "backfill") {
        const force = url.searchParams.get("force") === "1";
        return json(await backfill(env, clampDays(url.searchParams.get("days"), 20), { force }));
      }
      if (!GET && seg[1] === "run") {
        return json(await runNightly(env, { push: url.searchParams.get("push") === "1" }));
      }
      if (!GET && seg[1] === "test-push") {
        const payload = buildNotification({
          targetDate: localToday(Math.floor(Date.now() / 1000)),
          probability: 0.86,
          predictedMinutes: 460,
          windowEarly: 435,
          windowLate: 485,
        });
        payload.title = "BIXI test push";
        return json(await broadcast(env, payload));
      }
      return fail(404, `unknown resource ${seg[1] ?? ""}`);
    }

    return fail(404, "not found");
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : "internal error");
  }
}

// ---------- endpoints ----------

async function latestPrediction(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const row = date
    ? await env.DB.prepare(`SELECT ${PRED_COLS} FROM predictions WHERE target_date = ?`).bind(date).first<PredictionRow>()
    : await env.DB.prepare(`SELECT ${PRED_COLS} FROM predictions ORDER BY target_date DESC LIMIT 1`).first<PredictionRow>();
  if (!row) return fail(404, "no prediction yet");
  return json(predictionJson(env, row, true));
}

async function predictionHistory(env: Env, url: URL): Promise<Response> {
  const days = clampDays(url.searchParams.get("days"), 14);
  const res = await env.DB.prepare(`SELECT ${PRED_COLS} FROM predictions ORDER BY target_date DESC LIMIT ?`)
    .bind(days)
    .all<PredictionRow>();
  const rows = res.results ?? [];
  return json({
    station: env.STATION_ID,
    count: rows.length,
    predictions: rows.map((r) => predictionJson(env, r, false)),
  });
}

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

async function subscribe(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SubscribeBody | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return fail(400, "expected { endpoint, keys: { p256dh, auth } }");
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_ts, failures) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
  )
    .bind(endpoint, p256dh, auth, Math.floor(Date.now() / 1000))
    .run();
  return json({ ok: true });
}

async function unsubscribe(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) return fail(400, "expected { endpoint }");
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(body.endpoint).run();
  return json({ ok: true });
}

async function health(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const today = localToday(now);
  const latest = await env.DB.prepare(
    `SELECT target_date, created_ts FROM predictions ORDER BY target_date DESC LIMIT 1`,
  ).first<{ target_date: string; created_ts: number }>();
  const feats = await env.DB.prepare(`SELECT COUNT(*) AS c, MAX(date) AS latest FROM daily_features`).first<{
    c: number;
    latest: string | null;
  }>();
  const weather = await env.DB.prepare(`SELECT COUNT(*) AS c FROM weather_daily`).first<{ c: number }>();
  const subs = await env.DB.prepare(`SELECT COUNT(*) AS c FROM push_subscriptions`).first<{ c: number }>();
  return json({
    // healthy = last night's run produced a prediction for today or later
    ok: latest != null && latest.target_date >= today,
    latestTargetDate: latest?.target_date ?? null,
    latestCreatedAt: iso(latest?.created_ts ?? null),
    featureDays: feats?.c ?? 0,
    latestFeatureDate: feats?.latest ?? null,
    weatherDays: weather?.c ?? 0,
    subscriptions: subs?.c ?? 0,
    serverTime: iso(now),
  });
}
