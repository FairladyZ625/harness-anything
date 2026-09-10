/**
 * Correctness oracles for tools/scale/cli-entity-bench.mjs over one frozen run. Every oracle is a
 * pure function of the recorded receipts, the read results and a read-only ledger store, so the
 * negative controls can feed each one a deliberately corrupted copy and require it to fail.
 */
import { createHash } from "node:crypto";
import { oracleO2 } from "../stress/core/oracles.mjs";

const verdict = (id, violations) => ({
  id,
  verdict: violations.length ? "FAIL" : "PASS",
  violations: violations.slice(0, 50),
  violationCount: violations.length,
});
const accepted = (write) => write.status === "accepted_durable";
const label = (write) => write.key ?? write.metric;

// B1: an acknowledged write is durable, a rejected one is not, and nothing durable is unacknowledged.
export function receiptOracle({ store, initRevision, writes }) {
  const violations = [],
    acknowledged = new Map();
  for (const write of writes.filter(accepted)) {
    if (store.readCommandOutcome(write.opId)?.status !== "accepted_durable")
      violations.push(`${label(write)}: accepted receipt ${write.opId} has no accepted outcome`);
    acknowledged.set(write.opId, (acknowledged.get(write.opId) ?? 0) + 1);
  }
  for (const [opId, count] of acknowledged) if (count > 1) violations.push(`opId ${opId} acknowledged ${count} times`);
  for (const write of writes.filter((write) => !accepted(write) && write.opId))
    if (store.readCommandOutcome(write.opId)?.status === "accepted_durable")
      violations.push(`${label(write)}: non-accepted receipt ${write.opId} has an accepted outcome`);
  const claimed = new Set(writes.flatMap((write) => (write.receipt ? collect(write.receipt, "opId") : [write.opId])));
  for (const outcome of store.outcomes())
    if (outcome.status === "accepted_durable" && outcome.firstRevision > initRevision && !claimed.has(outcome.opId))
      violations.push(`accepted outcome ${outcome.opId} (${outcome.summary}) has no acknowledged receipt`);
  return verdict("B1-receipt-durable", violations);
}

// B2: every value and file the bench wrote is in the accepted events or content objects, byte for byte.
export function readbackOracle({ store, writes }) {
  const violations = [];
  for (const write of writes.filter(
    (write) => accepted(write) && (write.values?.length || write.blobs?.length || write.expect),
  )) {
    const expect = write.expect ?? { values: write.values, blobs: write.blobs },
      outcome = store.readCommandOutcome(write.opId),
      strings = new Set();
    for (let revision = outcome?.firstRevision ?? 1; revision <= (outcome?.lastRevision ?? 0); revision++)
      collect(store.eventAtRevision(revision), null).forEach((value) => strings.add(value));
    const digests = [...strings]
        .map((value) => value.replace(/^sha256:/u, ""))
        .filter((value) => /^[0-9a-f]{64}$/u.test(value)),
      objects = digests
        .map((digest) => store.readContentObject(digest))
        .filter(Boolean)
        .map((bytes) => Buffer.from(bytes));
    for (const value of expect.values ?? [])
      if (!strings.has(value) && !objects.some((bytes) => bytes.includes(Buffer.from(value))))
        violations.push(`${label(write)}: ${JSON.stringify(value)} is not in accepted op ${write.opId}`);
    for (const blob of expect.blobs ?? []) {
      const digest = createHash("sha256").update(blob).digest("hex"),
        stored = digests.includes(digest) ? store.readContentObject(digest) : null;
      if (!stored || !Buffer.from(stored).equals(blob))
        violations.push(`${label(write)}: content ${digest} is not byte-exact in ${write.opId}`);
    }
  }
  return verdict("B2-readback-bytes", violations);
}

// B3: the read API shows every populated Task and entity with its exact title, and no deleted entity.
export function listOracle({ writes, lists, cliRows }) {
  const violations = [];
  const check = (listName, expected) => {
    const index = fieldIndex(lists[listName]);
    if (lists[listName]?.ok !== true)
      violations.push(`${listName}: list read failed (${lists[listName]?.code ?? lists[listName]?.error})`);
    for (const [id, title] of expected) {
      const holders = index.get(id) ?? [];
      if (!holders.length) violations.push(`${listName}: ${id} is not visible`);
      else if (!holders.some((holder) => Object.values(holder).includes(title)))
        violations.push(`${listName}: ${id} title differs from ${JSON.stringify(title)}`);
    }
  };
  const populated = writes.filter(
    (write) => accepted(write) && !write.metric?.startsWith("throughput") && write.values,
  );
  // Tasks the CLI arm superseded or soft-deleted must leave the default list; every other one stays.
  const retired = new Set(
    cliRows
      .filter((row) => ["task-supersede", "task-delete"].includes(row.metric) && row.ok === true)
      .map((row) => row.args[row.args.indexOf(row.metric === "task-delete" ? "--soft" : "supersede") + 1]),
  );
  check(
    "task",
    populated
      .filter((write) => write.kind === "task" && !retired.has(write.key))
      .map((write) => [write.key, write.values[0]]),
  );
  const taskIndex = fieldIndex(lists.task);
  for (const id of retired) if (taskIndex.has(id)) violations.push(`task: retired ${id} is still listed`);
  for (const listName of Object.keys(lists).filter((name) => name.startsWith("entity:"))) {
    const kind = listName.slice("entity:".length);
    check(
      listName,
      populated.filter((write) => write.kind === listName).map((write) => [write.entityId, write.values[0]]),
    );
    const index = fieldIndex(lists[listName]);
    for (const row of cliRows.filter((row) => row.metric === `entity-delete~${kind}` && row.ok === true))
      if (index.has(row.entityId)) violations.push(`${listName}: deleted ${row.entityId} is still listed`);
  }
  for (const row of cliRows.filter((row) => row.metric.startsWith("entity-get~deleted-")))
    if (row.ok === true) violations.push(`${row.metric}: deleted entity is still readable`);
  return verdict("B3-read-visibility", violations);
}

// B4: a full projection rebuild from the event store reproduces every incremental read exactly.
export function rebuildOracle({ beforeRebuild, afterRebuild }) {
  const violations = Object.keys(beforeRebuild).length ? [] : ["no rebuild evidence was recorded"];
  for (const [metric, before] of Object.entries(beforeRebuild)) {
    const after = afterRebuild[metric];
    if (before.ok !== true || after?.ok !== true)
      violations.push(`${metric}: read failed around rebuild (${before.code} / ${after?.code})`);
    else if (before.sha256 !== after.sha256) violations.push(`${metric}: rows differ after rebuild`);
  }
  return verdict("B4-rebuild-equivalence", violations);
}

// B5: the ledger itself is gap-free and duplicate-free (the stress O2 oracle, structural part).
export function structureOracle({ store, cut }) {
  const frozen = cut ?? ledgerCut(store),
    log = { complete: true, errors: [], records: [{ type: "campaign_started" }, { type: "campaign_completed" }] },
    observed = oracleO2({ authority: "sqlite", sqliteCut: frozen, receiptLog: log });
  return verdict("B5-ledger-structure", observed.violations);
}

export const ledgerCut = (store) => {
  const events = [];
  for (let revision = 1; revision <= store.revision(); revision++) {
    const identity = store.eventIdentityAtRevision(revision);
    if (identity) events.push({ workspaceRevision: revision, opId: identity.opId });
  }
  return { revision: store.revision(), events, outcomes: store.outcomes() };
};

export function runOracles(input) {
  input.cut ??= ledgerCut(input.store);
  return Object.fromEntries(
    [receiptOracle, readbackOracle, listOracle, rebuildOracle, structureOracle].map((oracle) => {
      const observed = oracle(input);
      return [observed.id, observed];
    }),
  );
}

// Each control corrupts one input the way a real defect would and requires its oracle to FAIL.
export function runNegativeControls(input) {
  const acceptedWrites = input.writes.filter((write) => accepted(write) && write.values && !write.receipt),
    sample = acceptedWrites.slice(0, 20),
    blobWrite = acceptedWrites.find((write) => write.blobs?.length),
    rejected = input.writes.find((write) => !accepted(write));
  const controls = [
    [
      "dropped-acknowledgement",
      receiptOracle,
      { ...input, writes: input.writes.filter((write) => write !== acceptedWrites[0]) },
    ],
    [
      "phantom-acceptance",
      receiptOracle,
      {
        ...input,
        writes: [
          ...sample,
          { ...(rejected ?? {}), key: "phantom", status: "accepted_durable", opId: "op-never-written" },
        ],
      },
    ],
    [
      "tampered-value",
      readbackOracle,
      { ...input, writes: [{ ...acceptedWrites[0], values: [`${acceptedWrites[0].values[0]}·`] }] },
    ],
    [
      "tampered-file-byte",
      readbackOracle,
      { ...input, writes: [{ ...blobWrite, blobs: [Buffer.concat([blobWrite.blobs[0], Buffer.from([0])])] }] },
    ],
    [
      "invisible-task",
      listOracle,
      {
        ...input,
        writes: [{ kind: "task", key: "bench-task-never-created", status: "accepted_durable", values: ["x"] }],
        cliRows: [],
      },
    ],
    [
      "rebuild-divergence",
      rebuildOracle,
      {
        ...input,
        afterRebuild: {
          ...input.afterRebuild,
          "task-list": { ...input.afterRebuild["task-list"], sha256: "0".repeat(64) },
        },
      },
    ],
    [
      "duplicate-revision",
      structureOracle,
      { ...input, cut: { ...input.cut, events: [...input.cut.events, input.cut.events[0]] } },
    ],
  ];
  return controls.map(([id, oracle, corrupted]) => {
    const observed = oracle(corrupted);
    return {
      id,
      oracle: observed.id,
      observed: observed.verdict,
      passed: observed.verdict === "FAIL",
      violations: observed.violations.slice(0, 3),
    };
  });
}

// Every string in a value, or every value of one key, walking JSON-string fields too.
function collect(root, key) {
  const found = [],
    stack = [root];
  while (stack.length) {
    let value = stack.pop();
    if (typeof value === "string" && /^[[{]/u.test(value))
      try {
        value = JSON.parse(value);
      } catch {
        if (key === null) found.push(value);
        continue;
      }
    if (typeof value === "string") {
      if (key === null) found.push(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [field, child] of Object.entries(value)) {
      if (key !== null && field === key && typeof child === "string") found.push(child);
      stack.push(child);
    }
  }
  return found;
}

// Map from every string field value to the objects that hold it directly.
function fieldIndex(receipt) {
  const index = new Map(),
    stack = [receipt?.evidence ?? receipt];
  while (stack.length) {
    let value = stack.pop();
    if (typeof value === "string" && /^[[{]/u.test(value))
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    if (!value || typeof value !== "object") continue;
    for (const child of Object.values(value)) {
      if (typeof child !== "string") stack.push(child);
      else if (index.has(child)) index.get(child).push(value);
      else index.set(child, [value]);
    }
  }
  return index;
}
