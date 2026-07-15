-- Weather of the night that FOLLOWS this date's 10pm snapshot: precipitation
-- summed 20:00-02:00 (spilling into the next calendar day) and the dew point at
-- 22:00 (mugginess — night RH is uniformly high, dew point discriminates).
-- Overnight organic returns are the dominant force on the next morning's
-- starting inventory (6-23 bikes/night, trucks barely touch this station), and
-- they track how inviting the night is. Day D's morning is shaped by D-1's
-- night — the same date(-1) join the model already uses for evening_bikes.
ALTER TABLE weather_daily ADD COLUMN night_precip_mm REAL;
ALTER TABLE weather_daily ADD COLUMN night_dew_c REAL;

-- Flip settled rows back to 'forecast' so datesNeedingActuals re-fetches them
-- on the next run/backfill, filling the new columns for existing history
-- (upsertWeather COALESCEs precip_prob, so nothing is lost in the round trip).
UPDATE weather_daily SET kind = 'forecast';
