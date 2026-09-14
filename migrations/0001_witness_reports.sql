-- Witness reports MVP (citizen early signal). Kept intentionally small:
-- one table, append-only, limited retention handled at query time.

create table if not exists witness_reports (
  id text primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('police', 'fire', 'crash', 'other')),
  note text,
  lat double precision not null,
  lng double precision not null,
  geo_precision text not null check (geo_precision in ('street','intersection','landmark','road','town','county','unknown')),
  accuracy_m integer,
  user_agent text
);

create index if not exists witness_reports_created_at_idx on witness_reports (created_at desc);
