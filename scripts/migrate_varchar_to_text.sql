-- Migration: Widen VARCHAR columns to TEXT to prevent
-- "value too long for type character varying(255)" errors.
-- Safe to run on existing Railway Postgres — ALTER TYPE does not drop data.
-- Run with: psql $DATABASE_URL -f scripts/migrate_varchar_to_text.sql

BEGIN;

ALTER TABLE incidents ALTER COLUMN id TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN external_id TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN title TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN source_name TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN source_url TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN address_text TYPE TEXT;
ALTER TABLE incidents ALTER COLUMN municipality TYPE VARCHAR(200);

COMMIT;
