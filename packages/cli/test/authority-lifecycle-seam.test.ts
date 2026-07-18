// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { sha256Text } from "../../kernel/src/index.ts";
import type { AuthorityOperationReceipt } from "../../application/src/index.ts";
import {
  channelDigest32,
  connectionGeneration,
  type AuthorityConnectionDispatch
} from "../../daemon/src/index.ts";
import {
  assertPublicationMatchesMutationSet,
  createGitCanonicalPublicationInspector
} from "../src/daemon/authority-publication-evidence.ts";
import {
  createAuthorityRepoLifecycleController,
  makeHeldLockAttributedCoordinatorFactory,
  type AuthorityRepoComponent,
  type AuthorityRepoCompositionData,
  type AuthorityRepoLifecycleHooks,
  type AuthorityLifecycleRuntime
} from "../src/daemon/authority-lifecycle.ts";
import { openDurableAuthorityServiceState } from "../src/daemon/authority-service-state.ts";
import {
  bindAuthoritySubmissionForDispatch,
  createDaemonServiceHost,
  localAuthorityPeerPolicy
} from "../src/daemon/service-host.ts";

test("lifecycle-initial-two-repos starts and serves each component before transport publication", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot, betaRoot }) => {
    const events: string[] = [];
    const controller = controllerFixture(serviceRoot, events);
    const runtime = runtimeFixture();
    await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtime);
    await controller.startRepo({ repoId: "beta", canonicalRoot: betaRoot }, runtime);
    events.push("transport:start");
    assert.deepEqual(events, [
      "alpha:start", "alpha:serve",
      "beta:start", "beta:serve",
      "transport:start"
    ]);
    assert.notEqual(controller.component("alpha"), controller.component("beta"));
    await controller.stopAll("daemon-shutdown");
  });
});

test("lifecycle-one-repo-start-fails keeps the healthy repo published and records structured unavailability", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot, betaRoot }) => {
    const events: string[] = [];
    const controller = controllerFixture(serviceRoot, events, "beta");
    const alpha = await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtimeFixture());
    const beta = await controller.startRepo({ repoId: "beta", canonicalRoot: betaRoot }, runtimeFixture());
    assert.equal(alpha.ok, true);
    assert.equal(beta.ok, false);
    assert.ok(controller.component("alpha"));
    assert.equal(controller.component("beta"), undefined);
    assert.match(controller.unavailableReason("beta") ?? "", /fixture start failure/u);
    assert.deepEqual(events, ["alpha:start", "alpha:serve", "beta:start"]);
    await controller.stopAll("daemon-shutdown");
  });
});

test("one attachment generation shares exactly one concurrent start and serve", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot }) => {
    let releaseStart: (() => void) | undefined;
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let starts = 0;
    let serves = 0;
    const controller = createAuthorityRepoLifecycleController({
      hooks: {
        start: async ({ repo }) => {
          starts += 1;
          await startReleased;
          return componentFixture(repo.repoId);
        },
        serve: async () => {
          serves += 1;
        },
        stop: async ({ component, reason }) => component.stop(reason)
      },
      serviceStateRoot: serviceRoot,
      resolveCompositionData: async (repo) => compositionFixture(repo)
    });
    const repo = { repoId: "alpha", canonicalRoot: alphaRoot };
    const first = controller.startRepo(repo, runtimeFixture());
    const second = controller.startRepo(repo, runtimeFixture());
    releaseStart?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(starts, 1);
    assert.equal(serves, 1);
    if (firstResult.ok && secondResult.ok) assert.equal(firstResult.component, secondResult.component);
    await controller.stopAll("daemon-shutdown");
  });
});

test("lifecycle-dynamic-bind-unbind unpublishes before stop and detaches only after durable close", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot }) => {
    const events: string[] = [];
    const controller = controllerFixture(serviceRoot, events);
    await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtimeFixture());
    events.push("route:published");
    controller.unpublishRepo("alpha");
    events.push("route:unpublished");
    await controller.stopRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, "reconcile-removed");
    events.push("runtime:detached");
    await controller.stopRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, "reconcile-removed");
    assert.deepEqual(events, [
      "alpha:start", "alpha:serve", "route:published", "route:unpublished",
      "alpha:stop:reconcile-removed", "runtime:detached"
    ]);
  });
});

test("lifecycle-daemon-shutdown stops accept, drains every repo component, then releases runtime locks", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot, betaRoot }) => {
    const events: string[] = [];
    const hooks: AuthorityRepoLifecycleHooks = {
      start: async ({ repo }) => {
        events.push(`${repo.repoId}:start`);
        return componentFixture(repo.repoId);
      },
      serve: async ({ repo }) => {
        events.push(`${repo.repoId}:serve`);
      },
      stop: async ({ repo, component, reason }) => {
        events.push(`${repo.repoId}:drain`);
        events.push(`${repo.repoId}:flush-receipts`);
        await component.stop(reason);
        events.push(`${repo.repoId}:stop`);
      }
    };
    const lifecycle = createAuthorityRepoLifecycleController({
      hooks,
      serviceStateRoot: serviceRoot,
      resolveCompositionData: async (repo) => compositionFixture(repo)
    });
    const runtime = multiRepoRuntimeFixture([
      { repoId: "alpha", canonicalRoot: alphaRoot },
      { repoId: "beta", canonicalRoot: betaRoot }
    ], events);
    const host = await createDaemonServiceHost(
      runtime as Parameters<typeof createDaemonServiceHost>[0],
      [{ repoId: "alpha", canonicalRoot: alphaRoot }, { repoId: "beta", canonicalRoot: betaRoot }],
      "alpha",
      undefined,
      0,
      path.join(serviceRoot, "daemon.sock"),
      { active: 2, total: 2 },
      serviceRoot,
      { entrypoint: path.resolve("packages/cli/src/index.ts"), loadedIdentity: `sha256:${"0".repeat(64)}`, startedAt: "2026-07-16T00:00:00.000Z" },
      lifecycle
    );
    host.onStop(async () => {
      events.push("transport:stop-accept");
    });
    await host.stop();
    assert.deepEqual(events.slice(4), [
      "alpha:drain", "alpha:flush-receipts", "alpha:stop",
      "beta:drain", "beta:flush-receipts", "beta:stop",
      "runtime:stop-lock-release",
      "transport:stop-accept"
    ]);
  });
});

test("missing-server-binding-axis fails closed before component serve", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot }) => {
    let starts = 0;
    const hooks = hooksFixture([], undefined, () => { starts += 1; });
    const controller = createAuthorityRepoLifecycleController({
      hooks,
      serviceStateRoot: serviceRoot,
      resolveCompositionData: async (repo) => ({ ...compositionFixture(repo), viewId: "" })
    });
    const result = await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtimeFixture());
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /AUTHORITY_SERVER_AXIS_REQUIRED:viewId/u);
    assert.equal(starts, 0);
  });
});

test("production lifecycle rejects in-memory binding and namespace adapters", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot }) => {
    const controller = createAuthorityRepoLifecycleController({
      hooks: hooksFixture([]),
      serviceStateRoot: serviceRoot,
      resolveCompositionData: async (repo) => ({
        ...compositionFixture(repo),
        bindingRuntime: {} as AuthorityRepoCompositionData["bindingRuntime"]
      })
    });
    const result = await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtimeFixture());
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /AUTHORITY_DURABLE_ADAPTER_REQUIRED:bindingRuntime/u);
  });
});

test("restart-durable-recovery restores operation, replica, binding and namespace state before serve", async () => {
  await withRoots(async ({ serviceRoot }) => {
    const first = openDurableAuthorityServiceState({ serviceStateRoot: serviceRoot, repoId: "alpha" });
    await first.operationRegistry.put({
      workspaceId: "workspace-alpha",
      opId: "op-alpha",
      semanticDigest: "11".repeat(32),
      state: "PUBLISHED",
      commitSha: "a".repeat(40)
    });
    await first.replicaChangeLog.append({
      schema: "replica-change/v1",
      workspaceId: "workspace-alpha",
      revision: 1,
      opId: "op-alpha",
      semanticDigest: "11".repeat(32),
      commitSha: "a".repeat(40),
      previousCommit: null,
      changedAt: "2026-07-16T00:00:00.000Z"
    });
    first.bindingState.put("binding-alpha", { consumed: 2 });
    first.namespaceState.put("namespace-alpha", { nextSequence: 3 });
    await first.close();

    const replacement = openDurableAuthorityServiceState({ serviceStateRoot: serviceRoot, repoId: "alpha" });
    assert.equal((await replacement.operationRegistry.get("workspace-alpha", "op-alpha"))?.state, "PUBLISHED");
    assert.equal((await replacement.replicaChangeLog.latest("workspace-alpha"))?.revision, 1);
    assert.deepEqual(replacement.bindingState.get("binding-alpha"), { consumed: 2 });
    assert.deepEqual(replacement.namespaceState.get("namespace-alpha"), { nextSequence: 3 });
    await replacement.close();
  });
});

test("held-lock attributed factory gives one exact coordinator to a same-attribution microbatch", () => {
  let created = 0;
  let pending = 0;
  let commitAuthor: { readonly name: string; readonly email: string } | undefined;
  const runtime: AuthorityLifecycleRuntime = {
    createAttributedCoordinator: (input) => {
      created += 1;
      commitAuthor = input.commitAuthor;
      return {
        enqueue: (op) => Effect.sync(() => {
          pending += 1;
          return { opId: op.opId, entityId: op.entityId, accepted: true as const };
        }),
        flush: (reason) => Effect.sync(() => ({ reason, opCount: pending, committed: true })),
        recover: Effect.succeed({ replayedOps: 0 })
      };
    },
    enqueueMaterializerBatch: async ({ sessionId }) => ({
      branches: [{ branch: `sessions/${sessionId}`, commitCount: 1, status: "merged" as const }]
    }),
    enqueueAuthorityPublication: successfulAuthorityPublication,
    assertWriteFenceHeld: async () => undefined
  };
  const factory = makeHeldLockAttributedCoordinatorFactory(runtime);
  const attribution = {
    actor: { principal: { kind: "person" as const, personId: "person_test" }, executor: { kind: "agent" as const, id: "codex" } },
    principalSource: { kind: "daemon-authenticated" as const, providerId: "test", credentialFingerprint: "sha256:test" },
    executorSource: "client-asserted" as const
  };
  const first = factory.create({ attribution, sessionId: "session-test" });
  const second = factory.create({ attribution, sessionId: "session-test" });
  assert.equal(first, second);
  assert.equal(created, 1);
  assert.deepEqual(commitAuthor, {
    name: "Harness Anything Authority",
    email: "authority@harness-anything.local"
  });
});

test("publication-tree-mismatch uses real Git trees and rejects paths outside the canonical mutation target", async () => {
  await withRoots(async ({ alphaRoot }) => {
    git(alphaRoot, "init", "-q");
    mkdirSync(path.join(alphaRoot, "tasks", "task_T"), { recursive: true });
    writeFileSync(path.join(alphaRoot, "tasks", "task_T", "INDEX.md"), "before\n");
    git(alphaRoot, "add", ".");
    git(alphaRoot, "commit", "-q", "-m", "seed");
    const before = git(alphaRoot, "rev-parse", "HEAD");
    const trunk = git(alphaRoot, "branch", "--show-current");
    git(alphaRoot, "checkout", "-q", "-b", "sessions/session-test");
    writeFileSync(path.join(alphaRoot, "tasks", "task_T", "INDEX.md"), "after\n");
    mkdirSync(path.join(alphaRoot, "attribution-events"), { recursive: true });
    writeFileSync(path.join(alphaRoot, "attribution-events", `${sha256Text("op-test")}.jsonl`), "{}\n");
    git(alphaRoot, "add", ".");
    git(alphaRoot, "commit", "-q", "-m", "test write [op-test]");
    git(alphaRoot, "checkout", "-q", trunk);
    git(alphaRoot, "merge", "-q", "--no-ff", "sessions/session-test", "-m", "materializer: merge session session-test");

    const inspector = createGitCanonicalPublicationInspector(alphaRoot);
    const evidence = await inspector.inspectPublication(before, ["op-test"]);
    const mutationSet = {
      registryVersion: 1,
      mutations: [{
        entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_T" },
        action: { registryVersion: 1, action: "document" }
      }]
    } as const;
    assertPublicationMatchesMutationSet(evidence, mutationSet);
    assert.deepEqual(evidence.physicalChanges.map((change) => change.path), [
      "tasks/task_T/INDEX.md",
      `attribution-events/${sha256Text("op-test")}.jsonl`
    ]);
    assert.match(evidence.physicalChanges[0]!.beforeDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.match(evidence.physicalChanges[0]!.afterDigest ?? "", /^[a-f0-9]{64}$/u);

    const mismatched = {
      ...evidence,
      physicalChanges: [...evidence.physicalChanges, {
        path: "private/outside.txt",
        beforeDigest: null,
        afterDigest: "22".repeat(32)
      }]
    };
    assert.throws(
      () => assertPublicationMatchesMutationSet(mismatched, mutationSet),
      /AUTHORITY_PUBLICATION_TREE_MISMATCH:private\/outside\.txt;expectedTargets=.*;observedPaths=.*private\/outside\.txt;taskPackageAliasAllowed=true/u
    );

    writeFileSync(path.join(alphaRoot, "outside.txt"), "unowned\n");
    git(alphaRoot, "add", ".");
    git(alphaRoot, "commit", "-q", "-m", "external canonical write");
    await assert.rejects(
      inspector.inspectPublication(evidence.commitSha, ["op-external"]),
      /AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR;expectedPreviousHead=.*;expectedOpIds=op-external;head=.*;actualParents=/u
    );
  });
});

test("production composition reads publication evidence from the repo's real authored Git tree", async () => {
  await withRoots(async ({ serviceRoot, alphaRoot }) => {
    const authoredRoot = path.join(alphaRoot, "harness");
    mkdirSync(path.join(authoredRoot, "tasks", "task_T"), { recursive: true });
    git(authoredRoot, "init", "-q");
    writeFileSync(path.join(authoredRoot, "tasks", "task_T", "INDEX.md"), "before\n");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-q", "-m", "seed authored tree");
    const before = git(authoredRoot, "rev-parse", "HEAD");
    const trunk = git(authoredRoot, "branch", "--show-current");
    git(authoredRoot, "checkout", "-q", "-b", "sessions/session-test");
    writeFileSync(path.join(authoredRoot, "tasks", "task_T", "INDEX.md"), "after\n");
    mkdirSync(path.join(authoredRoot, "attribution-events"), { recursive: true });
    writeFileSync(path.join(authoredRoot, "attribution-events", `${sha256Text("op-test")}.jsonl`), "{}\n");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-q", "-m", "test write [op-test]");
    git(authoredRoot, "checkout", "-q", trunk);
    git(authoredRoot, "merge", "-q", "--no-ff", "sessions/session-test", "-m", "materializer: merge session session-test");
    let observed: ReadonlyArray<string> = [];
    const hooks: AuthorityRepoLifecycleHooks = {
      ...hooksFixture([]),
      start: async ({ repo, inspectPublication }) => {
        observed = (await inspectPublication(before, ["op-test"])).physicalChanges.map((change) => change.path);
        return componentFixture(repo.repoId);
      }
    };
    const controller = createAuthorityRepoLifecycleController({
      hooks,
      serviceStateRoot: serviceRoot,
      resolveCompositionData: async (repo) => compositionFixture(repo)
    });
    const result = await controller.startRepo({ repoId: "alpha", canonicalRoot: alphaRoot }, runtimeFixture());
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.deepEqual(observed, [
      "tasks/task_T/INDEX.md",
      `attribution-events/${sha256Text("op-test")}.jsonl`
    ]);
    await controller.stopAll("daemon-shutdown");
  });
});

test("live authority dispatch binds only an active same-repo connection and rechecks generation at submit", async () => {
  let activeChecks = 0;
  let binds = 0;
  const base = componentFixture("alpha");
  const component: AuthorityRepoComponent = {
    ...base,
    bindConnection: (context) => {
      binds += 1;
      assert.equal(context.repoId, "alpha");
      return base.commandSubmissionV2;
    }
  };
  const dispatch: AuthorityConnectionDispatch = {
    available: true,
    context: {
      schema: "authority-connection-context/v1",
      connectionId: "connection-alpha",
      connectionGeneration: connectionGeneration("generation-alpha"),
      actor: {
        personId: "person_local",
        displayName: "Local Person",
        providerId: "transport-derived/v1",
        resolvedCredential: {
          kind: "unix-socket-owner-boundary",
          issuer: "host:fixture",
          subject: "501"
        }
      },
      repoId: "alpha",
      channelBinding: {
        digest: channelDigest32(Buffer.alloc(32, 0x61)),
        source: "transport-observed"
      },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: 501,
        gid: 20
      }
    },
    assertActive: () => {
      activeChecks += 1;
    }
  };

  const bound = bindAuthoritySubmissionForDispatch(component, "alpha", dispatch);
  assert.ok(bound);
  await bound.submit(undefined as never);
  assert.equal(binds, 1);
  assert.equal(activeChecks, 2);

  const unavailable = bindAuthoritySubmissionForDispatch(component, "alpha", {
    available: false,
    code: "peer_credential_unavailable"
  });
  assert.equal(unavailable, undefined);
  assert.equal(binds, 1);
  assert.throws(
    () => bindAuthoritySubmissionForDispatch(component, "beta", dispatch),
    /AUTHORITY_CONNECTION_REPO_MISMATCH/u
  );
});

test("production peer policy requires the OS-observed UID, daemon UID and actor credential UID to agree", () => {
  const daemonUid = process.getuid?.();
  const peerCredential = {
    schema: "os-observed-peer-credential/v1" as const,
    platform: "darwin" as const,
    source: "getpeereid" as const,
    uid: daemonUid ?? 501,
    gid: 20
  };
  const actor = {
    personId: "person_local",
    displayName: "Local Person",
    providerId: "transport-derived/v1",
    resolvedCredential: {
      kind: "unix-socket-owner-boundary" as const,
      issuer: "host:fixture",
      subject: String(peerCredential.uid)
    }
  };
  const repo = { repoId: "alpha", canonicalRoot: "/tmp/alpha" };

  assert.equal(
    localAuthorityPeerPolicy({ actor, repo, peerCredential }),
    typeof daemonUid === "number"
  );
  assert.equal(localAuthorityPeerPolicy({
    actor: { ...actor, resolvedCredential: { ...actor.resolvedCredential, subject: String(peerCredential.uid + 1) } },
    repo,
    peerCredential
  }), false);
  assert.equal(localAuthorityPeerPolicy({
    actor: {
      ...actor,
      resolvedCredential: { kind: "ssh-forced-command-person", issuer: "host:fixture", subject: actor.personId }
    },
    repo,
    peerCredential
  }), false);
});

function controllerFixture(serviceStateRoot: string, events: string[], failingRepo?: string) {
  return createAuthorityRepoLifecycleController({
    hooks: hooksFixture(events, failingRepo),
    serviceStateRoot,
    resolveCompositionData: async (repo) => compositionFixture(repo)
  });
}

function hooksFixture(events: string[], failingRepo?: string, onStart?: () => void): AuthorityRepoLifecycleHooks {
  return {
    start: async ({ repo }) => {
      events.push(`${repo.repoId}:start`);
      onStart?.();
      if (repo.repoId === failingRepo) throw new Error("fixture start failure");
      return componentFixture(repo.repoId);
    },
    serve: async ({ repo }) => {
      events.push(`${repo.repoId}:serve`);
    },
    stop: async ({ repo, component, reason }) => {
      events.push(`${repo.repoId}:stop:${reason}`);
      await component.stop(reason);
    }
  };
}

function componentFixture(repoId: string): AuthorityRepoComponent {
  let stopped = false;
  const submission = {
    submit: async (): Promise<AuthorityOperationReceipt> => ({
      tag: "REJECTED",
      workspaceId: `workspace-${repoId}`,
      opId: "fixture",
      semanticDigest: "00".repeat(32),
      reason: "fixture"
    })
  };
  return {
    commandSubmissionV2: submission,
    bindConnection: () => submission,
    stop: async () => {
      if (stopped) return;
      stopped = true;
    }
  };
}

function runtimeFixture(): AuthorityLifecycleRuntime {
  return {
    createAttributedCoordinator: () => ({
      enqueue: (op) => Effect.succeed({ opId: op.opId, entityId: op.entityId, accepted: true as const }),
      flush: (reason) => Effect.succeed({ reason, opCount: 1, committed: true }),
      recover: Effect.succeed({ replayedOps: 0 })
    }),
    enqueueMaterializerBatch: async ({ sessionId }) => ({
      branches: [{ branch: `sessions/${sessionId}`, commitCount: 1, status: "merged" as const }]
    }),
    enqueueAuthorityPublication: successfulAuthorityPublication,
    assertWriteFenceHeld: async () => undefined
  };
}

async function successfulAuthorityPublication(input: {
  readonly sessionId: string;
  readonly publish: () => Promise<import("../../kernel/src/index.ts").FlushReport>;
}) {
  const flush = await input.publish();
  return {
    flush,
    materialization: {
      branches: [{ branch: `sessions/${input.sessionId}`, commitCount: 1, status: "merged" as const }]
    }
  };
}

function multiRepoRuntimeFixture(
  repos: ReadonlyArray<{ readonly repoId: string; readonly canonicalRoot: string }>,
  events: string[]
) {
  const runtimes = new Map(repos.map((repo) => [repo.repoId, {
    ...runtimeFixture(),
    enqueueInteractiveWrite: async (request: { readonly ops: ReadonlyArray<unknown> }) => ({
      flush: { reason: "explicit" as const, opCount: request.ops.length, committed: true }
    }),
    enqueueBackgroundBatch: async <Result>(request: { readonly run: () => Result | Promise<Result> }) => request.run(),
    enqueueMaterializerBatch: async () => ({ dryRun: false, merged: 0, considered: 0, branches: [], warnings: [] }),
    queryExecutionEvidencePage: async () => ({ groups: [], nextCursor: null }),
    start: async () => ({}),
    stop: async () => undefined,
    status: () => ({})
  }]));
  const status = () => ({
    started: true,
    repoCount: repos.length,
    attachedCount: repos.length,
    unavailableCount: 0,
    repos: repos.map((repo) => ({
      started: true,
      repoId: repo.repoId,
      rootDir: repo.canonicalRoot,
      canonicalRoot: repo.canonicalRoot,
      state: "attached" as const,
      queue: { depth: 0, active: false, interactiveDepth: 0, backgroundDepth: 0, activePriority: null, maxInteractiveOpsPerCommit: 32 },
      projectionGeneration: { state: "unknown" as const, validationRuns: 0, invalidations: 0, hintedInvalidations: 0, fenceRuns: 0, reconciliationRuns: 0, activeCanonicalWrites: 0, pendingTouchedPaths: 0 }
    }))
  });
  return {
    start: async () => status(),
    stop: async () => { events.push("runtime:stop-lock-release"); },
    status,
    attachRepo: async () => { throw new Error("fixture attach not used"); },
    detachRepo: async () => { throw new Error("fixture detach not used"); },
    retryUnavailableRepos: async () => [],
    getRepoRuntime: (repoId: string) => runtimes.get(repoId),
    enqueueInteractiveWrite: async () => { throw new Error("fixture manager enqueue not used"); },
    enqueueBackgroundBatch: async () => { throw new Error("fixture manager background not used"); },
    enqueueMaterializerBatch: async () => { throw new Error("fixture manager materializer not used"); }
  };
}

function compositionFixture(repo: { readonly repoId: string; readonly canonicalRoot: string }): AuthorityRepoCompositionData {
  return {
    authenticatedPersonRegistry: {
      schema: "harness-persons/v1",
      people: [],
      find: () => undefined
    },
    deriveExecutorFromParsedPreset: (presetId) => `preset:${presetId}`,
    workspaceId: `workspace-${repo.repoId}`,
    repoId: repo.repoId,
    canonicalRoot: repo.canonicalRoot,
    deviceId: "device-server-observed",
    viewId: "view-server-observed",
    sessionId: "session-server-observed",
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, commandRegistry: 1,
      policy: 2, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
    },
    authorityGeneration: 1,
    revocationEpochs: {},
    admissionTokenRef: "token-server-observed",
    operationNamespace: "namespace-server-observed",
    bindingRuntime: {
      durability: { schema: "authority-service-state-adapter/v1", recovery: "replayed-before-serve" }
    } as AuthorityRepoCompositionData["bindingRuntime"],
    namespaceVerifier: {
      verify: async () => undefined,
      durability: { schema: "authority-service-state-adapter/v1", recovery: "replayed-before-serve" }
    },
    committedEventPublisher: { publish: async () => { throw new Error("fixture publisher is not invoked"); } }
  };
}

async function withRoots(
  run: (roots: { readonly serviceRoot: string; readonly alphaRoot: string; readonly betaRoot: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-lifecycle-"));
  const serviceRoot = path.join(root, "service");
  const alphaRoot = path.join(root, "alpha");
  const betaRoot = path.join(root, "beta");
  mkdirSync(serviceRoot, { recursive: true });
  mkdirSync(alphaRoot, { recursive: true });
  mkdirSync(betaRoot, { recursive: true });
  try {
    await run({ serviceRoot, alphaRoot, betaRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ZeyuLi",
      GIT_AUTHOR_EMAIL: "33339424+FairladyZ625@users.noreply.github.com",
      GIT_COMMITTER_NAME: "ZeyuLi",
      GIT_COMMITTER_EMAIL: "33339424+FairladyZ625@users.noreply.github.com"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).trim();
}
