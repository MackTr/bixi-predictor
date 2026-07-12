-- Bikes available at 21:00 local, step-held from the last observation at or
-- before 9pm. Day D's morning starts from D-1's evening inventory, and the 9pm
-- prediction run knows today's value live — a symmetric feature, so the model
-- can weigh history by starting bike count ("what if the station isn't full at
-- 9pm"). NULL until a (re-)sync covers that evening: run admin/backfill?force=1
-- once after deploying this migration to fill history.
ALTER TABLE daily_features ADD COLUMN evening_bikes INTEGER;
