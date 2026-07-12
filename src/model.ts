// The reasoning engine: a similarity-weighted estimate of tomorrow's run-out
// time. Pure function over pre-digested day records — no I/O, no Intl, no
// dependencies — so it's trivially testable and the full basis of every
// prediction can be stored and inspected.
//
// Each history day is weighted by how much it resembles tomorrow (day type,
// morning temperature, morning precipitation) and how recent it is. The
// probability of running out is the weighted share of similar days that did;
// the predicted time is the weighted median of when they did.

export interface DayRecord {
  date: string; // local YYYY-MM-DD
  dow: number; // 0=Sun..6=Sat
  isHoliday: boolean;
  runoutMinutes: number | null; // null = never ran out that day
  tempC: number | null; // 08:00 temperature
  precipMm: number | null; // 06:00-11:00 precipitation sum
  complete: boolean;
  obsCount: number;
}

export interface TargetContext {
  date: string;
  dow: number;
  isHoliday: boolean;
  tempC: number | null;
  precipMm: number | null;
  precipProb: number | null; // forecast-only signal, promotes a dry mm bucket
}

export interface WeightedDay {
  date: string;
  weight: number;
  runoutMinutes: number | null;
  tempC: number | null;
  precipMm: number | null;
}

export interface PredictionBasis {
  fallbackLevel: 0 | 1 | 2; // 0 = full kernels, 1 = weather dropped, 2 = day-type widened too
  effectiveWeight: number; // sum of weights
  effectiveN: number; // (sum w)^2 / sum w^2 — "how many days is this really"
  historyDays: number; // records that passed the obs_count gate
  medianEvenIfUnlikely: number | null; // kept when probability < pMin
  params: Params;
  topDays: WeightedDay[]; // top contributors, heaviest first
}

export interface Prediction {
  probability: number | null; // null = not enough data to say anything
  predictedMinutes: number | null; // null when unlikely (or no data)
  windowEarly: number | null;
  windowLate: number | null;
  basis: PredictionBasis;
}

export const PARAMS = {
  tempSigmaC: 5,
  recencyHalfLifeDays: 45,
  dryMaxMm: 0.5, // precip buckets over the morning-window sum
  wetMinMm: 4,
  probBumpThreshold: 50, // forecast rain prob >= this promotes a "dry" bucket to "light"
  pMin: 0.5, // below this -> "unlikely to run out"
  minEffectiveN: 3, // fallback trigger
  minObsCount: 20, // exclude gap days with too little data to trust
};
export type Params = typeof PARAMS;

const isOffday = (dow: number, holiday: boolean) => holiday || dow === 0 || dow === 6;

// Same weekday only counts fully when it's also the same work/off class — a
// holiday Monday behaves like a Sunday, not like a working Monday.
function dayTypeKernel(d: DayRecord, t: TargetContext, widened: boolean): number {
  const sameClass = isOffday(d.dow, d.isHoliday) === isOffday(t.dow, t.isHoliday);
  const sameDow = d.dow === t.dow;
  if (widened) return sameDow && sameClass ? 1.0 : sameClass ? 0.7 : 0.2;
  return sameDow && sameClass ? 1.0 : sameClass ? 0.4 : 0.05;
}

// Missing weather is uninformative, not dissimilar — kernel 1.
function tempKernel(a: number | null, b: number | null, sigma: number): number {
  if (a == null || b == null) return 1;
  const d = a - b;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

function precipBucket(mm: number | null, p: Params): 0 | 1 | 2 | null {
  if (mm == null) return null;
  return mm < p.dryMaxMm ? 0 : mm <= p.wetMinMm ? 1 : 2;
}

function precipKernel(d: DayRecord, t: TargetContext, p: Params): number {
  const bd = precipBucket(d.precipMm, p);
  let bt = precipBucket(t.precipMm, p);
  if (bt === 0 && t.precipProb != null && t.precipProb >= p.probBumpThreshold) bt = 1;
  if (bd == null || bt == null) return 1;
  const diff = Math.abs(bd - bt);
  return diff === 0 ? 1 : diff === 1 ? 0.5 : 0.15;
}

// Weighted quantile over runout times: first value whose cumulative weight
// reaches q of the total.
function weightedQuantile(items: { v: number; w: number }[], q: number): number {
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let cum = 0;
  for (const x of sorted) {
    cum += x.w;
    if (cum >= q * total) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

export function predict(history: DayRecord[], target: TargetContext, params: Params = PARAMS): Prediction {
  const usable = history.filter((d) => d.obsCount >= params.minObsCount && d.date < target.date);

  const weigh = (level: 0 | 1 | 2) =>
    usable.map((d) => {
      let w = dayTypeKernel(d, target, level === 2);
      if (level === 0) {
        w *= tempKernel(d.tempC, target.tempC, params.tempSigmaC);
        w *= precipKernel(d, target, params);
      }
      w *= Math.pow(0.5, dayDiffDays(d.date, target.date) / params.recencyHalfLifeDays);
      return { d, w };
    });

  // Cold-start ladder: with little history the weather kernels can starve the
  // sample, so drop them first, then widen the day-type kernel. Whatever level
  // first reaches a usable effective sample wins; the level is reported.
  let level: 0 | 1 | 2 = 0;
  let weighted = weigh(0);
  let nEff = effectiveN(weighted);
  if (nEff < params.minEffectiveN) {
    level = 1;
    weighted = weigh(1);
    nEff = effectiveN(weighted);
  }
  if (nEff < params.minEffectiveN) {
    level = 2;
    weighted = weigh(2);
    nEff = effectiveN(weighted);
  }

  const sumW = weighted.reduce((s, x) => s + x.w, 0);
  const topDays: WeightedDay[] = [...weighted]
    .sort((a, b) => b.w - a.w)
    .slice(0, 8)
    .map(({ d, w }) => ({
      date: d.date,
      weight: Math.round(w * 1000) / 1000,
      runoutMinutes: d.runoutMinutes,
      tempC: d.tempC,
      precipMm: d.precipMm,
    }));

  const basis: PredictionBasis = {
    fallbackLevel: level,
    effectiveWeight: Math.round(sumW * 1000) / 1000,
    effectiveN: Math.round(nEff * 100) / 100,
    historyDays: usable.length,
    medianEvenIfUnlikely: null,
    params,
    topDays,
  };

  if (nEff < 1 || sumW <= 0) {
    return { probability: null, predictedMinutes: null, windowEarly: null, windowLate: null, basis };
  }

  const ranOut = weighted.filter((x) => x.d.runoutMinutes != null);
  const probability = ranOut.reduce((s, x) => s + x.w, 0) / sumW;
  const times = ranOut.map((x) => ({ v: x.d.runoutMinutes as number, w: x.w }));
  const median = times.length ? Math.round(weightedQuantile(times, 0.5)) : null;

  if (probability < params.pMin || median == null) {
    basis.medianEvenIfUnlikely = median;
    return { probability, predictedMinutes: null, windowEarly: null, windowLate: null, basis };
  }

  return {
    probability,
    predictedMinutes: median,
    windowEarly: Math.round(weightedQuantile(times, 0.25)),
    windowLate: Math.round(weightedQuantile(times, 0.75)),
    basis,
  };
}

function effectiveN(weighted: { w: number }[]): number {
  const s = weighted.reduce((a, x) => a + x.w, 0);
  const s2 = weighted.reduce((a, x) => a + x.w * x.w, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}

// Local import-free copy of tz.dayDiff to keep this module dependency-free.
function dayDiffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
