-- Runs once, when the PostgreSQL volume is first created (docker-entrypoint-initdb.d).
-- The application connects as `wagering_app`: it can read and write the tables but has NO privilege to UPDATE or
-- DELETE a ledger entry (the grants are applied by migration 0003 once the tables exist; triggers also block the
-- schema owner). Migrations run as the owner `wagering`.
CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE wagering TO wagering_app;
