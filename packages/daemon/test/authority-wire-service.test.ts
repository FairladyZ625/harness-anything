// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import {
  connectionGeneration,
  createAcceptedConnectionEvidence,
  type AuthorityConnectionContext,
  type DaemonRepoNamespace
} from "../src/index.ts";
import type {
  AuthorityRepoComponent,
  AuthorityRepoLifecycleController
} from "../src/index.ts";
import { createAuthorityWireIngressHandler } from "../src/index.ts";
import { serveAuthorityForcedCommand } from "../src/authority/forced-command-session.ts";
import {
  authorityWireFrameType,
  type AuthorityResponseFrame,
  type AuthorityServerFrame
} from "../src/authority/protocol.ts";
import { createAuthorityReadDownService } from "../src/authority/read-down-service.ts";
import {
  createAuthorityReplicationContentStore,
  createContentEnrichedReplicaChangeLog
} from "../src/authority/replication-content-store.ts";
import {
  createLengthPrefixedFrameReader,
  encodeLengthPrefixedFrame
} from "../src/transport/length-frame-codec.ts";

test("authority-wire service binds the authenticated principal to the exact accepted connection", async () => {
  const repo: DaemonRepoNamespace = { repoId: "canonical", canonicalRoot: process.cwd() };
  const generation = connectionGeneration("wire-generation");
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "wire-connection",
    connectionGeneration: generation,
    daemonInstanceId: "daemon-production",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    },
    serverRandom: Buffer.alloc(32, 0x41)
  });
  let boundContext: AuthorityConnectionContext | undefined;
  let forcedSessionStarted = false;
  const component: AuthorityRepoComponent = {
    commandSubmissionV2: { submit: async () => { throw new Error("not used"); } },
    bindConnection: (context) => {
      boundContext = context;
      return {
        submit: async () => { throw new Error("not used"); },
        serveForcedCommand: () => {
          forcedSessionStarted = true;
          return { close: async () => {} };
        }
      };
    },
    stop: async () => {}
  };
  const lifecycle = lifecycleWith(component);
  const handler = createAuthorityWireIngressHandler({
    authorityLifecycle: lifecycle,
    repoBindings: () => [{
      repo,
      identity: {
        identityProvider: {
          providerId: "transport-derived/v1",
          authenticate: async () => ({
            ok: true,
            personId: "person_alice",
            primaryEmail: "alice@example.test",
            providerId: "transport-derived/v1",
            credential: {
              kind: "ssh-forced-command-person",
              issuer: "sshd:authorized_keys",
              subject: "person_alice"
            }
          }),
          authorize: async () => ({ ok: true })
        },
        personRegistry: {
          schema: "harness-persons/v1",
          people: [{ personId: "person_alice", displayName: "Alice" }],
          find: (personId) => personId === "person_alice"
            ? { personId, displayName: "Alice" }
            : undefined
        }
      }
    }]
  });
  const stream = new PassThrough();

  await handler({
    bootstrap: {
      type: "harness-daemon.ssh-forced-command/v2",
      streamProtocol: "harness-authority-wire/v1",
      personId: "person_alice",
      canonicalRoot: repo.canonicalRoot
    },
    authContext: {
      transportKind: "unix-socket",
      endpoint: "/tmp/authority-wire.sock",
      sshForcedCommand: {
        personId: "person_alice",
        canonicalRoot: repo.canonicalRoot,
        source: "sshd-authorized-keys-forced-command"
      }
    },
    input: stream,
    output: stream,
    acceptedConnection: {
      evidence,
      connectionId: evidence.connectionId,
      connectionGeneration: evidence.connectionGeneration,
      isActive: () => true,
      assertActive: () => {}
    },
    acceptedConnectionEvidence: evidence
  });

  assert.equal(forcedSessionStarted, true);
  assert.equal(boundContext?.actor.personId, "person_alice");
  assert.equal(boundContext?.actor.primaryEmail, "alice@example.test");
  assert.equal(boundContext?.connectionId, evidence.connectionId);
  assert.deepEqual(boundContext?.channelBinding.digest, evidence.channelBinding.digest);
  assert.deepEqual(boundContext?.peerCredential, evidence.peerCredential.value);
});

test("read-down snapshot manifest and blob remain verifiable across service restart and expire explicitly", async () => {
  const fixture = createReadDownFixture();
  try {
    writeFileSync(path.join(fixture.gitRoot, "z-last.md"), "z\n");
    mkdirSync(path.join(fixture.gitRoot, "docs"));
    writeFileSync(path.join(fixture.gitRoot, "docs", "a-first.md"), "alpha\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "seed");
    const first = fixture.open("2026-07-23T04:00:00.000Z");
    const reservation = await first.service.beginSnapshot();
    const manifest = await first.service.getManifest(
      reservation.stream.streamToken,
      reservation.cut.manifestDigest
    );

    assert.equal(reservation.cut.revision, 0);
    assert.equal(reservation.stream.fromRevision, 1);
    assert.deepEqual(manifest.entries.map((entry) => entry.path), ["docs/a-first.md", "z-last.md"]);
    const entry = manifest.entries[0]!;
    const blob = await first.service.getBlob(reservation.stream.streamToken, entry.blobDigest);
    const bytes = Buffer.from(blob.bytes, "base64");
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.blobDigest);
    assert.equal(bytes.toString("utf8"), "alpha\n");
    await assert.rejects(
      first.service.getManifest(reservation.stream.streamToken, `sha256:${"0".repeat(64)}`),
      /MANIFEST_DIGEST_MISMATCH/u
    );

    unlinkSync(path.join(fixture.gitRoot, "z-last.md"));
    git(fixture.gitRoot, "add", "-A");
    git(fixture.gitRoot, "commit", "-m", "delete");
    const deleteCommit = git(fixture.gitRoot, "rev-parse", "HEAD");
    await first.changeLog.append({
      schema: "replica-change/v1",
      workspaceId: "workspace-read-down",
      revision: 1,
      opId: "op-delete",
      semanticDigest: "delete",
      commitSha: deleteCommit,
      previousCommit: reservation.cut.commitSha,
      changedAt: "2026-07-23T04:00:01.000Z"
    });
    const deletion = await first.service.changesAfter(reservation.stream.streamToken, 0);
    assert.deepEqual(deletion.changes[0]?.paths.find((change) => change.path === "z-last.md"), {
      path: "z-last.md",
      blobDigest: null,
      mode: null,
      tombstone: true
    });

    const restarted = fixture.open("2026-07-23T04:01:00.000Z");
    assert.equal(
      (await restarted.service.getManifest(
        reservation.stream.streamToken,
        reservation.cut.manifestDigest
      )).cut.commitSha,
      reservation.cut.commitSha
    );
    const expired = fixture.open("2026-07-23T04:06:00.001Z");
    await assert.rejects(
      expired.service.changesAfter(reservation.stream.streamToken, reservation.cut.revision),
      /SNAPSHOT_EXPIRED/u
    );

    fixture.state.put(`blob:${entry.blobDigest}`, "damaged");
    await assert.rejects(
      restarted.service.getBlob(reservation.stream.streamToken, entry.blobDigest),
      /BLOB_DIGEST_MISMATCH/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("a subscribed authority session receives another session's commit and repairs a dropped hint with changes_after", async () => {
  const fixture = createReadDownFixture();
  try {
    writeFileSync(path.join(fixture.gitRoot, "initial.md"), "initial\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "initial");
    const initialCommit = git(fixture.gitRoot, "rev-parse", "HEAD");
    const opened = fixture.open("2026-07-23T04:00:00.000Z");
    const submission = committingSubmissionService(fixture.gitRoot, opened.changeLog);
    const subscriber = openWireSession(submission, opened.changeLog, opened.service, 1);
    const writer = openWireSession(submission, opened.changeLog, opened.service, 2);
    try {
      subscriber.send(helloFrame("hello-b", 1));
      writer.send(helloFrame("hello-a", 2));
      await subscriber.frames.nextResponse("hello-b");
      await writer.frames.nextResponse("hello-a");
      subscriber.send({
        type: authorityWireFrameType,
        kind: "begin_snapshot_and_subscribe",
        requestId: "begin-b",
        connectionGeneration: 1,
        workspaceId: "workspace-read-down"
      });
      const begin = await subscriber.frames.nextResponse("begin-b");
      assert.equal(begin.ok, true);
      const reservation = begin.result as {
        readonly cut: { readonly revision: number; readonly commitSha: string };
        readonly stream: { readonly streamToken: string; readonly fromRevision: number };
      };
      assert.equal(reservation.cut.revision, 0);
      assert.equal(reservation.cut.commitSha, initialCommit);
      assert.equal(reservation.stream.fromRevision, 1);

      writer.send({
        type: authorityWireFrameType,
        kind: "submit",
        requestId: "submit-a",
        connectionGeneration: 2,
        envelope: {
          workspaceId: "workspace-read-down",
          opId: "op-cross-writer",
          claimedDigest: "semantic-cross-writer",
          command: "repo.document.write",
          operation: { opId: "op-cross-writer", entityId: "task:cross", kind: "doc_write", payload: {} },
          delegationToken: "test",
          channelNonceDigest: "test",
          protocol: authorityProtocolTuple
        }
      });
      const submit = await writer.frames.nextResponse("submit-a");
      assert.equal(submit.ok, true);
      const hint = await subscriber.frames.next((frame) => frame.kind === "replica_change");
      assert.equal(hint.kind === "replica_change" ? hint.change.revision : -1, 1);

      subscriber.send({
        type: authorityWireFrameType,
        kind: "changes_after",
        requestId: "catch-up-b",
        connectionGeneration: 1,
        workspaceId: "workspace-read-down",
        streamToken: reservation.stream.streamToken,
        sinceRevision: 0
      });
      const caughtUp = await subscriber.frames.nextResponse("catch-up-b");
      const result = caughtUp.result as {
        readonly throughRevision: number;
        readonly changes: ReadonlyArray<{
          readonly revision: number;
          readonly previousCommit: string | null;
          readonly paths: ReadonlyArray<{ readonly path: string; readonly tombstone: boolean }>;
        }>;
      };
      assert.equal(result.throughRevision, 1);
      assert.deepEqual(result.changes.map((change) => change.revision), [1]);
      assert.equal(result.changes[0]?.previousCommit, initialCommit);
      assert.equal(result.changes[0]?.paths.length, 1);
      assert.equal(result.changes[0]?.paths[0]?.path, "tail.md");
      assert.equal(result.changes[0]?.paths[0]?.tombstone, false);

      subscriber.send({
        type: authorityWireFrameType,
        kind: "changes_after",
        requestId: "no-duplicates-b",
        connectionGeneration: 1,
        workspaceId: "workspace-read-down",
        streamToken: reservation.stream.streamToken,
        sinceRevision: 1
      });
      const noDuplicates = await subscriber.frames.nextResponse("no-duplicates-b");
      assert.deepEqual((noDuplicates.result as { readonly changes: ReadonlyArray<unknown> }).changes, []);
    } finally {
      await writer.session.close();
      await subscriber.session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

function lifecycleWith(component: AuthorityRepoComponent): AuthorityRepoLifecycleController {
  return {
    startRepo: async () => ({ ok: true, component }),
    unpublishRepo: () => component,
    stopRepo: async () => {},
    stopAll: async () => {},
    component: () => component,
    unavailableReason: () => undefined
  };
}

function createReadDownFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-read-down-"));
  const gitRoot = path.join(root, "canonical");
  mkdirSync(gitRoot);
  git(gitRoot, "init", "-q");
  git(gitRoot, "config", "user.name", "Authority Test");
  git(gitRoot, "config", "user.email", "authority@example.test");
  const base = createInMemoryReplicaChangeLog();
  const serial = serialExecutor();
  const stateValues = new Map<string, unknown>();
  const state = {
    get: <Value>(key: string) => stateValues.get(key) as Value | undefined,
    put: (key: string, value: unknown) => stateValues.set(key, structuredClone(value)),
    entries: <Value>() => [...stateValues.entries()] as ReadonlyArray<readonly [string, Value]>
  };
  return {
    gitRoot,
    state,
    open: (timestamp: string) => {
      const content = createAuthorityReplicationContentStore({ gitRoot, state });
      const changeLog = createContentEnrichedReplicaChangeLog(base, content);
      return {
        changeLog,
        service: createAuthorityReadDownService({
          workspaceId: "workspace-read-down",
          epoch: "7",
          gitRoot,
          state,
          replicaChangeLog: changeLog,
          content,
          publicationExecutor: serial,
          now: () => new Date(timestamp)
        })
      };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function committingSubmissionService(
  gitRoot: string,
  changeLog: ReplicaChangeLog
): AuthoritySubmissionService {
  return {
    submit: async (envelope) => {
      const previousCommit = git(gitRoot, "rev-parse", "HEAD");
      writeFileSync(path.join(gitRoot, "tail.md"), "tail\n");
      git(gitRoot, "add", "tail.md");
      git(gitRoot, "commit", "-m", envelope.opId);
      const commitSha = git(gitRoot, "rev-parse", "HEAD");
      await changeLog.append({
        schema: "replica-change/v1",
        workspaceId: envelope.workspaceId,
        revision: 1,
        opId: envelope.opId,
        semanticDigest: envelope.claimedDigest,
        commitSha,
        previousCommit,
        changedAt: "2026-07-23T04:00:01.000Z"
      });
      return {
        tag: "COMMITTED",
        workspaceId: envelope.workspaceId,
        opId: envelope.opId,
        semanticDigest: envelope.claimedDigest,
        revision: 1,
        commitSha,
        previousCommit
      };
    },
    getOperation: async () => undefined
  };
}

function openWireSession(
  submissionService: AuthoritySubmissionService,
  replicaChangeLog: ReplicaChangeLog,
  readDownService: ReturnType<typeof createAuthorityReadDownService>,
  generation: number
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output);
  const session = serveAuthorityForcedCommand({
    input,
    output,
    workspaceId: "workspace-read-down",
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
  const next = (predicate: (frame: AuthorityServerFrame) => boolean): Promise<AuthorityServerFrame> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for authority frame; buffered=${JSON.stringify(buffered)}`));
      }, 2_000);
      const check = () => {
        const index = buffered.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timeout);
        waiters.delete(check);
        resolve(buffered.splice(index, 1)[0]!);
      };
      waiters.add(check);
      check();
    });
  return {
    next,
    nextResponse: (requestId: string) => next(
      (frame): frame is AuthorityResponseFrame => frame.kind === "response" && frame.requestId === requestId
    ) as Promise<AuthorityResponseFrame>
  };
}

function helloFrame(requestId: string, connectionGeneration: number) {
  return {
    type: authorityWireFrameType,
    kind: "hello",
    requestId,
    connectionGeneration,
    workspaceId: "workspace-read-down",
    channelNonceDigest: "test",
    protocol: authorityProtocolTuple
  };
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
