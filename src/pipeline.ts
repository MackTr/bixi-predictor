// Nightly orchestration. CRITICAL DATE RULE: the cron fires at 01:00/02:00 UTC,
// when the UTC calendar date is already *tomorrow* in Montreal terms. Every date
// below must flow from localToday()/addDays() — never from toISOString() or any
// UTC-derived Date field.
//
// Every step is individually try/caught: a monitor outage at 9pm still yields a
// prediction from existing facts, and a missed night self-heals the next one
// (14-day sync lookback, weather re-fetch of forecast-kind rows, finalization of
// ALL unfinalized past predictions).

import type { Env } from "./worker";
import { addDays, dowOf, localToday } from "./tz";
import { holidayName } from "./holidays";
import { datesNeedingSync, syncDays } from "./sync";
import { datesNeedingActuals, fetchActuals, fetchForecast, upsertWeather } from "./weather";
import { predict, type DayRecord, type Prediction, type TargetContext } from "./model";
import { broadcast, buildNotification } from "./push";

export interface PipelineResult {
  today: string;
  targetDate: string;
  synced: string[];
  weatherActuals: string[];
  forecastFetched: boolean;
  finalized: string[];
  prediction: Prediction | null;
  pushed: { sent: number; gone: number; failed: number } | null;
  errors: string[];
}

interface FeatureRow {
  date: string;
  dow: number;
  is_holiday: number;
  runout_minutes: number | null;
  obs_count: number;
  complete: number;
  temp_c: number | null;
  precip_mm: number | null;
  start_bikes: number | null;
}

async function loadHistory(env: Env): Promise<DayRecord[]> {
  // A day starts its morning from the PREVIOUS evening's 9pm inventory — hence
  // the self-join on date-1.
  const res = await env.DB.prepare(
    `SELECT f.date, f.dow, f.is_holiday, f.runout_minutes, f.obs_count, f.complete,
            w.temp_c, w.precip_mm, p.evening_bikes AS start_bikes
     FROM daily_features f
     LEFT JOIN weather_daily w ON w.date = f.date
     LEFT JOIN daily_features p ON p.date = date(f.date, '-1 day')
     ORDER BY f.date ASC`,
  ).all<FeatureRow>();
  return (res.results ?? []).map((r) => ({
    date: r.date,
    dow: r.dow,
    isHoliday: !!r.is_holiday,
    runoutMinutes: r.runout_minutes,
    tempC: r.temp_c,
    precipMm: r.precip_mm,
    startBikes: r.start_bikes,
    complete: !!r.complete,
    obsCount: r.obs_count,
  }));
}

// Fill actual_minutes/error_minutes for every past prediction whose target day
// now has a complete daily_features row. Not just yesterday's: this self-heals
// nights the cron missed.
async function finalizePastPredictions(env: Env, today: string, now: number): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT p.target_date AS target_date, p.predicted_minutes AS predicted_minutes, f.runout_minutes AS runout_minutes
     FROM predictions p JOIN daily_features f ON f.date = p.target_date
     WHERE p.target_date < ? AND p.finalized_ts IS NULL AND f.complete = 1`,
  )
    .bind(today)
    .all<{ target_date: string; predicted_minutes: number | null; runout_minutes: number | null }>();
  const rows = res.results ?? [];
  for (const r of rows) {
    const error = r.predicted_minutes != null && r.runout_minutes != null ? r.predicted_minutes - r.runout_minutes : null;
    await env.DB.prepare(
      `UPDATE predictions SET actual_minutes = ?, error_minutes = ?, finalized_ts = ? WHERE target_date = ?`,
    )
      .bind(r.runout_minutes, error, now, r.target_date)
      .run();
  }
  return rows.map((r) => r.target_date);
}

export async function buildAndStorePrediction(env: Env, targetDate: string, now: number): Promise<Prediction> {
  const history = await loadHistory(env);
  const weather = await env.DB.prepare(`SELECT temp_c, precip_mm, precip_prob FROM weather_daily WHERE date = ?`)
    .bind(targetDate)
    .first<{ temp_c: number | null; precip_mm: number | null; precip_prob: number | null }>();
  // Tomorrow starts from tonight's inventory — today's 9pm snapshot, captured by
  // the sync step that just ran.
  const tonight = await env.DB.prepare(`SELECT evening_bikes FROM daily_features WHERE date = ?`)
    .bind(addDays(targetDate, -1))
    .first<{ evening_bikes: number | null }>();
  const target: TargetContext = {
    date: targetDate,
    dow: dowOf(targetDate),
    isHoliday: !!holidayName(targetDate),
    tempC: weather?.temp_c ?? null,
    precipMm: weather?.precip_mm ?? null,
    precipProb: weather?.precip_prob ?? null,
    startBikes: tonight?.evening_bikes ?? null,
  };
  const prediction = predict(history, target);
  await env.DB.prepare(
    `INSERT INTO predictions (target_date, created_ts, predicted_minutes, probability, window_early, window_late, basis_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_date) DO UPDATE SET
       created_ts = excluded.created_ts,
       predicted_minutes = excluded.predicted_minutes,
       probability = excluded.probability,
       window_early = excluded.window_early,
       window_late = excluded.window_late,
       basis_json = excluded.basis_json`,
  )
    .bind(
      targetDate,
      now,
      prediction.predictedMinutes,
      prediction.probability,
      prediction.windowEarly,
      prediction.windowLate,
      JSON.stringify(prediction.basis),
    )
    .run();
  return prediction;
}

export async function runNightly(env: Env, opts: { push: boolean; now?: number }): Promise<PipelineResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const today = localToday(now);
  const targetDate = addDays(today, 1);
  const result: PipelineResult = {
    today,
    targetDate,
    synced: [],
    weatherActuals: [],
    forecastFetched: false,
    finalized: [],
    prediction: null,
    pushed: null,
    errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await step("sync", async () => {
    const need = await datesNeedingSync(env, 14, today);
    result.synced = (await syncDays(env, need, now)).map((d) => d.date);
  });
  await step("weather-actuals", async () => {
    const need = await datesNeedingActuals(env, today);
    if (!need.length) return;
    const actuals = await fetchActuals(env, need, today);
    for (const [date, w] of actuals) {
      await upsertWeather(env, date, "actual", w, now);
      result.weatherActuals.push(date);
    }
  });
  await step("forecast", async () => {
    const fc = await fetchForecast(env, [targetDate]);
    const w = fc.get(targetDate);
    if (!w) throw new Error("no forecast returned");
    await upsertWeather(env, targetDate, "forecast", w, now);
    result.forecastFetched = true;
  });
  await step("finalize", async () => {
    result.finalized = await finalizePastPredictions(env, today, now);
  });
  await step("predict", async () => {
    result.prediction = await buildAndStorePrediction(env, targetDate, now);
  });

  if (opts.push && result.prediction) {
    await step("push", async () => {
      const row = await env.DB.prepare(`SELECT notified_ts FROM predictions WHERE target_date = ?`)
        .bind(targetDate)
        .first<{ notified_ts: number | null }>();
      if (row?.notified_ts != null) {
        result.pushed = { sent: 0, gone: 0, failed: 0 }; // already notified tonight
        return;
      }
      // "Today: predicted X, actual Y" — the prediction made last night for
      // today, versus this morning's actual run-out (already synced above).
      const todayPred = await env.DB.prepare(`SELECT predicted_minutes FROM predictions WHERE target_date = ?`)
        .bind(today)
        .first<{ predicted_minutes: number | null }>();
      const todayFact = await env.DB.prepare(`SELECT runout_minutes FROM daily_features WHERE date = ?`)
        .bind(today)
        .first<{ runout_minutes: number | null }>();
      const p = result.prediction!;
      const payload = buildNotification(
        {
          targetDate,
          probability: p.probability,
          predictedMinutes: p.predictedMinutes,
          windowEarly: p.windowEarly,
          windowLate: p.windowLate,
          startBikes: p.basis.target.startBikes,
        },
        todayPred ? { predictedMinutes: todayPred.predicted_minutes, actualMinutes: todayFact?.runout_minutes ?? null } : undefined,
      );
      result.pushed = await broadcast(env, payload);
      await env.DB.prepare(`UPDATE predictions SET notified_ts = ? WHERE target_date = ?`).bind(now, targetDate).run();
    });
  }
  return result;
}

// First-deploy / repair path: digest N days of history + weather actuals without
// forecasting, predicting, or pushing. `force` re-syncs days already marked
// complete — needed when a new derived column (e.g. evening_bikes) must be
// filled for existing history.
export async function backfill(env: Env, days: number, opts?: { force?: boolean; now?: number }): Promise<PipelineResult> {
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const today = localToday(now);
  const result: PipelineResult = {
    today,
    targetDate: addDays(today, 1),
    synced: [],
    weatherActuals: [],
    forecastFetched: false,
    finalized: [],
    prediction: null,
    pushed: null,
    errors: [],
  };
  try {
    let need: string[];
    if (opts?.force) {
      need = [];
      for (let d = addDays(today, -days); d <= today; d = addDays(d, 1)) need.push(d);
    } else {
      need = await datesNeedingSync(env, days, today);
    }
    result.synced = (await syncDays(env, need, now)).map((d) => d.date);
  } catch (e) {
    result.errors.push(`sync: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const need = await datesNeedingActuals(env, today);
    if (need.length) {
      const actuals = await fetchActuals(env, need, today);
      for (const [date, w] of actuals) {
        await upsertWeather(env, date, "actual", w, now);
        result.weatherActuals.push(date);
      }
    }
  } catch (e) {
    result.errors.push(`weather-actuals: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    result.finalized = await finalizePastPredictions(env, today, now);
  } catch (e) {
    result.errors.push(`finalize: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}
