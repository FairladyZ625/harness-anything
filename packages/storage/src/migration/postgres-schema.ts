/** Management-only additions used by the cold migration Action; runtime adapters never run DDL. */
export const POSTGRES_STORAGE_MIGRATION_SCHEMA = Object.freeze([
  "ALTER TABLE ha_repo_heads ADD COLUMN IF NOT EXISTS migration_control jsonb",
  "ALTER TABLE ha_repo_heads ADD COLUMN IF NOT EXISTS activation_markers jsonb NOT NULL DEFAULT '{}'::jsonb",
  "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS recorded_at_text text",
  "ALTER TABLE ha_command_outcomes ADD COLUMN IF NOT EXISTS recorded_at_text text",
]);
