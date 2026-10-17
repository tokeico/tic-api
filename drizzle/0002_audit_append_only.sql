-- audit_events is append-only (spec 8.9). Reject UPDATE and DELETE at the DB
-- level so not even a buggy route handler can rewrite history.
-- TRUNCATE is still allowed so `bun run db:seed` can reset the demo.
-- Tamper tests can bypass this with:
--   ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;
CREATE OR REPLACE FUNCTION audit_events_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();
