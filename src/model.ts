// The reasoning engine: a similarity-weighted estimate of tomorrow's run-out
// time. Pure function over pre-digested day records — no I/O, no Intl, no
// dependencies — so it's trivially testable and the full basis of every
// prediction can be stored and inspected.
//
// Each history day is weighted by how much it resembles tomorrow (day type,
// morning temperature, morning precipitation, the character of the night
// before) and how recent it is. The probability of running out is the weighted
// share of similar days that did; the predicted time is the weighted median of
// when they did.

export interface DayRecord {
  date: string; // local YYYY-MM-DD
  dow: number; // 0=Sun..6=Sat
  isHoliday: boolean;
  runoutMinutes: number | null; // null = never ran out that day
  tempC: number | null; // 08:00 temperature
  precipMm: number | null; // 06:00-11:00 precipitation sum
  startBikes: number | null; // bikes at 10pm the evening before — the day's starting inventory
  sweptEvening: number | null; // bikes trucked out 17:00-22:00 the evening before
  // The night leading into this day's morning (evening before, 20:00-02:00):
  // overnight organic returns dominate the morning inventory, and they track
  // how inviting the night was.
  nightPrecipMm: number | null;
  nightDewC: number | null; // 22:00 dew point — mugginess
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
  startBikes: number | null; // bikes right now — what tomorrow morning starts from
  sweptEvening: number | null; // bikes trucked out this evening (17:00-22:00)
  nightPrecipMm: number | null; // tonight, 20:00-02:00 (forecast past 10pm)
  nightDewC: number | null; // tonight's 22:00 dew point
}

export interface WeightedDay {
  date: string;
  weight: number;
  runoutMinutes: number | null;
  tempC: number | null;
  precipMm: number | null;
  startBikes: number | null;
  sweptEvening: number | null;
  nightPrecipMm: number | null;
  nightDewC: number | null;
}

export interface PredictionBasis {
  // 0 = full kernels, 1 = night kernels dropped, 2 = all weather dropped,
  // 3 = day-type widened + inventory dropped
  fallbackLevel: 0 | 1 | 2 | 3;
  effectiveWeight: number; // sum of weights
  effectiveN: number; // (sum w)^2 / sum w^2 — "how many days is this really"
  historyDays: number; // records that passed the obs_count gate
  medianEvenIfUnlikely: number | null; // kept when probability < pMin
  target: TargetContext; // what tomorrow looked like when the model reasoned about it
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
  dayTypeSameClass: 0.25, // same work/off class, different weekday (same dow+class is 1.0)
  dayTypeOpposite: 0.05,
  tempSigmaC: 5,
  bikesSigma: 4, // starting-inventory kernel width, in bikes (capacity is 19)
  sweptMinBikes: 5, // >= this many bikes trucked out 5-10pm = a "swept" evening
  sweptMismatch: 0.4, // swept vs organic evenings tell opposite stories
  sweptSigmaFactor: 2, // both swept -> the 10pm count is cycle-phase noise, widen bikes sigma
  nightDewSigmaC: 3, // night-mugginess kernel width (22:00 dew point)
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
function dayTypeKernel(d: DayRecord, t: TargetContext, widened: boolean, p: Params): number {
  const sameClass = isOffday(d.dow, d.isHoliday) === isOffday(t.dow, t.isHoliday);
  const sameDow = d.dow === t.dow;
  if (widened) return sameDow && sameClass ? 1.0 : sameClass ? 0.7 : 0.2;
  return sameDow && sameClass ? 1.0 : sameClass ? p.dayTypeSameClass : p.dayTypeOpposite;
}

// Swept evenings (truck harvested the rack 5-10pm) and organic evenings tell
// opposite stories about the same low count: swept racks refill organically
// overnight, organically-drained racks stay low. Match the regime.
function sweptKernel(a: number | null, b: number | null, p: Params): number {
  if (a == null || b == null) return 1;
  return a >= p.sweptMinBikes === b >= p.sweptMinBikes ? 1 : p.sweptMismatch;
}

// Gaussian similarity on a numeric feature (temperature, starting inventory).
// A missing value is uninformative, not dissimilar — kernel 1.
function gaussianKernel(a: number | null, b: number | null, sigma: number): number {
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

// Same buckets for the night-before rain (no probability bump — that's a
// morning-window signal). A rainy night suppresses the overnight returns that
// rebuild the starting inventory.
function nightPrecipKernel(d: DayRecord, t: TargetContext, p: Params): number {
  const bd = precipBucket(d.nightPrecipMm, p);
  const bt = precipBucket(t.nightPrecipMm, p);
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

  const weigh = (level: 0 | 1 | 2 | 3) =>
    usable.map((d) => {
      let w = dayTypeKernel(d, target, level === 3, params);
      if (level === 0) {
        w *= nightPrecipKernel(d, target, params);
        w *= gaussianKernel(d.nightDewC, target.nightDewC, params.nightDewSigmaC);
      }
      if (level <= 1) {
        w *= gaussianKernel(d.tempC, target.tempC, params.tempSigmaC);
        w *= precipKernel(d, target, params);
      }
      // Starting inventory is a strong signal (a station at 6 bikes at 10pm runs
      // out earlier than a full one), so it survives level 2 and is only dropped
      // in the last-resort widening at level 3. When BOTH evenings were swept,
      // the count mostly reflects how long ago the truck came — widen sigma.
      if (level <= 2) {
        w *= sweptKernel(d.sweptEvening, target.sweptEvening, params);
        const bothSwept =
          d.sweptEvening != null &&
          target.sweptEvening != null &&
          d.sweptEvening >= params.sweptMinBikes &&
          target.sweptEvening >= params.sweptMinBikes;
        const sigma = bothSwept ? params.bikesSigma * params.sweptSigmaFactor : params.bikesSigma;
        w *= gaussianKernel(d.startBikes, target.startBikes, sigma);
      }
      w *= Math.pow(0.5, dayDiffDays(d.date, target.date) / params.recencyHalfLifeDays);
      return { d, w };
    });

  // Cold-start ladder: with little history the weather kernels can starve the
  // sample. Shed the night kernels first (the thinnest signal — an unusual
  // night shouldn't cost the morning kernels too), then all weather, then widen
  // the day-type kernel. Whatever level first reaches a usable effective sample
  // wins; the level is reported.
  let level: 0 | 1 | 2 | 3 = 0;
  let weighted = weigh(0);
  let nEff = effectiveN(weighted);
  for (const next of [1, 2, 3] as const) {
    if (nEff >= params.minEffectiveN) break;
    level = next;
    weighted = weigh(next);
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
      startBikes: d.startBikes,
      sweptEvening: d.sweptEvening,
      nightPrecipMm: d.nightPrecipMm,
      nightDewC: d.nightDewC,
    }));

  const basis: PredictionBasis = {
    fallbackLevel: level,
    effectiveWeight: Math.round(sumW * 1000) / 1000,
    effectiveN: Math.round(nEff * 100) / 100,
    historyDays: usable.length,
    medianEvenIfUnlikely: null,
    target,
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
