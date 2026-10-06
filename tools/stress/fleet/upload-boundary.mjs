import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeTaskEventReader, sha256Bytes } from "../../../packages/kernel/src/index.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetTaskCommandClient,
  runFleetUploadClient,
  runFleetWriteClient,
} from "../../../packages/daemon/src/fleet/edge.ts";
import { oracleO1, oracleO3, oracleO6 } from "../core/oracles.mjs";
import { openFleetCampaignFixture } from "./fleet-fixture.mjs";
import { completedUpload, killPausedUpload, spawnUploadProcess, waitForMarker } from "./upload-process.mjs";

const documentPaths = {
  prefix: "upload/prefix-resume.md",
  commit: "upload/commit-ack.md",
  abort: "upload/abort.md",
  concurrent: "upload/concurrent.md",
  stale: "upload/stale.md",
};

export async function runFleetUploadBoundaryCampaign() {
  const fixture = await openFleetCampaignFixture({ repoNames: ["upload"] }),
    repo = fixture.repos[0],
    subjects = Array.from({ length: 6 }, (_value, index) => fixture.subject(repo.repoId, index));
  try {
    let center = await fixture.startCenter("upload-center-1");
    const prefix = await resumeDurablePrefix(fixture, center, subjects[0], documentPaths.prefix);
    await fixture.closeCenter();
    center = await fixture.startCenter("upload-center-2");
    prefix.result = await write(fixture, center, subjects[0], documentPaths.prefix, prefix.body);

    const committed = await commitBeforeAck(fixture, center, subjects[1], documentPaths.commit);
    await fixture.closeCenter();
    center = await fixture.startCenter("upload-center-3");
    committed.result = await write(fixture, center, subjects[1], documentPaths.commit, committed.body);

    const aborted = await abandonPartialUpload(fixture, center, subjects[2], documentPaths.abort),
      concurrent = await concurrentSameContent(fixture, center, subjects.slice(3, 5), documentPaths.concurrent),
      oldMetadata = await repositoryMetadata(fixture, center, subjects[5]),
      staleDescriptor = (
        await runFleetUploadClient({
          ...peer(fixture, center, subjects[5]),
          changes: [{ path: documentPaths.stale, body: "stale generation bytes\n" }],
        })
      )[0];
    assert.ok(staleDescriptor);
    await fixture.closeCenter();
    center = await fixture.startCenter("upload-center-4");
    const currentMetadata = await repositoryMetadata(fixture, center, subjects[5]),
      stale = await runFleetTaskCommandClient({
        ...peer(fixture, center, subjects[5]),
        opId: "upload-stale-generation",
        repoId: repo.repoId,
        taskId: "task-upload-boundary",
        action: { kind: "task-progress-append", taskId: "task-upload-boundary", text: "stale generation" },
        waitMs: 1_000,
        writerEpoch: oldMetadata.writerEpoch,
        docChanges: [
          {
            path: documentPaths.stale,
            baseBlobSha256: null,
            policyId: "markdown-body-replaceable/v1",
            candidate: staleDescriptor,
          },
        ],
        mirrorBaseCut: null,
      });
    assert.ok(currentMetadata.writerEpoch > oldMetadata.writerEpoch);
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "writer_epoch_stale");
    assert.equal(JSON.stringify(readState(fixture)).includes(staleDescriptor.ref), false);

    const accepted = [prefix.result.center, committed.result.center, concurrent.winner.center],
      rejected = [concurrent.loser.center, stale],
      reader = makeTaskEventReader({ repoId: repo.repoId, rootDir: repo.rootDir }),
      events = reader.read().events,
      acceptedEvents = accepted.map((receipt) => {
        const matching = events.filter((event) => event.opId === receipt.opId);
        assert.ok(matching.length > 0, `accepted op ${receipt.opId} has no canonical event`);
        return matching;
      }),
      receiptLog = campaignReceiptLog(accepted, acceptedEvents, rejected),
      o1 = oracleO1({ authority: "canonical", canonicalCut: { events, outcomes: [] }, receiptLog }),
      contentClaims = [
        [prefix.result.center.opId, prefix.body],
        [committed.result.center.opId, committed.body],
        [concurrent.winner.center.opId, concurrent.body],
      ].map(([acceptedOpId, body]) => ({
        acceptedOpId,
        sha256: sha256Bytes(Buffer.from(body)),
        size: Buffer.byteLength(body),
      })),
      contentObjects = Object.fromEntries(
        contentClaims.map((claim) => {
          const bytes = reader.readContentBlob(claim.sha256);
          assert.ok(bytes, `content object ${claim.sha256} is missing`);
          return [claim.sha256, { bytesBase64: Buffer.from(bytes).toString("base64") }];
        }),
      ),
      o3 = oracleO3({ receiptLog, content: { claims: contentClaims, objects: contentObjects } }),
      identity = {
        writes: [
          {
            repoId: repo.repoId,
            opId: concurrent.winner.center.opId,
            holder: "upload-center-3",
            epoch: oldMetadata.writerEpoch,
            sequence: 1,
            status: "accepted_durable",
          },
        ],
        writerClaims: [
          {
            repoId: repo.repoId,
            holder: "upload-center-3",
            epoch: oldMetadata.writerEpoch,
            sequence: 0,
          },
        ],
        scheduleClaims: [
          {
            occurrenceId: `upload:${sha256Bytes(Buffer.from(concurrent.body))}`,
            nodeId: concurrent.winner.nodeId,
            claimFence: concurrent.winner.descriptors[0].ref,
            status: "accepted",
          },
        ],
        replicas: [],
      },
      o6 = oracleO6({ identity }),
      redControls = redControlsFor({
        events,
        receiptLog,
        contentClaims,
        contentObjects,
        identity,
        concurrent,
        stale,
        aborted,
      });
    assert.equal(o1.verdict, "PASS", JSON.stringify(o1));
    assert.equal(o3.verdict, "PASS", JSON.stringify(o3));
    assert.equal(o6.verdict, "PASS", JSON.stringify(o6));
    assert.equal(
      redControls.every((control) => control.passed),
      true,
      JSON.stringify(redControls),
    );
    assert.equal(
      events.some((event) => event.opId === "upload-stale-generation"),
      false,
    );
    assert.equal(
      events.some((event) => event.opId === aborted.opId),
      false,
    );

    return {
      cases: [
        {
          id: "fleet-upload/durable-prefix-before-commit",
          boundaryHits: [prefix.boundary.boundary, "center-restart", "durable-prefix-resume"],
          observations: { resumedOffset: prefix.boundary.frame.resumeOffset, outcome: prefix.result.center.outcome },
          oracles: { O1: o1, O3: o3 },
          verdict: "PASS",
        },
        {
          id: "fleet-upload/commit-before-client-ack",
          boundaryHits: [committed.boundary.boundary, "center-restart", "already-staged-replay"],
          observations: {
            stagedDescriptor: committed.boundary.frame.descriptor,
            outcome: committed.result.center.outcome,
          },
          oracles: { O1: o1, O3: o3 },
          verdict: "PASS",
        },
        {
          id: "fleet-upload/abort-after-partial",
          boundaryHits: [aborted.boundary.boundary, "transport-SIGKILL"],
          observations: { durablePrefixBytes: aborted.boundary.frame.resumeOffset, canonicalEventCount: 0 },
          oracles: { O1: o1 },
          verdict: "PASS",
        },
        {
          id: "fleet-upload/two-edge-same-content",
          boundaryHits: ["two-process-release-barrier", "same-content-distinct-node-claims"],
          observations: {
            outcomes: concurrent.results.map(({ center: result }) => result.outcome),
            winnerNodeId: concurrent.winner.nodeId,
            loserCode: concurrent.loser.center.code,
          },
          oracles: { O1: o1, O3: o3, O6: o6 },
          verdict: "PASS",
        },
        {
          id: "fleet-upload/stale-generation-after-takeover",
          boundaryHits: ["staged-under-old-writer-epoch", "center-takeover", "stale-claim-discard"],
          observations: {
            oldWriterEpoch: oldMetadata.writerEpoch,
            currentWriterEpoch: currentMetadata.writerEpoch,
            outcome: stale.outcome,
            code: stale.code,
          },
          oracles: { O1: o1, O6: o6 },
          verdict: "PASS",
        },
      ],
      redControls,
      counts: {
        acceptedEvents: acceptedEvents.flat().length,
        uniqueBlobs: contentClaims.length,
        maxConcurrentClients: 2,
      },
      sourceAnchors: [
        "packages/daemon/src/fleet/center-listener.ts:221",
        "packages/daemon/src/fleet/center-listener.ts:271",
        "packages/daemon/src/fleet/center-listener.ts:298",
        "packages/daemon/src/fleet/center-listener.ts:340",
        "packages/daemon/src/fleet/center-listener.ts:442",
      ],
    };
  } finally {
    await fixture.close();
  }
}

async function resumeDurablePrefix(fixture, center, subject, target) {
  const body = `# Prefix resume\n\n${"p".repeat(160 * 1024)}\n`,
    baseLedgerSha = (await repositoryMetadata(fixture, center, subject)).baseLedgerSha,
    run = spawnUploadProcess(fixture, center, subject, {
      label: "prefix-resume",
      path: target,
      body,
      baseLedgerSha,
      pauseAt: "durable-prefix",
    });
  const boundary = JSON.parse(await waitForMarker(run.boundaryFile, run.child, run.output));
  await killPausedUpload(run);
  return { body, boundary, result: null };
}

async function commitBeforeAck(fixture, center, subject, target) {
  const body = "# Committed before acknowledgement\n",
    baseLedgerSha = (await repositoryMetadata(fixture, center, subject)).baseLedgerSha,
    run = spawnUploadProcess(fixture, center, subject, {
      label: "commit-before-ack",
      path: target,
      body,
      baseLedgerSha,
      pauseAt: "upload-commit",
    });
  const boundary = JSON.parse(await waitForMarker(run.boundaryFile, run.child, run.output));
  assert.equal(
    readState(fixture).uploads[boundary.frame.descriptor.ref.split("/").at(-1)].descriptor.ref,
    boundary.frame.descriptor.ref,
  );
  await killPausedUpload(run);
  return { body, boundary, result: null };
}

async function abandonPartialUpload(fixture, center, subject, target) {
  const body = `# Aborted upload\n\n${"a".repeat(160 * 1024)}\n`,
    baseLedgerSha = (await repositoryMetadata(fixture, center, subject)).baseLedgerSha,
    opId = "upload-aborted-before-submit",
    run = spawnUploadProcess(fixture, center, subject, {
      label: "abort-partial",
      path: target,
      body,
      baseLedgerSha,
      pauseAt: "durable-prefix",
    });
  const boundary = JSON.parse(await waitForMarker(run.boundaryFile, run.child, run.output));
  await killPausedUpload(run);
  const stagedEntry = Object.entries(readState(fixture).uploads).find(
    ([, upload]) => upload.nodeId === subject.nodeId && upload.content.sha256 === sha256Bytes(Buffer.from(body)),
  );
  assert.ok(stagedEntry);
  const [uploadId, staged] = stagedEntry;
  assert.equal(staged.descriptor, null);
  assert.equal(existsSync(path.join(repoLocal(fixture), "doc-sync-claims", uploadId)), false);
  return { body, boundary, opId };
}

async function concurrentSameContent(fixture, center, subjects, target) {
  const body = "# Same content from two edges\n",
    baseLedgerSha = (await repositoryMetadata(fixture, center, subjects[0])).baseLedgerSha,
    runs = subjects.map((subject, index) =>
      spawnUploadProcess(fixture, center, subject, {
        label: `concurrent-${index + 1}`,
        path: target,
        body,
        baseLedgerSha,
        barrier: true,
      }),
    );
  await Promise.all(runs.map((run) => waitForMarker(run.readyFile, run.child, run.output)));
  for (const run of runs) run.release();
  const results = await Promise.all(runs.map(completedUpload)),
    accepted = results.map((result, index) => ({ ...result, nodeId: subjects[index].nodeId })),
    winners = accepted.filter(({ center: result }) => result.outcome === "applied"),
    losers = accepted.filter(({ center: result }) => result.outcome === "op_rejected");
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0].center.code, "base_ledger_changed", JSON.stringify(losers[0].center));
  assert.notEqual(results[0].descriptors[0].ref, results[1].descriptors[0].ref);
  return { body, results, winner: winners[0], loser: losers[0] };
}

async function write(fixture, center, subject, target, body) {
  const assigned = await repositoryMetadata(fixture, center, subject),
    result = await runFleetWriteClient({
      ...peer(fixture, center, subject),
      channel: "collaborator",
      executionId: null,
      baseLedgerSha: assigned.baseLedgerSha,
      changes: [{ path: target, body, baseBlobSha256: null }],
    });
  assert.equal(result.center.outcome, "applied", JSON.stringify(result.center));
  return result;
}

function repositoryMetadata(fixture, center, subject) {
  return readFleetRepositoryMetadataClient(peer(fixture, center, subject));
}

function peer(fixture, center, subject) {
  return {
    port: center.port,
    ca: readFileSync(fixture.certFile),
    servername: "localhost",
    nodeId: subject.nodeId,
    credential: `credential-${subject.nodeId}`,
    repoId: subject.repoId,
  };
}

function readState(fixture) {
  return JSON.parse(readFileSync(path.join(fixture.root, "fleet-state", "state.json"), "utf8"));
}

function repoLocal(fixture) {
  return path.join(fixture.repos[0].rootDir, ".harness");
}

function campaignReceiptLog(accepted, acceptedEvents, rejected) {
  const records = [{ type: "campaign_started" }];
  accepted.forEach((receipt, index) => {
    const requestId = `accepted-${index + 1}`;
    records.push({
      type: "request",
      request: { requestId, opId: receipt.opId, intentDigest: requestId, expectedEvents: acceptedEvents[index] },
    });
    records.push({ type: "receipt", requestId, receipt: { status: "accepted_durable" } });
  });
  rejected.forEach((receipt, index) => {
    const requestId = `rejected-${index + 1}`;
    records.push({
      type: "request",
      request: { requestId, opId: receipt.opId, intentDigest: requestId, expectedEvents: [] },
    });
    records.push({ type: "receipt", requestId, receipt: { status: "rejected" } });
  });
  records.push({
    type: "request",
    request: {
      requestId: "aborted",
      opId: "upload-aborted-before-submit",
      intentDigest: "aborted",
      expectedEvents: [],
    },
  });
  records.push({ type: "campaign_completed" });
  return { complete: true, errors: [], records };
}

function redControlsFor({ events, receiptLog, contentClaims, contentObjects, identity, concurrent, stale, aborted }) {
  const missingAccepted = oracleO1({
      authority: "canonical",
      canonicalCut: { events: events.filter((event) => event.opId !== contentClaims[0].acceptedOpId), outcomes: [] },
      receiptLog,
    }),
    missingBlobObjects = { ...contentObjects };
  delete missingBlobObjects[contentClaims[1].sha256];
  const missingBlob = oracleO3({
      receiptLog,
      content: { claims: contentClaims, objects: missingBlobObjects },
    }),
    partialAccepted = oracleO3({
      receiptLog: {
        complete: true,
        errors: [],
        records: [
          { type: "campaign_started" },
          {
            type: "request",
            request: {
              requestId: "aborted-red",
              opId: aborted.opId,
              intentDigest: "aborted-red",
              expectedEvents: [],
            },
          },
          { type: "receipt", requestId: "aborted-red", receipt: { status: "accepted_durable" } },
          { type: "campaign_completed" },
        ],
      },
      content: {
        claims: [
          {
            acceptedOpId: aborted.opId,
            sha256: sha256Bytes(Buffer.from(aborted.body)),
            size: Buffer.byteLength(aborted.body),
          },
        ],
        objects: {},
      },
    }),
    duplicateClaim = oracleO6({
      identity: {
        ...identity,
        scheduleClaims: [
          ...identity.scheduleClaims,
          {
            ...identity.scheduleClaims[0],
            nodeId: concurrent.loser.nodeId,
            claimFence: concurrent.loser.descriptors[0].ref,
          },
        ],
      },
    }),
    staleAccepted = oracleO6({
      identity: {
        ...identity,
        writerClaims: [
          ...identity.writerClaims,
          {
            repoId: identity.writerClaims[0].repoId,
            holder: "upload-center-4",
            epoch: identity.writerClaims[0].epoch + 1,
            sequence: 2,
          },
        ],
        writes: [
          ...identity.writes,
          {
            repoId: identity.writerClaims[0].repoId,
            opId: stale.opId,
            holder: "upload-center-3",
            epoch: identity.writerClaims[0].epoch,
            sequence: 3,
            status: "accepted_durable",
          },
        ],
      },
    });
  return [
    control("durable-prefix/drop-resumed-bytes", "O3", missingBlob),
    control("commit-ack/drop-accepted-event", "O1", missingAccepted),
    control("abort/mark-partial-as-accepted", "O3", partialAccepted),
    control("concurrent/double-accepted-claim", "O6", duplicateClaim),
    control("stale/accept-old-writer-epoch", "O6", staleAccepted),
  ];
}

function control(id, oracleId, result) {
  return { id, oracleId, observed: result.verdict, passed: result.verdict === "FAIL", violations: result.violations };
}
