-- Nearby serious-activity web push MVP.
-- Stores opt-in push subscriptions and a simple delivery-dedupe log so a given
-- subscriber is not spammed repeatedly for the same incident id.

create table if not exists push_subscriptions (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Web Push subscription endpoint + keys.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,

  -- User preferences (MVP).
  radius_miles integer not null check (radius_miles in (1,2,3)),
  severity_floor text not null check (severity_floor in ('high','critical')),

  -- Subscriber location (optional): when missing, treat as county-wide fallback.
  lat double precision,
  lng double precision,
  accuracy_m integer,
  geo_precision text check (geo_precision in ('street','intersection','landmark','road','town','county','unknown')),

  user_agent text,
  disabled boolean not null default false,
  disabled_reason text
);

create index if not exists push_subscriptions_created_at_idx on push_subscriptions (created_at desc);
create index if not exists push_subscriptions_disabled_idx on push_subscriptions (disabled, updated_at desc);

create table if not exists push_deliveries (
  id text primary key,
  created_at timestamptz not null default now(),
  subscription_id text not null references push_subscriptions(id) on delete cascade,
  incident_id text not null,
  sent_at timestamptz not null default now(),
  status text not null check (status in ('sent','failed')),
  error text
);

create unique index if not exists push_deliveries_unique on push_deliveries (subscription_id, incident_id);
create index if not exists push_deliveries_sent_at_idx on push_deliveries (sent_at desc);

