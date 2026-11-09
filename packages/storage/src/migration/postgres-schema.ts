/** Management-only DDL. The repository epoch row also fences head creation, not just existing tuples. */
export const POSTGRES_STORAGE_MIGRATION_SCHEMA = Object.freeze([
  "ALTER TABLE ha_repo_heads ADD COLUMN IF NOT EXISTS migration_control jsonb",
  "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS recorded_at_text text",
  "ALTER TABLE ha_command_outcomes ADD COLUMN IF NOT EXISTS recorded_at_text text",
  /* @gate-identity state-store/legacy.08f7973ac3aab6c4 */ `CREATE TABLE IF NOT EXISTS ha_repo_writer_epochs (
    repo_id text PRIMARY KEY,
    writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
    writer_holder_id text,
    writer_issued_at text,
    migration_control jsonb,
    activation_markers jsonb NOT NULL DEFAULT '{}'::jsonb
  )`,
  "ALTER TABLE ha_repo_writer_epochs ADD COLUMN IF NOT EXISTS writer_issued_at text",
  "REVOKE ALL ON ha_repo_writer_epochs FROM PUBLIC",
  // All append/rejection transactions first INSERT ... ON CONFLICT on their scoped head. A trigger
  // runs even on conflict, before that head's row lock. Its shared repository lock lasts until commit;
  // management takes the same row FOR UPDATE before inspecting cuts or changing the writer epoch.
  // Runtime roles cannot read/write the management table or invoke this trigger function directly.
  `CREATE OR REPLACE FUNCTION public.ha_inherit_repo_writer_epoch() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fence$
    DECLARE authority public.ha_repo_writer_epochs%ROWTYPE;
    BEGIN
      INSERT INTO public.ha_repo_writer_epochs(repo_id) VALUES(NEW.repo_id) ON CONFLICT DO NOTHING;
      SELECT * INTO STRICT authority FROM public.ha_repo_writer_epochs WHERE repo_id=NEW.repo_id FOR SHARE;
      NEW.migration_control := authority.migration_control;
      IF NEW.writer_epoch < authority.writer_epoch THEN
        NEW.writer_epoch := authority.writer_epoch;
        NEW.writer_holder_id := authority.writer_holder_id;
      END IF;
      RETURN NEW;
    END $fence$`,
  "REVOKE ALL ON FUNCTION public.ha_inherit_repo_writer_epoch() FROM PUBLIC",
  `CREATE OR REPLACE TRIGGER ha_repo_writer_epoch BEFORE INSERT OR UPDATE ON ha_repo_heads
    FOR EACH ROW EXECUTE FUNCTION public.ha_inherit_repo_writer_epoch()`,
]);
