-- audit_checkpoints is append-only too: a signed checkpoint is evidence.
-- Reuses the trigger function from 0002. TRUNCATE (db:seed) is still allowed.
CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();
