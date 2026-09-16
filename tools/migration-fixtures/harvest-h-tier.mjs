// Harvests H-tier migration-source fixtures from a consistent snapshot of the canonical
// gen2 ledger (created with `sqlite3 <ledger> .backup`, source opened mode=ro).
// Real stored event rows are de-identified with the existing gate sampler's scrubber, then
// checked: every digest-bearing subobject is re-hashed before/after scrubbing so the manifest
// records exactly which digest inputs the de-identification touched.
// Run from the worktree root: node tools/migration-fixtures/harvest-h-tier.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { reviewDigest, submissionDigest } from "../../packages/kernel/src/index.ts";
import { deidentifyCanonicalEvent } from "../gates/sample-canonical-events.mjs";

import { appendManifestEntry, cleanFixtureDir, freezeRows, sha256 } from "./lib.mjs";

const CANONICAL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..");
const CANONICAL_LEDGER = path.join(CANONICAL_ROOT, ".harness", "store", "generations", "2", "ledger.sqlite");
const CONVERSION_PLAN = path.join(
  CANONICAL_ROOT,
  ".harness",
  "store",
  "generations",
  "2",
  "ledger.sqlite.conversion.json",
);

function snapshotCanonicalLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), "s6-snapshot-"));
  const target = path.join(dir, "ledger.sqlite");
  execFileSync("sqlite3", [`file:${CANONICAL_LEDGER}?mode=ro`, `.backup '${target}'`]);
  return target;
}

// Find every subobject that feeds a recomputable digest and hash it before/after scrubbing.
// Walks both trees in parallel so each digest input is compared at the same pointer.
function digestInputReport(event, scrubbed) {
  const report = [];
  const visit = (value, otherValue, at) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, i) => visit(entry, Array.isArray(otherValue) ? otherValue[i] : undefined, `${at}/${i}`));
      return;
    }
    if ("completionClaim" in value && "commitSha" in value && "deliverables" in value) {
      try {
        const before = submissionDigest(value);
        const after = otherValue ? submissionDigest(otherValue) : null;
        if (before !== after) report.push({ kind: "submissionDigest", at: at || "/", before, after });
      } catch {
        /* not a SubmissionV1 */
      }
    }
    if ("reviewId" in value && "verdict" in value && "reviewedAt" in value) {
      try {
        const before = reviewDigest(value);
        const after = otherValue ? reviewDigest(otherValue) : null;
        if (before !== after) report.push({ kind: "reviewDigest", at: at || "/", before, after });
      } catch {
        /* not a ReviewV1 */
      }
    }
    for (const [key, nested] of Object.entries(value))
      visit(nested, otherValue && typeof otherValue === "object" ? otherValue[key] : undefined, `${at}/${key}`);
  };
  visit(event, scrubbed, "");
  return report;
}

function harvestTask(db, taskId, { limit } = {}) {
  const rows = db
    .prepare(
      "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE event_json LIKE ? ORDER BY revision",
    )
    .all(`%${taskId}%`);
  return limit && rows.length > limit ? rows.filter((_, i) => i % Math.ceil(rows.length / limit) === 0) : rows;
}

function processRows(rows) {
  const digestsDrifted = [];
  const out = rows.map((row) => {
    const event = JSON.parse(row.event_json);
    const scrubbed = deidentifyCanonicalEvent(event);
    const drift = digestInputReport(event, scrubbed);
    if (drift.length) digestsDrifted.push({ revision: row.revision, opId: row.op_id, drift });
    const scrubbedJson = JSON.stringify(scrubbed);
    const unchanged = scrubbedJson === row.event_json;
    return {
      revision: row.revision,
      op_id: row.op_id,
      digest: unchanged ? row.digest : `sha256:${sha256(scrubbedJson)}`,
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
      event_json: scrubbedJson,
      ...(unchanged ? {} : { source_digest: row.digest }),
    };
  });
  return { rows: out, digestsDrifted };
}

function emitFixture(id, meta, rows) {
  const { rows: processed, digestsDrifted } = processRows(rows);
  const dir = cleanFixtureDir(id);
  freezeRows(processed, dir, {
    fixture: id,
    tier: "H",
    source: "canonical gen2 snapshot (sqlite .backup, mode=ro), de-identified",
    deidentification: {
      tool: "tools/gates/sample-canonical-events.mjs deidentifyCanonicalEvent",
      digestInputDrift: digestsDrifted.length > 0,
      drifted: digestsDrifted,
    },
    ...meta,
  });
  writeFileSync(path.join(dir, "digest-check.json"), JSON.stringify({ digestsDrifted }, null, 2) + "\n");
  appendManifestEntry({
    id,
    tier: "H",
    path: id,
    ...meta.manifest,
    eventCount: processed.length,
    deidentifiedDigestDrift: digestsDrifted.length > 0,
  });
  console.log(`${id}: ${processed.length} rows, digestInputDrift=${digestsDrifted.length > 0}`);
  return digestsDrifted;
}

function main() {
  if (!existsSync(CANONICAL_LEDGER)) throw new Error(`canonical ledger not found: ${CANONICAL_LEDGER}`);
  const snapshot = snapshotCanonicalLedger();
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const head = db.prepare("SELECT max(revision) AS head FROM event").get().head;
  console.log(`snapshot head revision ${head}`);

  // Task-scoped historical shapes (design doc §7 representative tasks).
  const taskTargets = [
    ["h-x3-non-actor-amend", "task_f4b56d482e26280d51859359aa", "X3 非原 actor amend(amendedBy)"],
    ["h-x4-consent-then-amend", "task_32212e8ed7cc70b84823eee952", "X4 先 consent 后 amend"],
    ["h-x9-unprovenanced-witness", "task_053af663301df54d9a92692b64", "X9 无 basis/provenance/observed 已接受 witness"],
    ["h-x9-unprovenanced-witness-b", "task_06bae07e93db25a86588e4ac05", "X9 备选 task"],
    ["h-x11-mixed-witness-forms", "task_8f073d9d9b90214a34a4050c28", "X11 同 task 两种 witness 形态"],
    ["h-x11-duplicate-witness", "task_834acadebf9c0ca09ed09687ed", "X11 同 exec+gate 重复 witness"],
    ["h-x14-ledger-commit-delivery", "task_f3d0dc4ecdb2fdb8ba24692b1c", "X14 台账仓 commit 交付(privateDelivery 前身)"],
    ["h-x15-unresolvable-commit", "task_12b143fd682b0a48e01602a9f8", "X15 commit 在两个仓都解析不到"],
    [
      "h-x19-suspended-on-terminal",
      "task_e87de4b515c52c01dd285b8320",
      "X19 终态任务上的悬置 execution(cancel 时 active)",
    ],
    ["h-x19-suspended-on-terminal-b", "task_18fbac3907458c9a3d5bda12a8", "X19 preset 升级抬 iteration 遗留"],
    ["h-x20-zombie-runtime", "task_962979dec24a440f06e5f3259b", "X20 僵尸 runtime session(无 exit)"],
  ];
  for (const [id, taskId, shape] of taskTargets) {
    const rows = harvestTask(db, taskId);
    if (rows.length === 0) {
      console.log(`${id}: no rows for ${taskId} — skipped`);
      continue;
    }
    emitFixture(id, { manifest: { shapes: [shape], sourceTaskId: taskId } }, rows);
  }

  // X18: historical reviewer-dispatch events still exist in the ledger even though none are
  // in flight today (O3). Harvest the dispatch-requested rows so the migrator sees the real
  // task-review:/complete-review: idempotency-key shapes; no cancellation marker is invented.
  for (const [prefix, id, shape] of [
    ["task-review:", "h-x18-reviewer-dispatch", "X18 在途 reviewer 派工(task-review: idempotencyKey)"],
    ["complete-review:", "h-x18-complete-review-dispatch", "X18 complete-review: 派工"],
  ]) {
    const rows = db
      .prepare(
        "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE event_json LIKE '%runtime_dispatch_requested%' AND event_json LIKE ? ORDER BY revision LIMIT 6",
      )
      .all(`%${prefix}%`);
    emitFixture(id, { manifest: { shapes: [shape], sourceTaskId: null, idempotencyPrefix: prefix } }, rows);
  }

  // X24: gen1→gen2 retained / preservedHistorical events, selected by conversion disposition.
  {
    const plan = existsSync(CONVERSION_PLAN) ? JSON.parse(readFileSync(CONVERSION_PLAN, "utf8")) : { mappings: [] };
    const byDisposition = new Map();
    for (const m of plan.mappings ?? []) {
      const bucket =
        m.disposition !== "converted"
          ? m.disposition
          : (m.reasons ?? []).some((reason) => reason.includes("preserved read-only"))
            ? "preserved-historical"
            : null;
      if (bucket === null) continue;
      if (!byDisposition.has(bucket)) byDisposition.set(bucket, []);
      byDisposition.get(bucket).push(m.destinationRevision);
    }
    for (const [disposition, revisions] of byDisposition) {
      const sample =
        revisions.length > 60 ? revisions.filter((_, i) => i % Math.ceil(revisions.length / 60) === 0) : revisions;
      const rows = sample
        .map((rev) =>
          db
            .prepare(
              "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE revision = ?",
            )
            .get(rev),
        )
        .filter(Boolean);
      emitFixture(
        `h-x24-${disposition.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}`,
        {
          manifest: {
            shapes: [`X24 gen1→gen2 ${disposition} 事件(样本 ${rows.length}/${revisions.length})`],
            sourceTaskId: null,
            disposition,
          },
        },
        rows,
      );
    }
  }

  // X25: documents_written rows whose baseLedgerSha.headDigest does not match the referenced
  // revision's real head digest (recompute per consumers §5 algorithm).
  {
    const rows = db
      .prepare(
        "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE event_json LIKE '%baseLedgerSha%' ORDER BY revision",
      )
      .all();
    const byRevision = new Map(
      db
        .prepare("SELECT revision, op_id, digest FROM event")
        .all()
        .map((r) => [r.revision, r]),
    );
    const stale = rows.filter((row) => {
      const event = JSON.parse(row.event_json);
      const base = event.payload?.baseLedgerSha;
      if (!base?.revision || !base?.headDigest) return false;
      const target = byRevision.get(base.revision);
      if (!target) return false;
      const recomputed = `sha256:${sha256(
        JSON.stringify({ eventDigest: target.digest, opId: target.op_id, revision: target.revision }) + "\n",
      )}`;
      return recomputed !== base.headDigest;
    });
    emitFixture(
      "h-x25-stale-base-ledger-sha",
      {
        manifest: {
          shapes: ["X25 过期的 baseLedgerSha.headDigest"],
          sourceTaskId: null,
        },
      },
      stale.slice(0, 80),
    );
  }

  // X26: ci_run_observed v2 (all) + a v3 sample for pairing.
  {
    const v2All = db
      .prepare(
        "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE event_json LIKE '%\"ci-run-observation/v2\"%' ORDER BY revision",
      )
      .all();
    // v2 rows embed full check-run payloads (~0.3–0.8 MB each); sample evenly — the full
    // set is covered by X30 (R-tier full-scale run against a fresh snapshot).
    const v2 = v2All.filter((_, i) => i % Math.ceil(v2All.length / 40) === 0);
    emitFixture(
      "h-x26-ci-run-observation-v2",
      {
        manifest: { shapes: [`X26 ci_run_observed v2(均匀采样 ${v2.length}/${v2All.length})`], sourceTaskId: null },
      },
      v2,
    );
    const v3 = db
      .prepare(
        "SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event WHERE event_json LIKE '%\"ci-run-observation/v3\"%' ORDER BY revision LIMIT 40",
      )
      .all();
    emitFixture(
      "h-x26-ci-run-observation-v3-sample",
      {
        manifest: { shapes: ["X26 ci_run_observed v3(对照样本)"], sourceTaskId: null },
      },
      v3,
    );
  }

  db.close();
}

main();
