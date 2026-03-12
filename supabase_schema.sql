-- ═══════════════════════════════════════════════════════════════════════════
-- GasWatch Pro — Supabase Database Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── TABLE: gas_levels ────────────────────────────────────────────────────
-- Stores gas cylinder level readings from the DYP-L06 ultrasonic sensor.
-- The ESP32 inserts a row every 5 seconds.

create table if not exists gas_levels (
  id               bigint generated always as identity primary key,
  level_percent    float  not null check (level_percent >= 0 and level_percent <= 100),
  raw_distance_mm  float,          -- raw ultrasonic distance reading in millimetres
  created_at       timestamptz     default now() not null
);

-- Row Level Security
alter table gas_levels enable row level security;

-- Allow anyone to read (dashboard is public-facing)
create policy "Public read — gas_levels"
  on gas_levels for select using (true);

-- Allow ESP32 (using anon key) to insert
create policy "Public insert — gas_levels"
  on gas_levels for insert with check (true);

-- Index for fast time-range queries used in analytics
create index if not exists idx_gas_levels_created_at
  on gas_levels (created_at desc);


-- ─── TABLE: gas_leakages ──────────────────────────────────────────────────
-- Stores every leakage classification event from the MQ6 gas sensor.
-- The ESP32 inserts a row every 5 seconds with severity: safe | low | high.

create table if not exists gas_leakages (
  id          bigint generated always as identity primary key,
  severity    text   not null check (severity in ('safe', 'low', 'high')),
  raw_value   float,              -- raw ADC reading from MQ6 (0–4095 on ESP32)
  ppm_approx  float,              -- estimated LPG concentration in ppm
  created_at  timestamptz         default now() not null
);

alter table gas_leakages enable row level security;

create policy "Public read — gas_leakages"
  on gas_leakages for select using (true);

create policy "Public insert — gas_leakages"
  on gas_leakages for insert with check (true);

create index if not exists idx_gas_leakages_created_at
  on gas_leakages (created_at desc);

create index if not exists idx_gas_leakages_severity
  on gas_leakages (severity);


-- ─── ENABLE REALTIME ──────────────────────────────────────────────────────
-- This makes Supabase broadcast new rows to the React app via WebSocket.
-- After running this SQL, ALSO enable Realtime manually:
--   Supabase Dashboard → Database → Replication → enable both tables.

alter publication supabase_realtime add table gas_levels;
alter publication supabase_realtime add table gas_leakages;


-- ─── ANALYTICS VIEWS ──────────────────────────────────────────────────────

-- View: weekly leakage counts grouped by day
create or replace view weekly_leak_summary as
select
  date_trunc('day', created_at at time zone 'UTC') as day,
  count(*) filter (where severity = 'high') as high_count,
  count(*) filter (where severity = 'low')  as low_count,
  count(*) filter (where severity != 'safe') as total_count
from gas_leakages
where created_at >= now() - interval '7 days'
group by day
order by day;

-- View: daily average gas level (usage trend)
create or replace view daily_gas_usage as
select
  date_trunc('day', created_at at time zone 'UTC') as day,
  round(avg(level_percent)::numeric, 1)  as avg_level,
  round(min(level_percent)::numeric, 1)  as min_level,
  round(max(level_percent)::numeric, 1)  as max_level,
  count(*)                               as reading_count
from gas_levels
where created_at >= now() - interval '30 days'
group by day
order by day;


-- ─── OPTIONAL: Auto-clean old data ────────────────────────────────────────
-- Keep only last 30 days of gas_levels (sensor fires every 5s = 518,400 rows/month)
-- Uncomment and run as a scheduled function in Supabase if needed.

-- create or replace function cleanup_old_readings()
-- returns void language plpgsql as $$
-- begin
--   delete from gas_levels   where created_at < now() - interval '30 days';
--   delete from gas_leakages where created_at < now() - interval '90 days';
-- end;
-- $$;
