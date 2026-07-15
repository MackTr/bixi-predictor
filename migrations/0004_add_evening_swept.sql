-- Bikes removed by rebalancing-truck bursts between 17:00 and 22:00 local
-- (burst = consecutive same-direction drops <=5min apart totaling >=5 bikes —
-- trucks load ~2/min, organic trips are isolated +-1..3). The truck harvests
-- this station most weekday evenings, so a post-sweep 10pm count of 3 means
-- something completely different from an organic-drain 3 (swept evenings
-- refill organically overnight; organic drains stay low). NULL until a
-- (re-)sync covers the evening: run admin/backfill?force=1 after deploying.
ALTER TABLE daily_features ADD COLUMN evening_swept INTEGER;
