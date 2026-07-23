// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  authorityProtocolTuple,
  createInMemoryReplicaChangeLog,
  type AuthoritySubmissionService,
  type ReplicaChangeLog
} from "../../application/src/index.ts";
import { serveAuthorityForcedCommand } from "../src/authority/forced-command-session.ts";
import {
  authorityWireFrameType,
  type AuthorityResponseFrame,
  type AuthorityServerFrame,
  type AuthoritySnapshotLease
} from "../src/authority/protocol.ts";
import { createAuthorityReadDownService } from "../src/authority/read-down-service.ts";
import {
  createAuthorityReplicationContentStore,
  createContentEnrichedReplicaChangeLog
} from "../src/authority/replication-content-store.ts";
import { openDurableAuthorityServiceState } from "../src/authority/production/service-state.ts";
import {
  PersistentSshAuthorityClient,
  type SshAuthorityChild,
  type SshAuthorityChildFactory
} from "../src/transport/persistent-ssh-authority-client.ts";
import {
  createLengthPrefixedFrameReader,
  encodeLengthPrefixedFrame
} from "../src/transport/length-frame-codec.ts";

const workspaceId = "workspace-read-down";

test("renewing a live read lease extends only its expiry and preserves blob authorization", async () => {
  const fixture = createReadDownFixture();
  try {
    seedRepository(fixture.gitRoot);
    const issued = fixture.open("2026-07-23T04:00:00.000Z");
    const reservation = await issued.service.beginSnapshot();
    const manifest = await issued.service.getManifest(
      reservation.stream.streamToken,
      reservation.cut.manifestDigest
    );
    const authorizedDigest = manifest.entries[0]!.blobDigest;
    const unauthorizedDigest = `sha256:${"0".repeat(64)}` as const;
    const leaseKey = `lease:${reservation.stream.streamToken}`;
    const before = structuredClone(fixture.state.get<StoredLeaseFixture>(leaseKey)!);
    await issued.service.getBlob(reservation.stream.streamToken, authorizedDigest);
    await assert.rejects(
      issued.service.getBlob(reservation.stream.streamToken, unauthorizedDigest),
      /RESYNC_REQUIRED:BLOB_NOT_AUTHORIZED/u
    );

    const renewed = await fixture.open("2026-07-23T04:04:00.000Z").service.renewLease(
      reservation.stream.streamToken
    );
    const after = structuredClone(fixture.state.get<StoredLeaseFixture>(leaseKey)!);

    assert.equal(renewed.expiresAt, "2026-07-23T04:09:00.000Z");
    assert.deepEqual(
      {
        ...after,
        reservation: {
          ...after.reservation,
          lease: {
            ...after.reservation.lease,
            expiresAt: before.reservation.lease.expiresAt
          }
        }
      },
      before,
      "renewal must preserve the cut, manifest, lease identity, pin, stream, and authorization inputs"
    );
    await fixture.open("2026-07-23T04:06:00.000Z").service.getBlob(
      reservation.stream.streamToken,
      authorizedDigest
    );
    await assert.rejects(
      fixture.open("2026-07-23T04:06:00.000Z").service.getBlob(
        reservation.stream.streamToken,
        unauthorizedDigest
      ),
      /RESYNC_REQUIRED:BLOB_NOT_AUTHORIZED/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("durable lease renewal bounds append frequency and cannot exceed its absolute lifetime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-read-down-renewal-durable-"));
  const gitRoot = path.join(root, "canonical");
  mkdirSync(gitRoot);
  git(gitRoot, "init", "-q");
  git(gitRoot, "config", "user.name", "Authority Test");
  git(gitRoot, "config", "user.email", "authority@example.test");
  seedRepository(gitRoot);
  let state = openDurableAuthorityServiceState({
    serviceStateRoot: path.join(root, "state"),
    repoId: "repo-read-down-renewal"
  });
  let timestamp = "2026-07-23T04:00:00.000Z";
  const open = () => {
    const content = createAuthorityReplicationContentStore({
      gitRoot,
      state: state.replicationState,
      workspaceId,
      epoch: "7"
    });
    return createAuthorityReadDownService({
      workspaceId,
      epoch: "7",
      gitRoot,
      state: state.replicationState,
      replicaChangeLog: createContentEnrichedReplicaChangeLog(state.replicaChangeLog, content),
      content,
      publicationExecutor: serialExecutor(),
      now: () => new Date(timestamp),
      leaseTtlMs: 1_000,
      leaseMaxLifetimeMs: 3_000
    });
  };
  try {
    const reservation = await open().beginSnapshot();
    const replicationLog = path.join(state.stateDirectory, "replication.jsonl");
    const rowsAfterIssue = durableRows(replicationLog);

    for (let request = 0; request < 100; request += 1) {
      timestamp = new Date(
        Date.parse("2026-07-23T04:00:00.800Z") + request
      ).toISOString();
      await open().renewLease(reservation.stream.streamToken);
    }
    assert.equal(
      durableRows(replicationLog) - rowsAfterIssue,
      1,
      "one renewal window may append at most one durable row regardless of request count"
    );

    timestamp = "2026-07-23T04:00:01.600Z";
    await Promise.all(Array.from(
      { length: 20 },
      () => open().renewLease(reservation.stream.streamToken)
    ));
    timestamp = "2026-07-23T04:00:02.400Z";
    await Promise.all(Array.from(
      { length: 20 },
      () => open().renewLease(reservation.stream.streamToken)
    ));
    await state.close();
    state = openDurableAuthorityServiceState({
      serviceStateRoot: path.join(root, "state"),
      repoId: "repo-read-down-renewal"
    });

    timestamp = "2026-07-23T04:00:03.000Z";
    await assert.rejects(
      open().renewLease(reservation.stream.streamToken),
      /SNAPSHOT_EXPIRED/u
    );
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("renewal rejects damaged lease identity and pinned revision invariants", async (t) => {
  const fixture = createReadDownFixture();
  try {
    seedRepository(fixture.gitRoot);
    const opened = fixture.open("2026-07-23T04:00:00.000Z");
    const reservation = await opened.service.beginSnapshot();
    const leaseKey = `lease:${reservation.stream.streamToken}`;
    const original = structuredClone(fixture.state.get<StoredLeaseFixture>(leaseKey)!);
    const cases = [
      {
        name: "empty leaseId",
        damage: (lease: StoredLeaseFixture) => {
          lease.reservation.lease.leaseId = "";
        }
      },
      {
        name: "minRetainedRevision not cut plus one",
        damage: (lease: StoredLeaseFixture) => {
          lease.reservation.lease.minRetainedRevision = reservation.cut.revision + 2;
        }
      },
      {
        name: "stream fromRevision not cut plus one",
        damage: (lease: StoredLeaseFixture) => {
          lease.reservation.stream.fromRevision = reservation.cut.revision + 2;
        }
      }
    ] as const;

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const damaged = structuredClone(original);
        candidate.damage(damaged);
        fixture.state.put(leaseKey, damaged);
        await assert.rejects(
          fixture.open("2026-07-23T04:00:01.000Z").service.renewLease(
            reservation.stream.streamToken
          ),
          /RESYNC_REQUIRED:SNAPSHOT_LEASE_DAMAGED/u
        );
      });
    }
  } finally {
    fixture.cleanup();
  }
});

test("snapshot response encoding failure invalidates the persisted lease", async () => {
  const fixture = createReadDownFixture();
  try {
    seedRepository(fixture.gitRoot);
    const opened = fixture.open("2026-07-23T04:00:00.000Z");
    const wire = openWireSession(opened.changeLog, opened.service, 1, 640);
    try {
      wire.send(helloFrame("hello-encode-failure", 1));
      assert.equal((await wire.frames.nextResponse("hello-encode-failure")).ok, true);
      wire.send({
        type: authorityWireFrameType,
        kind: "begin_snapshot_and_subscribe",
        requestId: "begin-encode-failure",
        connectionGeneration: 1,
        workspaceId
      });
      const response = await wire.frames.nextResponse("begin-encode-failure");
      assert.equal(response.ok, false);
      assert.match(response.error?.message ?? "", /frame length .* exceeds limit/u);
      assert.equal(
        fixture.state.entries<{ readonly schema?: string }>()
          .filter(([key, value]) =>
            key.startsWith("lease:") && value.schema === "authority-snapshot-lease/v1").length,
        0
      );
    } finally {
      await wire.session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("renew_lease crosses the forced-command wire and fails closed for invalid authority state", async () => {
  const fixture = createReadDownFixture();
  try {
    seedRepository(fixture.gitRoot);
    const issued = fixture.open("2026-07-23T04:00:00.000Z");
    const reservation = await issued.service.beginSnapshot();
    const live = openWireSession(
      issued.changeLog,
      fixture.open("2026-07-23T04:04:00.000Z").service,
      1
    );
    try {
      live.send(helloFrame("hello-renew", 1));
      const hello = await live.frames.nextResponse("hello-renew");
      assert.equal(
        (hello.result as { readonly capabilities: ReadonlyArray<string> }).capabilities.includes(
          "authority-lease-renewal/v1"
        ),
        true
      );
      assert.equal(
        (hello.result as { readonly capabilities: ReadonlyArray<string> }).capabilities.includes(
          "authority-cut-change/v1"
        ),
        true
      );

      live.send(cutChangeFrame("get-cut-change", 1, reservation.stream.streamToken));
      const cutChange = await live.frames.nextResponse("get-cut-change");
      assert.equal(cutChange.ok, true);
      assert.equal(cutChange.result, null);

      live.send(renewFrame("renew-live", 1, reservation.stream.streamToken));
      const renewed = await live.frames.nextResponse("renew-live");
      assert.equal(renewed.ok, true);
      assert.equal(
        (renewed.result as { readonly leaseId: string }).leaseId,
        reservation.lease.leaseId
      );
      assert.equal(
        (renewed.result as { readonly expiresAt: string }).expiresAt,
        "2026-07-23T04:09:00.000Z"
      );

      live.send(renewFrame("renew-unknown", 1, "a".repeat(43)));
      const unknown = await live.frames.nextResponse("renew-unknown");
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error?.code, "RESYNC_REQUIRED");

      live.send({
        ...renewFrame("renew-workspace-mismatch", 1, reservation.stream.streamToken),
        workspaceId: "another-workspace"
      });
      const workspaceMismatch = await live.frames.nextResponse("renew-workspace-mismatch");
      assert.equal(workspaceMismatch.ok, false);
      assert.equal(workspaceMismatch.error?.code, "WORKSPACE_MISMATCH");
    } finally {
      await live.session.close();
    }

    const wrongEpoch = openWireSession(
      issued.changeLog,
      fixture.open("2026-07-23T04:05:00.000Z", "8").service,
      2
    );
    try {
      wrongEpoch.send(helloFrame("hello-wrong-epoch", 2));
      await wrongEpoch.frames.nextResponse("hello-wrong-epoch");
      wrongEpoch.send(renewFrame("renew-wrong-epoch", 2, reservation.stream.streamToken));
      const response = await wrongEpoch.frames.nextResponse("renew-wrong-epoch");
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, "RESYNC_REQUIRED");
      assert.match(response.error?.message ?? "", /SNAPSHOT_LEASE_AUTHORITY_MISMATCH/u);
    } finally {
      await wrongEpoch.session.close();
    }

    const expired = openWireSession(
      issued.changeLog,
      fixture.open("2026-07-23T04:10:00.000Z").service,
      3
    );
    try {
      expired.send(helloFrame("hello-expired", 3));
      await expired.frames.nextResponse("hello-expired");
      expired.send(renewFrame("renew-expired", 3, reservation.stream.streamToken));
      const response = await expired.frames.nextResponse("renew-expired");
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, "SNAPSHOT_EXPIRED");
    } finally {
      await expired.session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("persistent SSH client sends renewal and on-demand cut-change frames", async () => {
  const requested: Array<{
    readonly kind: string;
    readonly workspaceId?: string;
    readonly streamToken: string;
  }> = [];
  const lease: AuthoritySnapshotLease = {
    leaseId: "lease-read-down",
    expiresAt: "2026-07-23T04:09:00.000Z",
    renewableUntil: "2026-07-23T05:00:00.000Z",
    minRetainedRevision: 1,
    pinnedBlobSetDigest: `sha256:${"1".repeat(64)}`
  };
  const cutChange = {
    schema: "replica-change/v2",
    workspaceId,
    revision: 1,
    opId: "op-cut",
    semanticDigest: "cut",
    operations: [{ opId: "op-cut", semanticDigest: "cut" }],
    commitSha: "1".repeat(40),
    previousCommit: null,
    changedAt: "2026-07-23T04:00:00.000Z",
    manifest: { digest: `sha256:${"1".repeat(64)}` as const, entryCount: 0 },
    paths: []
  } as const;
  const client = new PersistentSshAuthorityClient({
    target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
    workspaceId,
    channelNonceDigest: () => "sha256:channel-generation",
    protocol: authorityProtocolTuple,
    childFactory: scriptedRenewalChildFactory(lease, cutChange, requested)
  });

  await client.connect();
  const renewed = await client.renewLease("stream-token");
  const fetchedCutChange = await client.getCutChange("stream-token");

  assert.deepEqual(renewed, lease);
  assert.deepEqual(fetchedCutChange, cutChange);
  assert.deepEqual(requested, [
    { kind: "renew_lease", workspaceId, streamToken: "stream-token" },
    { kind: "get_cut_change", streamToken: "stream-token" }
  ]);
  await client.close();
});

function createReadDownFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-read-down-renewal-"));
  const gitRoot = path.join(root, "canonical");
  mkdirSync(gitRoot);
  git(gitRoot, "init", "-q");
  git(gitRoot, "config", "user.name", "Authority Test");
  git(gitRoot, "config", "user.email", "authority@example.test");
  const base = createInMemoryReplicaChangeLog();
  const stateValues = new Map<string, unknown>();
  const state = {
    get: <Value>(key: string) => stateValues.get(key) as Value | undefined,
    put: (key: string, value: unknown) => stateValues.set(key, structuredClone(value)),
    entries: <Value>() => [...stateValues.entries()] as ReadonlyArray<readonly [string, Value]>
  };
  return {
    gitRoot,
    state,
    open: (timestamp: string, epoch = "7") => {
      const content = createAuthorityReplicationContentStore({
        gitRoot,
        state,
        workspaceId,
        epoch
      });
      const changeLog = createContentEnrichedReplicaChangeLog(base, content);
      return {
        changeLog,
        service: createAuthorityReadDownService({
          workspaceId,
          epoch,
          gitRoot,
          state,
          replicaChangeLog: changeLog,
          content,
          publicationExecutor: serialExecutor(),
          now: () => new Date(timestamp)
        })
      };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function openWireSession(
  replicaChangeLog: ReplicaChangeLog,
  readDownService: ReturnType<typeof createAuthorityReadDownService>,
  generation: number,
  maxFrameBytes?: number
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output);
  const submissionService: AuthoritySubmissionService = {
    submit: async () => { throw new Error("write path is not used by read-down renewal tests"); },
    getOperation: async () => undefined
  };
  const session = serveAuthorityForcedCommand({
    input,
    output,
    workspaceId,
    protocol: authorityProtocolTuple,
    submissionService,
    replicaChangeLog,
    readDownService,
    maxFrameBytes
  });
  return {
    session,
    frames,
    send: (frame: unknown) => input.write(encodeLengthPrefixedFrame(frame)),
    generation
  };
}

function scriptedRenewalChildFactory(
  lease: AuthoritySnapshotLease,
  cutChange: import("../../application/src/index.ts").ReplicaChangeRecord,
  requested: Array<{
    readonly kind: string;
    readonly workspaceId?: string;
    readonly streamToken: string;
  }>
): SshAuthorityChildFactory {
  return {
    spawn: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events = new EventEmitter();
      const reader = createLengthPrefixedFrameReader();
      stdin.on("data", (chunk: Buffer) => {
        const batch = reader.push(chunk);
        assert.equal(batch.error, undefined);
        for (const value of batch.frames) {
          const frame = value as {
            readonly kind: string;
            readonly requestId: string;
            readonly connectionGeneration: number;
            readonly workspaceId?: string;
            readonly streamToken?: string;
          };
          if (frame.kind === "renew_lease" || frame.kind === "get_cut_change") {
            requested.push({
              kind: frame.kind,
              ...(frame.workspaceId ? { workspaceId: frame.workspaceId } : {}),
              streamToken: frame.streamToken!
            });
          }
          stdout.write(encodeLengthPrefixedFrame({
            type: authorityWireFrameType,
            kind: "response",
            requestId: frame.requestId,
            connectionGeneration: frame.connectionGeneration,
            ok: true,
            result: frame.kind === "hello"
              ? { accepted: true, protocol: authorityProtocolTuple, capabilities: [] }
              : frame.kind === "get_cut_change" ? cutChange : lease
          }));
        }
      });
      return {
        stdin,
        stdout,
        stderr,
        on: (event, listener) => events.on(event, listener),
        kill: () => {
          queueMicrotask(() => events.emit("exit", 0, null));
          return true;
        }
      } satisfies SshAuthorityChild;
    }
  };
}

function collectFrames(output: PassThrough) {
  const reader = createLengthPrefixedFrameReader();
  const buffered: AuthorityServerFrame[] = [];
  const waiters = new Set<() => void>();
  output.on("data", (chunk: Buffer) => {
    const batch = reader.push(chunk);
    assert.equal(batch.error, undefined);
    buffered.push(...batch.frames as AuthorityServerFrame[]);
    for (const wake of [...waiters]) wake();
  });
  const nextResponse = (requestId: string): Promise<AuthorityResponseFrame> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for authority response ${requestId}`));
      }, 2_000);
      const check = () => {
        const index = buffered.findIndex(
          (frame) => frame.kind === "response" && frame.requestId === requestId
        );
        if (index < 0) return;
        clearTimeout(timeout);
        waiters.delete(check);
        resolve(buffered.splice(index, 1)[0] as AuthorityResponseFrame);
      };
      waiters.add(check);
      check();
    });
  return { nextResponse };
}

function helloFrame(requestId: string, connectionGeneration: number) {
  return {
    type: authorityWireFrameType,
    kind: "hello",
    requestId,
    connectionGeneration,
    workspaceId,
    channelNonceDigest: "test",
    protocol: authorityProtocolTuple
  };
}

function renewFrame(requestId: string, connectionGeneration: number, streamToken: string) {
  return {
    type: authorityWireFrameType,
    kind: "renew_lease",
    requestId,
    connectionGeneration,
    workspaceId,
    streamToken
  };
}

function cutChangeFrame(requestId: string, connectionGeneration: number, streamToken: string) {
  return {
    type: authorityWireFrameType,
    kind: "get_cut_change",
    requestId,
    connectionGeneration,
    streamToken
  };
}

function seedRepository(gitRoot: string): void {
  writeFileSync(path.join(gitRoot, "seed.md"), "seed\n");
  git(gitRoot, "add", ".");
  git(gitRoot, "commit", "-m", "seed");
}

function serialExecutor() {
  let tail = Promise.resolve();
  return {
    run: <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

interface StoredLeaseFixture {
  readonly manifest: unknown;
  readonly reservation: {
    readonly lease: {
      expiresAt: string;
      leaseId: string;
      minRetainedRevision: number;
      [key: string]: unknown;
    };
    readonly stream: {
      fromRevision: number;
      readonly [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function durableRows(filePath: string): number {
  return readFileSync(filePath, "utf8").split("\n").filter(Boolean).length;
}
