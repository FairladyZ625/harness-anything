import type { DatabaseSync } from "node:sqlite";

export function createDecisionProjectionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision (decision_id TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL, risk_tier TEXT NOT NULL, urgency TEXT NOT NULL, vertical TEXT NOT NULL, preset TEXT NOT NULL, decision_class TEXT NOT NULL, applies_json TEXT NOT NULL, proposer_json TEXT NOT NULL, arbiter_json TEXT, proposed_at TEXT NOT NULL, decided_at TEXT, provenance_json TEXT NOT NULL DEFAULT '[]', workspace_revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS decision_option (decision_id TEXT NOT NULL, kind TEXT NOT NULL, option_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, rationale TEXT, workspace_revision INTEGER NOT NULL, PRIMARY KEY(decision_id, kind, option_id));
    CREATE TABLE IF NOT EXISTS decision_claim (decision_id TEXT NOT NULL, claim_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, load_bearing INTEGER NOT NULL, fulfillment TEXT, declared_revision INTEGER NOT NULL, fulfilled_revision INTEGER, PRIMARY KEY(decision_id, claim_id));
    CREATE TABLE IF NOT EXISTS decision_judgment_consent (consent_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decision_amendment (amendment_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decision_content_pin (pin_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS decision_fts USING fts5(decision_id UNINDEXED, title, question, option_text, claim_text, body, tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX IF NOT EXISTS decision_filter ON decision(state, risk_tier, urgency, vertical);
    CREATE INDEX IF NOT EXISTS decision_state_page ON decision(state, decision_id);
    CREATE INDEX IF NOT EXISTS decision_judgment_consent_owner ON decision_judgment_consent(decision_id, workspace_revision);
    CREATE INDEX IF NOT EXISTS decision_amendment_owner ON decision_amendment(decision_id, workspace_revision);
    CREATE INDEX IF NOT EXISTS decision_content_pin_owner ON decision_content_pin(decision_id, workspace_revision);
  `);
}
