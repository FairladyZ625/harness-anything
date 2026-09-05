/**
 * Frozen S1 oracle interface for S2-S4.
 *
 * Exports oracleO1..oracleO8, runOracles(input), and
 * runOracleNegativeControls(input). Every oracle is pure: callers freeze the
 * receipt log and target cut before invoking it. PASS is impossible when the
 * controller log is incomplete, a watchdog fired, or required evidence is
 * absent.
 */
import { createHash } from "node:crypto";
import { classifyReceiptLog } from "./receipt-log.mjs";

const pass = (id) => result(id, "PASS", []);
const fail = (id, violations) => result(id, "FAIL", violations);

export function oracleO1(input) {
  const id = "O1";
  const classified = classifyReceiptLog(input.receiptLog);
  if (!classified.complete) return result(id, "INCOMPLETE", classified.errors);
  const violations = [];
  for (const pair of classified.accepted) {
    const outcome = outcomeFor(input.cut, pair.request.opId);
    if (outcome?.status !== "accepted_durable")
      violations.push(`accepted request ${pair.request.requestId} is absent from the frozen cut`);
    checkExpectedCommand(input.cut, pair.request, true, violations);
  }
  for (const pair of classified.rejected) {
    const outcome = outcomeFor(input.cut, pair.request.opId);
    if (outcome && outcome.intentDigest === pair.request.intentDigest && outcome.status !== "rejected")
      violations.push(`rejected request ${pair.request.requestId} has an accepted outcome`);
    checkExpectedCommand(input.cut, pair.request, false, violations);
  }
  for (const pair of classified.unacknowledged) {
    const matching = expectedEvents(input.cut, pair.request);
    if (matching.length !== 0 && matching.length !== pair.request.expectedEvents.length)
      violations.push(`unacknowledged request ${pair.request.requestId} is only partly present`);
    const outcome = outcomeFor(input.cut, pair.request.opId);
    if (outcome && outcome.status !== "accepted_durable")
      violations.push(`unacknowledged request ${pair.request.requestId} has events without a durable outcome`);
  }
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO2(input) {
  const id = "O2";
  const violations = [];
  const revisions = input.cut.events.map((event) => event.workspaceRevision);
  if (new Set(revisions).size !== revisions.length) violations.push("event revisions are not unique");
  for (const [index, revision] of [...revisions].sort((left, right) => left - right).entries())
    if (revision !== index + 1) violations.push(`event revision ${revision} does not equal ${index + 1}`);
  if (input.cut.revision !== revisions.length)
    violations.push(`ledger head ${input.cut.revision} does not equal event count ${revisions.length}`);
  const eventOpIds = input.cut.events.map((event) => event.opId);
  if (new Set(eventOpIds).size !== eventOpIds.length) violations.push("event opIds are not unique");
  const outcomeOpIds = input.cut.outcomes.map((outcome) => outcome.opId);
  if (new Set(outcomeOpIds).size !== outcomeOpIds.length) violations.push("command outcomes are not unique");

  const classified = classifyReceiptLog(input.receiptLog);
  if (!classified.complete) return result(id, "INCOMPLETE", classified.errors);
  for (const pair of [...classified.accepted, ...classified.rejected]) {
    const outcome = outcomeFor(input.cut, pair.request.opId);
    if (!outcome) {
      violations.push(`terminal request ${pair.request.requestId} has no command outcome`);
      continue;
    }
    if (pair.receipt.status === "accepted_durable") {
      if (outcome.intentDigest !== pair.request.intentDigest)
        violations.push(`outcome intent differs for ${pair.request.requestId}`);
      validateAcceptedRange(input.cut, outcome, pair.request, violations);
    } else if (outcome.intentDigest === pair.request.intentDigest) {
      if (outcome.status !== "rejected") violations.push(`rejected command ${pair.request.requestId} was accepted`);
      if (outcome.firstRevision !== null || outcome.lastRevision !== null)
        violations.push(`rejected command ${pair.request.requestId} owns a revision range`);
    }
  }
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO3(input) {
  const id = "O3";
  if (!input.content) return result(id, "INCOMPLETE", ["content closure evidence is missing"]);
  const accepted = acceptedOpIds(input.receiptLog);
  const violations = [];
  for (const claim of input.content.claims) {
    if (claim.acceptedOpId && !accepted.has(claim.acceptedOpId)) continue;
    const object = input.content.objects[claim.sha256];
    if (!object) {
      violations.push(`content object ${claim.sha256} is missing`);
      continue;
    }
    const bytes = Buffer.from(object.bytesBase64, "base64");
    if (bytes.length !== claim.size) violations.push(`content object ${claim.sha256} has the wrong size`);
    if (createHash("sha256").update(bytes).digest("hex") !== stripSha256(claim.sha256))
      violations.push(`content object ${claim.sha256} has the wrong bytes`);
  }
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO4(input) {
  const id = "O4";
  if (!input.logs) return result(id, "INCOMPLETE", ["canonical log evidence is missing"]);
  const violations = [];
  const occupied = new Set();
  for (const claim of input.logs.claims) {
    const stream = input.logs.streams[claim.streamId];
    if (!stream) {
      violations.push(`log stream ${claim.streamId} is missing`);
      continue;
    }
    const bytes = Buffer.from(stream.bytesBase64, "base64");
    const expected = Buffer.from(claim.contentBase64, "base64");
    const observed = bytes.subarray(claim.offset, claim.offset + claim.length);
    if (claim.length !== expected.length || !observed.equals(expected))
      violations.push(`log claim ${claim.streamId}@${claim.offset}+${claim.length} differs`);
    for (let offset = claim.offset; offset < claim.offset + claim.length; offset += 1) {
      const key = `${claim.streamId}:${offset}`;
      if (occupied.has(key)) violations.push(`log byte ${key} is claimed more than once`);
      occupied.add(key);
    }
  }
  if (input.logs.diagnosticScope !== "unresolved")
    violations.push("diagnostic lifecycle/request/stdout scope must remain explicitly unresolved");
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO5(input) {
  const id = "O5";
  if (!input.projection) return result(id, "INCOMPLETE", ["projection evidence is missing"]);
  const violations = [];
  compareRows("hot projection", input.projection.hotRows, "strict rebuild", input.projection.rebuildRows, violations);
  compareRows("hot projection", input.projection.hotRows, "API rows", input.projection.apiRows, violations);
  if (stable(input.projection.hotLeaseGuards) !== stable(input.projection.rebuildLeaseGuards))
    violations.push("derived lease guards differ after strict rebuild");
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO6(input) {
  const id = "O6";
  if (!input.identity) return result(id, "INCOMPLETE", ["identity evidence is missing"]);
  const violations = [];
  for (const write of input.identity.writes.filter((candidate) => candidate.status === "accepted_durable")) {
    const priorClaims = input.identity.writerClaims.filter(
      (claim) => claim.repoId === write.repoId && claim.sequence <= write.sequence,
    );
    const current = priorClaims.sort((left, right) => right.sequence - left.sequence)[0];
    if (!current || current.epoch !== write.epoch || current.holder !== write.holder)
      violations.push(`write ${write.opId} was accepted outside the current writer epoch`);
  }
  const occurrenceOwners = new Map();
  for (const claim of input.identity.scheduleClaims.filter((candidate) => candidate.status === "accepted")) {
    const prior = occurrenceOwners.get(claim.occurrenceId);
    if (prior && prior !== `${claim.nodeId}:${claim.claimFence}`)
      violations.push(`occurrence ${claim.occurrenceId} has more than one accepted owner`);
    occurrenceOwners.set(claim.occurrenceId, `${claim.nodeId}:${claim.claimFence}`);
  }
  for (const replica of input.identity.replicas)
    if (replica.ackRevision > replica.availableRevision)
      violations.push(`replica ${replica.repoId} acknowledges beyond its available cut`);
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO7(input) {
  const id = "O7";
  if (!input.recovery) return result(id, "INCOMPLETE", ["cold recovery evidence is missing"]);
  const violations = [];
  if (input.recovery.reconciliation?.matches !== true) violations.push("ledger reconciliation differs");
  if (input.recovery.sql?.integrity !== "ok") violations.push("SQLite integrity_check is not ok");
  if (input.recovery.sql?.head !== input.cut.revision) violations.push("independent SQL head differs from the cut");
  if (input.recovery.objectsComplete !== true) violations.push("object closure is incomplete during recovery");
  if (stable(input.recovery.firstRebuild) !== stable(input.recovery.secondRebuild))
    violations.push("second cold rebuild differs from the first");
  return violations.length ? fail(id, violations) : pass(id);
}

export function oracleO8(input) {
  const id = "O8";
  if (!input.availability) return result(id, "INCOMPLETE", ["availability evidence is missing"]);
  if (input.availability.watchdog?.status === "timeout")
    return result(id, "BLOCKED", [`watchdog timed out at ${input.availability.watchdog.boundary}`]);
  const violations = [];
  for (const expected of input.availability.expectedProgress) {
    const operation = input.availability.operations.find((candidate) => candidate.id === expected);
    if (operation?.status !== "accepted_durable") violations.push(`required operation ${expected} did not progress`);
  }
  return violations.length ? fail(id, violations) : pass(id);
}

export function runOracles(input) {
  return Object.fromEntries(
    [oracleO1, oracleO2, oracleO3, oracleO4, oracleO5, oracleO6, oracleO7, oracleO8].map((oracle) => {
      const observed = oracle(input);
      return [observed.id, observed];
    }),
  );
}

export function runOracleNegativeControls(input) {
  const controls = [
    control("O1/missing-event", "O1", oracleO1, mutateMissingEvent),
    control("O1/controller-log-incomplete", "O1", oracleO1, mutateIncompleteLog),
    control("O2/duplicate-revision", "O2", oracleO2, mutateDuplicateRevision),
    control("O2/dropped-outcome", "O2", oracleO2, mutateDroppedOutcome),
    control("O3/missing-blob-bytes", "O3", oracleO3, mutateMissingBlob),
    control("O4/missing-log-segment", "O4", oracleO4, mutateMissingLog),
    control("O5/wrong-owner-row", "O5", oracleO5, mutateWrongOwner),
    control("O6/stale-epoch-write", "O6", oracleO6, mutateStaleWrite),
    control("O7/rebuild-divergence", "O7", oracleO7, mutateRebuild),
    control("O8/watchdog-timeout", "O8", oracleO8, mutateWatchdog),
  ];
  return controls.map(({ id, oracleId, oracle, mutate }) => {
    const observed = oracle(mutate(structuredClone(input)));
    return {
      id,
      oracle: oracleId,
      observed: observed.verdict,
      passed: observed.verdict !== "PASS",
      violations: observed.violations,
    };
  });
}

function result(id, verdict, violations) {
  return { id, verdict, violations };
}

function expectedEvents(cut, request) {
  const expectedIds = new Set(request.expectedEvents.map((event) => event.opId));
  return cut.events.filter((event) => expectedIds.has(event.opId));
}

function checkExpectedCommand(cut, request, mustExist, violations) {
  const matching = expectedEvents(cut, request);
  if (mustExist && stable(matching) !== stable(request.expectedEvents))
    violations.push(`request ${request.requestId} does not have its exact event closure`);
  if (!mustExist && matching.length) violations.push(`rejected request ${request.requestId} produced events`);
}

function validateAcceptedRange(cut, outcome, request, violations) {
  if (outcome.status !== "accepted_durable") {
    violations.push(`accepted request ${request.requestId} has no accepted revision range`);
    return;
  }
  if (request.expectedEvents.length === 0) {
    if (outcome.firstRevision !== null || outcome.lastRevision !== null)
      violations.push(`zero-event request ${request.requestId} owns a revision range`);
    return;
  }
  if (outcome.firstRevision === null || outcome.lastRevision === null) {
    violations.push(`accepted request ${request.requestId} has no accepted revision range`);
    return;
  }
  const range = cut.events.filter(
    (event) => event.workspaceRevision >= outcome.firstRevision && event.workspaceRevision <= outcome.lastRevision,
  );
  if (stable(range) !== stable(request.expectedEvents))
    violations.push(`accepted range differs for ${request.requestId}`);
}

function outcomeFor(cut, opId) {
  return cut.outcomes.find((outcome) => outcome.opId === opId);
}

function acceptedOpIds(receiptLog) {
  return new Set(classifyReceiptLog(receiptLog).accepted.map(({ request }) => request.opId));
}

function compareRows(leftName, left, rightName, right, violations) {
  if (stable(sortRows(left)) !== stable(sortRows(right))) violations.push(`${leftName} differs from ${rightName}`);
}

function sortRows(rows) {
  return [...rows].sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
}

function rowKey(row) {
  return `${row.kind ?? "row"}:${row.ownerId ?? row.taskId ?? ""}:${row.id ?? row.taskId ?? ""}`;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function stripSha256(value) {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function control(id, oracleId, oracle, mutate) {
  return { id, oracleId, oracle, mutate };
}

function mutateMissingEvent(input) {
  input.cut.events.splice(0, 1);
  return input;
}

function mutateIncompleteLog(input) {
  input.receiptLog.complete = false;
  input.receiptLog.errors.push("campaign completion record is missing");
  input.receiptLog.records.pop();
  return input;
}

function mutateDuplicateRevision(input) {
  input.cut.events[1].workspaceRevision = input.cut.events[0].workspaceRevision;
  return input;
}

function mutateDroppedOutcome(input) {
  input.cut.outcomes.splice(0, 1);
  return input;
}

function mutateMissingBlob(input) {
  delete input.content.objects[input.content.claims[0].sha256];
  return input;
}

function mutateMissingLog(input) {
  delete input.logs.streams[input.logs.claims[0].streamId];
  return input;
}

function mutateWrongOwner(input) {
  input.projection.rebuildRows[0].ownerId = "wrong-owner";
  return input;
}

function mutateStaleWrite(input) {
  const current = input.identity.writerClaims.at(-1);
  input.identity.writes.push({
    repoId: current.repoId,
    opId: "negative-stale-write",
    holder: "retired-holder",
    epoch: current.epoch - 1,
    sequence: current.sequence + 1,
    status: "accepted_durable",
  });
  return input;
}

function mutateRebuild(input) {
  input.recovery.secondRebuild = { corrupted: true };
  return input;
}

function mutateWatchdog(input) {
  input.availability.watchdog = { status: "timeout", boundary: "negative-control" };
  return input;
}
