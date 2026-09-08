import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";
import path from "node:path";
import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { docBundle } from "../../../packages/kernel/test/store/task-event-store.fixtures.ts";
import { oracleO1, oracleO2, oracleO3 } from "../core/oracles.mjs";

const maximumVolumeBytes = 4 * 1024 ** 3;

export function runRealVolumeEnospcArm(preflight) {
  if (!preflight?.ready)
    return {
      id: "S4/real-volume-enospc",
      boundaryHits: [],
      preflight,
      oracles: {},
      verdict: "BLOCKED",
    };
  const volume = verifyDedicatedSmallLoopMount(preflight.path),
    armRoot = mkdtempSync(path.join(volume.path, ".harness-enospc-arm-")),
    databasePath = path.join(armRoot, "ledger.sqlite"),
    fillerPath = path.join(armRoot, "volume-filler"),
    repoId = "stress-s4-enospc",
    fence = { repoId, holder: "volume-arm", epoch: 1 },
    body = "# ENOSPC acceptance closure\n".repeat(32_768),
    bundle = docBundle(
      { currentCut: () => ({ repoId, revision: 0, headDigest: `sha256:${"0".repeat(64)}` }) },
      body,
      1,
      "op-stress-s4-enospc",
      "context/enospc.md",
    ),
    command = {
      fence,
      intent: {
        opId: bundle.event.opId,
        intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(bundle.event))}`,
        summary: bundle.event.type,
      },
      events: [bundle.event],
      blobs: bundle.blobs,
    };
  let store = openSqliteEventStore({ repoId, databasePath }),
    fullError;
  try {
    fillUntilEnospc(fillerPath);
    try {
      store.appendCommand(command);
    } catch (error) {
      fullError = error;
    }
    assert.ok(fullError, "SQLite append unexpectedly succeeded after the volume reported ENOSPC");
    assert.match(errorIdentity(fullError), /ENOSPC|SQLITE_FULL|database or disk is full/iu);
    rmSync(fillerPath);
    store.close();
    store = null;

    const failedCut = readCut(databasePath, repoId),
      failedBlob = failedCut.store.readContentObject(bundle.blobs[0].sha256);
    try {
      assert.equal(failedCut.cut.revision, 0);
      assert.equal(failedCut.cut.events.length, 0);
      assert.equal(failedCut.cut.outcomes.length, 0);
      assert.equal(failedBlob, null);
    } finally {
      failedCut.store.close();
    }

    store = openSqliteEventStore({ repoId, databasePath });
    const accepted = store.appendCommand(command);
    assert.equal(accepted.status, "accepted_durable");
    store.close();
    store = null;
    const recovered = readCut(databasePath, repoId),
      blob = recovered.store.readContentObject(bundle.blobs[0].sha256),
      receiptLog = acceptedReceiptLog(command, accepted),
      closure = closureOracles({ cut: recovered.cut, receiptLog, bundle, blob }),
      badCut = { ...recovered.cut, events: [], outcomes: [] },
      rejectedBadReport = closureOracles({ cut: badCut, receiptLog, bundle, blob: null });
    recovered.store.close();
    assert.ok(Object.values(closure).every(({ verdict }) => verdict === "PASS"));
    assert.ok(Object.values(rejectedBadReport).every(({ verdict }) => verdict === "FAIL"));
    return {
      id: "S4/real-volume-enospc",
      boundaryHits: ["real-volume:ENOSPC", "sqlite:accept-transaction", "content-object:replace"],
      preflight: { ...preflight, bytes: volume.bytes },
      measured: { failedRevision: failedCut.cut.revision, recoveredRevision: recovered.cut.revision },
      negativeControl: {
        id: "S4/accepted-without-event-blob-outcome",
        oracleId: "O1+O2+O3",
        passed: true,
      },
      oracles: closure,
      verdict: "PASS",
    };
  } finally {
    if (store) store.close();
    rmSync(armRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function verifyDedicatedSmallLoopMount(candidate) {
  const resolved = path.resolve(candidate),
    payload = JSON.parse(execFileSync("findmnt", ["--json", "--target", resolved], { encoding: "utf8" })),
    filesystems = payload.filesystems ?? [];
  assert.equal(filesystems.length, 1, "bounded volume must resolve to exactly one filesystem");
  assert.equal(path.resolve(filesystems[0].target), resolved, "bounded volume must be its filesystem mount target");
  assert.match(String(filesystems[0].source), /^\/dev\/loop\d+$/u, "bounded volume must be a disposable loop device");
  const stats = statfsSync(resolved),
    bytes = stats.blocks * stats.bsize;
  assert.ok(bytes > 0 && bytes <= maximumVolumeBytes, `bounded volume is not small (${bytes} bytes)`);
  return { path: resolved, bytes };
}

function fillUntilEnospc(file) {
  const descriptor = openSync(file, "wx", 0o600),
    chunk = Buffer.alloc(8 * 1024 * 1024);
  let observed;
  try {
    for (;;) writeSync(descriptor, chunk);
  } catch (error) {
    observed = error;
  } finally {
    closeSync(descriptor);
  }
  assert.match(errorIdentity(observed), /ENOSPC/iu, "bounded volume filler did not reach ENOSPC");
}

function readCut(databasePath, repoId) {
  const store = openSqliteEventStore({ repoId, databasePath, readOnly: true });
  return {
    store,
    cut: { revision: store.revision(), events: store.events(), outcomes: store.outcomes() },
  };
}

function acceptedReceiptLog(command, outcome) {
  const request = {
    requestId: "request-stress-s4-enospc",
    opId: command.intent.opId,
    intentDigest: command.intent.intentDigest,
    expectedEvents: command.events,
  };
  return {
    complete: true,
    errors: [],
    records: [
      { type: "campaign_started" },
      { type: "request", request },
      { type: "receipt", requestId: request.requestId, receipt: outcome },
      { type: "campaign_completed" },
    ],
  };
}

function closureOracles({ cut, receiptLog, bundle, blob }) {
  const authority = { authority: "sqlite", sqliteCut: cut, receiptLog };
  return {
    O1: oracleO1(authority),
    O2: oracleO2(authority),
    O3: oracleO3({
      receiptLog,
      content: {
        claims: [{ acceptedOpId: bundle.event.opId, sha256: bundle.blobs[0].sha256, size: bundle.blobs[0].size }],
        objects:
          blob === null ? {} : { [bundle.blobs[0].sha256]: { bytesBase64: Buffer.from(blob).toString("base64") } },
      },
    }),
  };
}

function errorIdentity(error) {
  if (typeof error !== "object" || error === null) return String(error);
  return [error.code, error.errcode, error.errstr, error.message].filter(Boolean).join(":");
}
