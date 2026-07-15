// Pulls observation history from bixi-monitor's public API and digests it into
// one daily_features row per local day. The monitor's /observations endpoint
// already returns usable bikes (cargo/trailer subtracted server-side), so the
// run-out definition here matches the dashboard exactly: first bikes>0 -> <=0
// transition of the local day.

import type { Env } from "./worker";
import { TZ, addDays, dayDiff, dowOf, localParts, localToday, midnightEpoch, wallToEpoch } from "./tz";
import { holidayName } from "./holidays";

export interface MonitorObs {
  ts: number;
  bikes: number; // usable (cargo excluded) — transform applied by the monitor API
}

export interface SyncedDay {
  date: string;
  runoutMinutes: number | null;
  obsCount: number;
  complete: boolean;
  eveningBikes: number | null;
  eveningSwept: number | null; // bikes trucked out 17:00-22:00 (burst-detected)
}

// workers.dev blocks worker→worker fetches within one account, so production
// goes through the MONITOR service binding (still the public /api/v1 handler,
// just routed directly). Local dev has no bound monitor: wrangler's stub either
// throws or answers 503, and either way the plain fetch of the live URL works
// fine from outside Cloudflare — fall back on both.
async function monitorFetch(env: Env, url: string): Promise<Response> {
  const init = { headers: { "User-Agent": "bixi-predictor (personal)" } };
  if (env.MONITOR) {
    try {
      const res = await env.MONITOR.fetch(url, init);
      if (res.status !== 503) return res;
    } catch {
      /* fall through to the public URL */
    }
  }
  return fetch(url, init);
}

export async function fetchObservations(env: Env, fromEpoch: number, toEpoch: number): Promise<MonitorObs[]> {
  const url = `${env.MONITOR_API}/stations/${env.STATION_ID}/observations?from=${fromEpoch}&to=${toEpoch}&limit=20000`;
  const res = await monitorFetch(env, url);
  if (!res.ok) throw new Error(`monitor api ${res.status}`);
  const body = (await res.json()) as { observations?: MonitorObs[] };
  return body.observations ?? [];
}

// Dates in [today - lookbackDays, today] that are missing or were synced before
// their day ended. Yesterday and today always qualify (today is always fresh;
// yesterday was complete=0 when synced at 10pm yesterday).
export async function datesNeedingSync(env: Env, lookbackDays: number, today: string): Promise<string[]> {
  const from = addDays(today, -lookbackDays);
  const res = await env.DB.prepare(`SELECT date FROM daily_features WHERE date >= ? AND date <= ? AND complete = 1`)
    .bind(from, today)
    .all<{ date: string }>();
  const done = new Set((res.results ?? []).map((r) => r.date));
  const out: string[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if (!done.has(d) || dayDiff(d, today) <= 1) out.push(d);
  }
  return out;
}

// Split sorted dates into contiguous runs of at most maxLen, so each run is one
// bounded monitor fetch (a busy on-change day is a few hundred rows; 5 days
// stays far under the API's 20k cap).
function contiguousRuns(dates: string[], maxLen: number): string[][] {
  const sorted = [...new Set(dates)].sort();
  const runs: string[][] = [];
  for (const d of sorted) {
    const cur = runs[runs.length - 1];
    if (cur && cur.length < maxLen && dayDiff(cur[cur.length - 1], d) === 1) cur.push(d);
    else runs.push([d]);
  }
  return runs;
}

export async function syncDays(env: Env, dates: string[], now: number): Promise<SyncedDay[]> {
  const today = localToday(now);
  const out: SyncedDay[] = [];

  for (const run of contiguousRuns(dates, 5)) {
    const bounds = run.map(midnightEpoch); // local-midnight epoch starting each date
    const endEpoch = midnightEpoch(addDays(run[run.length - 1], 1));
    // Start 2h early so prevBikes is known at the first midnight (the monitor
    // heartbeats at least every 15 min); stop 1s short of the next midnight so
    // an exactly-on-boundary row can't be counted into the last day.
    const from = bounds[0] - 7200;
    const to = Math.min(now, endEpoch - 1);
    if (to <= from) continue;
    const rows = await fetchObservations(env, from, to);

    // 22:00 snapshot per date: last observed value at or before 10pm (step-held).
    const eveningEpochs = run.map((d) => {
      const [y, m, dd] = d.split("-").map(Number);
      return wallToEpoch(y, m, dd, 22, 0, TZ);
    });
    const sweepWindowStarts = run.map((d) => {
      const [y, m, dd] = d.split("-").map(Number);
      return wallToEpoch(y, m, dd, 17, 0, TZ);
    });
    const state = new Map(
      run.map((d) => [
        d,
        { runoutEpoch: null as number | null, obs: 0, eveningBikes: null as number | null, swept: 0 },
      ]),
    );

    // Truck bursts: consecutive same-direction changes <=5min apart. Trucks
    // load/unload ~2 bikes a minute; organic trips are isolated +-1..3. A burst
    // removing >=5 bikes that starts inside a date's 17:00-22:00 window counts
    // toward that evening's sweep total.
    let burst: { dir: 1 | -1; sum: number; startTs: number; lastTs: number } | null = null;
    const closeBurst = () => {
      if (!burst || burst.sum > -5) return;
      const i = sweepWindowStarts.findIndex((s, j) => burst!.startTs >= s && burst!.startTs <= eveningEpochs[j]);
      if (i >= 0) state.get(run[i])!.swept += -burst.sum;
    };

    let prev: number | null = null;
    let di = -1; // index into run; -1 = still in the 2h lead-in
    for (const r of rows) {
      while (di + 1 < run.length && r.ts >= bounds[di + 1]) di++;
      if (di >= 0) {
        const st = state.get(run[di])!;
        st.obs++;
        if (prev != null && prev > 0 && r.bikes <= 0 && st.runoutEpoch == null) st.runoutEpoch = r.ts;
        if (r.ts <= eveningEpochs[di]) st.eveningBikes = r.bikes;
      }
      if (prev != null && r.bikes !== prev) {
        const delta = r.bikes - prev;
        const dir = delta > 0 ? (1 as const) : (-1 as const);
        if (burst && burst.dir === dir && r.ts - burst.lastTs <= 300) {
          burst.sum += delta;
          burst.lastTs = r.ts;
        } else {
          closeBurst();
          burst = { dir, sum: delta, startTs: r.ts, lastTs: r.ts };
        }
      }
      prev = r.bikes;
    }
    closeBurst();

    for (const date of run) {
      const st = state.get(date)!;
      const runoutMinutes =
        st.runoutEpoch != null
          ? (() => {
              const p = localParts(st.runoutEpoch, TZ);
              return p.hour * 60 + p.minute;
            })()
          : null;
      const complete = date < today;
      // swept is only meaningful when the walk actually saw observations
      const swept = st.obs > 0 ? st.swept : null;
      await env.DB.prepare(
        `INSERT INTO daily_features (date, dow, is_holiday, runout_minutes, obs_count, complete, evening_bikes, evening_swept, synced_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           dow = excluded.dow,
           is_holiday = excluded.is_holiday,
           runout_minutes = excluded.runout_minutes,
           obs_count = excluded.obs_count,
           complete = excluded.complete,
           evening_bikes = COALESCE(excluded.evening_bikes, daily_features.evening_bikes),
           evening_swept = COALESCE(excluded.evening_swept, daily_features.evening_swept),
           synced_ts = excluded.synced_ts`,
      )
        .bind(date, dowOf(date), holidayName(date) ? 1 : 0, runoutMinutes, st.obs, complete ? 1 : 0, st.eveningBikes, swept, now)
        .run();
      out.push({ date, runoutMinutes, obsCount: st.obs, complete, eveningBikes: st.eveningBikes, eveningSwept: swept });
    }
  }
  return out;
}
