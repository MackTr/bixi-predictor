-- One row per local (America/Toronto) calendar day of monitor history.
-- runout_minutes = minutes since local midnight of the FIRST usable-bikes
-- (bikes>0 -> <=0) transition that day; NULL = never ran out. `complete` is 0
-- when the row was synced before the local day ended (today, synced at 9pm) and
-- flips to 1 when re-synced the following night. obs_count guards against gap
-- days: too few observations means the runout verdict can't be trusted.
CREATE TABLE daily_features (
  date            TEXT PRIMARY KEY,      -- local YYYY-MM-DD
  dow             INTEGER NOT NULL,      -- 0=Sun..6=Sat (local)
  is_holiday      INTEGER NOT NULL DEFAULT 0,
  runout_minutes  INTEGER,
  obs_count       INTEGER NOT NULL DEFAULT 0,
  complete        INTEGER NOT NULL DEFAULT 1,
  synced_ts       INTEGER NOT NULL
);

-- Morning-window (06:00-11:00 local) weather per local day. One row per date; a
-- 'forecast' row is overwritten by 'actual' once the day is in the past.
-- precip_prob only exists from the forecast model (reanalysis has none).
CREATE TABLE weather_daily (
  date         TEXT PRIMARY KEY,          -- local YYYY-MM-DD
  kind         TEXT NOT NULL CHECK (kind IN ('actual','forecast')),
  temp_c       REAL,                      -- temperature_2m at 08:00 local
  precip_mm    REAL,                      -- precipitation sum, 06:00-11:00 local
  precip_prob  REAL,                      -- max precipitation_probability, 06:00-11:00
  wind_kmh     REAL,                      -- max wind_speed_10m, 06:00-11:00
  fetched_ts   INTEGER NOT NULL
);

-- One prediction per target day; re-runs upsert the estimate but never touch
-- actual_/finalized_/notified_ columns, so a double-fired cron can't double-send
-- push. predicted_minutes NULL + probability set = "unlikely to run out";
-- probability NULL = not enough data to say anything.
CREATE TABLE predictions (
  target_date        TEXT PRIMARY KEY,   -- local YYYY-MM-DD
  created_ts         INTEGER NOT NULL,
  predicted_minutes  INTEGER,
  probability        REAL,
  window_early       INTEGER,            -- weighted P25 (minutes since midnight)
  window_late        INTEGER,            -- weighted P75
  basis_json         TEXT NOT NULL,      -- explainability: kernels, effectiveN, top days
  actual_minutes     INTEGER,            -- backfilled once the target day completes
  error_minutes      INTEGER,            -- predicted - actual, when both non-NULL
  finalized_ts       INTEGER,
  notified_ts        INTEGER
);

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_ts  INTEGER NOT NULL,
  failures    INTEGER NOT NULL DEFAULT 0  -- consecutive send failures; pruned at 5
);
