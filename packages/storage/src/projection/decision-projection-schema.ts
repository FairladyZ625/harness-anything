import type { DatabaseSync } from "node:sqlite";

/** `appliesTo.modules` entry → repository-relative prefix: `\` to `/`, one leading `./`, no trailing `/`. */
const moduleExpression = (value: string) => {
  const slashed = `replace(trim(${value}), char(92), '/')`;
  return `rtrim(CASE WHEN substr(${slashed}, 1, 2) = './' THEN substr(${slashed}, 3) ELSE ${slashed} END, '/')`;
};
const appliesModuleRows = (owner: string, from: string) =>
  `SELECT module_prefix, decision_id FROM (SELECT ${moduleExpression("module.value")} AS module_prefix, ${owner} AS decision_id` +
  ` FROM ${from} WHERE module.type = 'text') WHERE module_prefix <> ''`;
const refillAppliesModules = `
    DELETE FROM decision_applies_module WHERE decision_id = NEW.decision_id;
    INSERT OR IGNORE INTO decision_applies_module(module_prefix, decision_id)
      ${appliesModuleRows("NEW.decision_id", "json_each(NEW.applies_json, '$.modules') AS module")};`;
/**
 * dec_9979850C7CE87C17271D78E4D1 CH2: path → governing decision lookups probe this prefix table
 * instead of decoding every decision's applies JSON. Triggers own the derivation for every writer;
 * a projection that predates the triggers is filled once before creating them inside the DDL batch.
 */
const DECISION_APPLIES_MODULE_TABLE_SQL = `
    /* @gate-identity state-store/task.projection.decision_applies_module */ CREATE TABLE IF NOT EXISTS decision_applies_module (
      module_prefix TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      PRIMARY KEY(module_prefix, decision_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS decision_applies_module_owner ON decision_applies_module(decision_id);`;
const DECISION_APPLIES_MODULE_TRIGGER_SQL = `
    CREATE TRIGGER IF NOT EXISTS decision_applies_module_insert AFTER INSERT ON decision
    BEGIN${refillAppliesModules}
    END;
    CREATE TRIGGER IF NOT EXISTS decision_applies_module_update AFTER UPDATE OF applies_json ON decision
    BEGIN${refillAppliesModules}
    END;
    CREATE TRIGGER IF NOT EXISTS decision_applies_module_delete AFTER DELETE ON decision
    BEGIN
      DELETE FROM decision_applies_module WHERE decision_id = OLD.decision_id;
    END;`;

export function createDecisionProjectionTables(db: DatabaseSync): void {
  /* @gate-identity state-store/task.source.storage.src.projection.decision-projection-schema.sqlite-database */ db.exec(`
    /* @gate-identity state-store/task.projection.decision */ CREATE TABLE IF NOT EXISTS decision (
      decision_id TEXT PRIMARY KEY,
      legacy_number INTEGER,
      decision_sort_key TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      urgency TEXT NOT NULL,
      vertical TEXT NOT NULL,
      preset TEXT NOT NULL,
      decision_class TEXT NOT NULL,
      applies_json TEXT NOT NULL,
      proposer_json TEXT NOT NULL,
      arbiter_json TEXT,
      proposed_at TEXT NOT NULL,
      decided_at TEXT,
      provenance_json TEXT NOT NULL DEFAULT '[]',
      workspace_revision INTEGER NOT NULL,
      list_options_json TEXT NOT NULL DEFAULT '{"chosen":[],"rejected":[]}',
      review_summary_json TEXT
    );
    /* @gate-identity state-store/task.projection.decision_option */ CREATE TABLE IF NOT EXISTS decision_option (
      decision_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      option_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      rationale TEXT,
      workspace_revision INTEGER NOT NULL,
      PRIMARY KEY(decision_id, kind, option_id)
    );
    /* @gate-identity state-store/task.projection.decision_claim */ CREATE TABLE IF NOT EXISTS decision_claim (
      decision_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      load_bearing INTEGER NOT NULL,
      fulfillment TEXT,
      declared_revision INTEGER NOT NULL,
      fulfilled_revision INTEGER,
      PRIMARY KEY(decision_id, claim_id)
    );
    /* @gate-identity state-store/task.projection.decision_judgment_consent */ CREATE TABLE IF NOT EXISTS decision_judgment_consent (
      consent_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    /* @gate-identity state-store/task.projection.decision_amendment */ CREATE TABLE IF NOT EXISTS decision_amendment (
      amendment_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    /* @gate-identity state-store/task.projection.decision_content_pin */ CREATE TABLE IF NOT EXISTS decision_content_pin (
      pin_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    /* @gate-identity state-store/task.projection.decision_review_event */ CREATE TABLE IF NOT EXISTS decision_review_event (
      event_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    /* @gate-identity state-store/task.projection.decision_fts */ CREATE VIRTUAL TABLE IF NOT EXISTS decision_fts USING fts5(
      decision_id UNINDEXED,
      title,
      question,
      option_text,
      claim_text,
      body,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE INDEX IF NOT EXISTS decision_filter ON decision(state, risk_tier, urgency, vertical);
    CREATE INDEX IF NOT EXISTS legacy_block ON decision(legacy_number, decision_sort_key, decision_id)
      WHERE legacy_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS plain_block ON decision(decision_sort_key, decision_id)
      WHERE legacy_number IS NULL;
    CREATE INDEX IF NOT EXISTS decision_state_legacy_page
      ON decision(state, legacy_number, decision_sort_key, decision_id) WHERE legacy_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS decision_state_plain_page
      ON decision(state, decision_sort_key, decision_id) WHERE legacy_number IS NULL;
    CREATE INDEX IF NOT EXISTS decision_state_page ON decision(state, decision_id);
    CREATE INDEX IF NOT EXISTS decision_judgment_consent_owner
      ON decision_judgment_consent(decision_id, workspace_revision);
    CREATE INDEX IF NOT EXISTS decision_amendment_owner ON decision_amendment(decision_id, workspace_revision);
    CREATE INDEX IF NOT EXISTS decision_content_pin_owner ON decision_content_pin(decision_id, workspace_revision);
    CREATE INDEX IF NOT EXISTS decision_review_event_owner
      ON decision_review_event(decision_id, workspace_revision);
    ${DECISION_APPLIES_MODULE_TABLE_SQL}
    INSERT OR IGNORE INTO decision_applies_module(module_prefix, decision_id)
      ${appliesModuleRows(
        "decision.decision_id",
        "decision, json_each(decision.applies_json, '$.modules') AS module",
      )} AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'decision_applies_module_insert');
    ${DECISION_APPLIES_MODULE_TRIGGER_SQL}
  `);
}
