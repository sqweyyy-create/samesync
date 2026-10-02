-- Restricted runtime role (CLAUDE.md, Database; PLAN.md §3 layer 6).
-- The app connects as samesync_app: it does not own any table, so it cannot ALTER, DROP or
-- DISABLE TRIGGER, and as a non-superuser it cannot SET session_replication_role.
-- Created NOLOGIN here so migrations never contain a password; the login is configured outside
-- migrations (infra/postgres/init locally, the hosting provider in production).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samesync_app') THEN
    CREATE ROLE samesync_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO samesync_app;
--> statement-breakpoint
-- Least privilege: no DELETE. Every new table gets explicit grants in its own migration.
GRANT SELECT, INSERT, UPDATE ON TABLE users TO samesync_app;
