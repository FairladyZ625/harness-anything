// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("persistent SSH client sends renew_lease and returns the authority lease", async () => {
  const requested: Array<{ readonly workspaceId: string; readonly streamToken: string }> = [];
  const lease: AuthoritySnapshotLease = {
    leaseId: "lease-read-down",
    expiresAt: "2026-07-23T04:09:00.000Z",
    minRetainedRevision: 1,
    pinnedBlobSetDigest: `sha256:${"1".repeat(64)}`
  };
  const client = new PersistentSshAuthorityClient({
    target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
    workspaceId,
    channelNonceDigest: () => "sha256:channel-generation",
    protocol: authorityProtocolTuple,
    childFactory: scriptedRenewalChildFactory(lease, requested)
  });

  await client.connect();
  const renewed = await client.renewLease("stream-token");

  assert.deepEqual(renewed, lease);
  assert.deepEqual(requested, [{ workspaceId, streamToken: "stream-token" }]);
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
  generation: number
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
    readDownService
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
  requested: Array<{ readonly workspaceId: string; readonly streamToken: string }>
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
          if (frame.kind === "renew_lease") {
            requested.push({
              workspaceId: frame.workspaceId!,
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
              : lease
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
      readonly expiresAt: string;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}
