// Morning-window weather from Open-Meteo (free, no key). Two sources:
//  - forecast API: tomorrow's forecast AND recent-past actuals (it serves past
//    dates up to ~92 days back with no delay)
//  - archive API (ERA5): deep backfill only — it lags realtime by ~5 days and
//    would silently return nulls for the most important (recent) days, and it
//    has no precipitation_probability.
// With timezone=America/Toronto the hourly labels are already local wall-clock,
// so they align 1:1 with our local dates. Hourly `precipitation` is the
// PRECEDING-hour sum: the 06:00-11:00 window = labels 07:00..11:00.

import type { Env } from "./worker";
import { TZ, dayDiff } from "./tz";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const RECENT_DAYS = 7; // age up to which the forecast API is the actuals source

export interface MorningWeather {
  tempC: number | null; // temperature_2m at 08:00
  precipMm: number | null; // precipitation sum 06:00-11:00
  precipProb: number | null; // max precipitation_probability 06:00-11:00
  windKmh: number | null; // max wind_speed_10m 06:00-11:00
}

interface OpenMeteoHourly {
  time: string[]; // "YYYY-MM-DDTHH:MM" local labels
  temperature_2m?: (number | null)[];
  precipitation?: (number | null)[];
  precipitation_probability?: (number | null)[];
  wind_speed_10m?: (number | null)[];
}

async function fetchHourly(base: string, env: Env, startDate: string, endDate: string, withProb: boolean): Promise<OpenMeteoHourly> {
  const vars = ["temperature_2m", "precipitation", "wind_speed_10m"];
  if (withProb) vars.push("precipitation_probability");
  const u = new URL(base);
  u.searchParams.set("latitude", env.STATION_LAT);
  u.searchParams.set("longitude", env.STATION_LON);
  u.searchParams.set("hourly", vars.join(","));
  u.searchParams.set("timezone", TZ);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  const res = await fetch(u.toString(), { headers: { "User-Agent": "bixi-predictor (personal)" } });
  if (!res.ok) throw new Error(`open-meteo ${res.status} for ${startDate}..${endDate}`);
  const body = (await res.json()) as { hourly?: OpenMeteoHourly };
  if (!body.hourly?.time) throw new Error("open-meteo: no hourly data");
  return body.hourly;
}

const MORNING_LABELS = ["07:00", "08:00", "09:00", "10:00", "11:00"];

export function aggregateMorning(hourly: OpenMeteoHourly, dates: string[]): Map<string, MorningWeather> {
  const idx = new Map<string, number>();
  hourly.time.forEach((t, i) => idx.set(t, i));
  const at = (date: string, hh: string, arr?: (number | null)[]): number | null => {
    const i = idx.get(`${date}T${hh}`);
    return i == null ? null : (arr?.[i] ?? null);
  };
  const out = new Map<string, MorningWeather>();
  for (const date of dates) {
    let precip: number | null = null;
    let prob: number | null = null;
    let wind: number | null = null;
    for (const hh of MORNING_LABELS) {
      const p = at(date, hh, hourly.precipitation);
      if (p != null) precip = (precip ?? 0) + p;
      const pr = at(date, hh, hourly.precipitation_probability);
      if (pr != null) prob = Math.max(prob ?? 0, pr);
      const w = at(date, hh, hourly.wind_speed_10m);
      if (w != null) wind = Math.max(wind ?? 0, w);
    }
    out.set(date, { tempC: at(date, "08:00", hourly.temperature_2m), precipMm: precip, precipProb: prob, windKmh: wind });
  }
  return out;
}

export async function fetchForecast(env: Env, dates: string[]): Promise<Map<string, MorningWeather>> {
  const sorted = [...dates].sort();
  const hourly = await fetchHourly(FORECAST_URL, env, sorted[0], sorted[sorted.length - 1], true);
  return aggregateMorning(hourly, sorted);
}

// Actuals for past dates: forecast API for recent days, archive for older ones,
// with a forecast-API retry for archive dates that came back all-null (the ERA5
// lag window moves; the forecast API's 92-day past window covers the gap).
export async function fetchActuals(env: Env, dates: string[], today: string): Promise<Map<string, MorningWeather>> {
  const recent = dates.filter((d) => dayDiff(d, today) <= RECENT_DAYS).sort();
  const older = dates.filter((d) => dayDiff(d, today) > RECENT_DAYS).sort();
  const out = new Map<string, MorningWeather>();

  if (older.length) {
    const hourly = await fetchHourly(ARCHIVE_URL, env, older[0], older[older.length - 1], false);
    const agg = aggregateMorning(hourly, older);
    const missing: string[] = [];
    for (const [date, w] of agg) {
      if (w.tempC == null && w.precipMm == null) missing.push(date);
      else out.set(date, w);
    }
    if (missing.length && dayDiff(missing[0], today) <= 92) {
      const retry = await fetchForecast(env, missing);
      for (const [date, w] of retry) out.set(date, w);
    }
  }
  if (recent.length) {
    const agg = await fetchForecast(env, recent);
    for (const [date, w] of agg) out.set(date, w);
  }
  return out;
}

export async function upsertWeather(env: Env, date: string, kind: "actual" | "forecast", w: MorningWeather, now: number): Promise<void> {
  // COALESCE keeps a forecast's precip_prob when the actual (archive) has none.
  await env.DB.prepare(
    `INSERT INTO weather_daily (date, kind, temp_c, precip_mm, precip_prob, wind_kmh, fetched_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       kind = excluded.kind,
       temp_c = excluded.temp_c,
       precip_mm = excluded.precip_mm,
       precip_prob = COALESCE(excluded.precip_prob, weather_daily.precip_prob),
       wind_kmh = excluded.wind_kmh,
       fetched_ts = excluded.fetched_ts`,
  )
    .bind(date, kind, w.tempC, w.precipMm, w.precipProb, w.windKmh, now)
    .run();
}

// Dates whose weather is still a forecast (or missing entirely) — these get
// re-fetched as actuals until they settle. Includes today: by the 9pm run the
// morning window is long past, and today's row feeds the model tonight.
export async function datesNeedingActuals(env: Env, today: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT f.date AS date FROM daily_features f
     LEFT JOIN weather_daily w ON w.date = f.date
     WHERE f.date <= ? AND (w.date IS NULL OR w.kind = 'forecast')
     ORDER BY f.date ASC`,
  )
    .bind(today)
    .all<{ date: string }>();
  return (res.results ?? []).map((r) => r.date);
}
