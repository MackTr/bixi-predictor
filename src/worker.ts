import { handleApi } from "./api";
import { runNightly } from "./pipeline";
import { TZ, localParts } from "./tz";

export interface Env {
  DB: D1Database;
  MONITOR?: Fetcher; // service binding to bixi-monitor (prod; absent-ish in local dev)
  MONITOR_API: string; // var — bixi-monitor's /api/v1 base URL (dev fallback + URL builder)
  STATION_ID: string; // var
  STATION_LAT: string; // var
  STATION_LON: string; // var
  VAPID_PUBLIC_KEY: string; // secret (public value, but lives with its pair)
  VAPID_PRIVATE_KEY: string; // secret
  ADMIN_TOKEN: string; // secret
}

export default {
  // API only — no dashboard here; bixi-monitor's dashboard is the UI for this.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return new Response(JSON.stringify({ error: "not found", api: "/api/v1" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },

  // Both UTC crons (02:00 and 03:00) fire year-round; only the one landing at
  // 10pm Montreal time does work, which keeps the schedule DST-proof. Errors are
  // logged, never thrown, so one bad night can't wedge the schedule.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = localParts(Math.floor(Date.now() / 1000), TZ).hour;
    if (hour !== 22) {
      console.log(`cron skipped (local hour ${hour} != 22)`);
      return;
    }
    ctx.waitUntil(
      runNightly(env, { push: true }).then(
        (result) => console.log("nightly:", JSON.stringify(result)),
        (err) => console.error("nightly failed:", err instanceof Error ? err.message : err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
