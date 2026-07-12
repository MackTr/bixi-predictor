// Web Push sending, over the hand-rolled RFC 8291 sender in webpush.ts. The
// Topic header makes an undelivered old prediction get replaced rather than
// queued behind tonight's.

import type { Env } from "./worker";
import { minsToHHMM } from "./tz";
import { buildPushRequest } from "./webpush";

export interface StoredSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

export interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface PredictionSummary {
  targetDate: string;
  probability: number | null;
  predictedMinutes: number | null;
  windowEarly: number | null;
  windowLate: number | null;
  startBikes?: number | null; // tonight's 9pm inventory, when known
}

export interface TodayComparison {
  predictedMinutes: number | null;
  actualMinutes: number | null;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function friendlyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${WD[t.getUTCDay()]} ${MO[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

export function buildNotification(p: PredictionSummary, today?: TodayComparison): NotificationPayload {
  let title: string;
  let body: string;
  if (p.probability == null) {
    title = "BIXI tomorrow: not enough data yet";
    body = `${friendlyDate(p.targetDate)} · the model needs a few more days of history.`;
  } else if (p.predictedMinutes == null) {
    title = "BIXI tomorrow: bikes all day";
    body = `${friendlyDate(p.targetDate)} · run-out probability ${Math.round(p.probability * 100)}%.`;
  } else {
    title = `BIXI tomorrow: empty ~${minsToHHMM(p.predictedMinutes)}`;
    const win =
      p.windowEarly != null && p.windowLate != null && p.windowLate > p.windowEarly
        ? ` likely out ${minsToHHMM(p.windowEarly)}–${minsToHHMM(p.windowLate)}`
        : ` likely out ~${minsToHHMM(p.predictedMinutes)}`;
    body = `${friendlyDate(p.targetDate)} ·${win} (${Math.round(p.probability * 100)}%).`;
  }
  if (p.startBikes != null) {
    body += ` From ${p.startBikes} bike${p.startBikes === 1 ? "" : "s"} tonight.`;
  }
  if (today?.predictedMinutes != null) {
    body += ` Today: predicted ${minsToHHMM(today.predictedMinutes)}, actual ${
      today.actualMinutes != null ? minsToHHMM(today.actualMinutes) : "no run-out"
    }.`;
  }
  return { title, body, tag: "bixi-tomorrow", url: "/" };
}

export async function sendPush(env: Env, sub: StoredSub, payload: NotificationPayload): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const { headers, body } = await buildPushRequest(
    { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    JSON.stringify(payload),
    { subject: "mailto:trenholm.mackenzie@gmail.com", publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    { ttl: 43200, urgency: "normal", topic: "bixi-tomorrow" },
  );
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// Sequential on purpose: sub counts here are 1-5 and the free-tier subrequest
// budget is 50/invocation. Gone endpoints (removed home-screen app) are pruned
// immediately; flaky ones after 5 consecutive failures.
export async function broadcast(env: Env, payload: NotificationPayload): Promise<{ sent: number; gone: number; failed: number }> {
  const res = await env.DB.prepare(`SELECT endpoint, p256dh, auth, failures FROM push_subscriptions`).all<StoredSub>();
  const subs = res.results ?? [];
  let sent = 0;
  let gone = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      const r = await sendPush(env, sub, payload);
      if (r.ok) {
        sent++;
        if (sub.failures > 0) {
          await env.DB.prepare(`UPDATE push_subscriptions SET failures = 0 WHERE endpoint = ?`).bind(sub.endpoint).run();
        }
      } else if (r.gone) {
        gone++;
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(sub.endpoint).run();
      } else {
        failed++;
        await bumpFailures(env, sub);
      }
    } catch {
      failed++;
      await bumpFailures(env, sub);
    }
  }
  return { sent, gone, failed };
}

async function bumpFailures(env: Env, sub: StoredSub): Promise<void> {
  if (sub.failures + 1 >= 5) {
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(sub.endpoint).run();
  } else {
    await env.DB.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?`).bind(sub.endpoint).run();
  }
}
