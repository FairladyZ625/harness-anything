// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import { resolveLocalCliActorAttribution } from "../src/composition/local-principal.ts";
import { createCliCommandService, materializeExportedSession } from "../src/daemon/command-service.ts";
import type { CliDaemonRuntime } from "../src/daemon/queued-write-coordinator.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI write commands require explicit local actor attribution", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "--title", "No Actor"], false, withoutActorAttributionEnv());

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "write_rejected");
    assert.match(result.error?.hint ?? "", /Local CLI writes require explicit actor attribution/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

test("CLI rejects inherited human actor attribution with an executable flag migration hint", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init"], false, actorEnv("human:person_alice", "Alice Owner", "alice@example.test"));

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "AuthMissing");
    assert.match(result.error?.hint ?? "", /--actor human:person_alice/u);
    assert.match(result.error?.hint ?? "", /ha\(\) \{ command ha --actor human:person_alice "\$@"; \}/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

test("CLI accepts explicit human flag despite an inherited human environment value", () => {
  withTempRoot((rootDir) => {
    const env = actorEnv("human:inherited_parent", "Alice Owner", "alice@example.test");
    const result = runJson(rootDir, ["--actor", "human:person_alice", "init"], true, env);

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness")), true);
  });
});

test("CLI also accepts an agent actor through the explicit flag", () => {
  withTempRoot((rootDir) => {
    const env = actorEnv("", "Codex Writer", "codex@example.test");
    const result = runJson(rootDir, ["--actor", "agent:codex", "init"], true, env);

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness")), true);
  });
});

test("CLI keeps agent HARNESS_ACTOR working and rejects system entity attribution", () => {
  withTempRoot((rootDir) => {
    const accepted = runJson(rootDir, ["init"], true, actorEnv("agent:codex", "Harness Writer", "writer@example.test"));
    assert.equal(accepted.ok, true);
  });
  withTempRoot((rootDir) => {
    const rejected = runJson(rootDir, ["init"], false, actorEnv("system:release-bot", "Harness Writer", "writer@example.test"));
    assert.equal(rejected.ok, false);
    assert.match(rejected.error?.hint ?? "", /system actor cannot author canonical entity writes/u);
  });
});

test("daemon attribution preserves authenticated principal and asserted executor as two axes", () => {
  const attribution = daemonActorAttribution({
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    roles: ["writer"],
    providerId: "forced-command",
    resolvedCredential: {
      kind: "ssh-forced-command-person",
      issuer: "test",
      subject: "person_alice"
    }
  }, { kind: "agent", id: "codex" });

  assert.deepEqual(attribution.writeAttribution.actor, {
    principal: { kind: "person", personId: "person_alice" },
    executor: { kind: "agent", id: "codex" }
  });
  assert.equal(attribution.writeAttribution.principalSource.kind, "daemon-authenticated");
  assert.equal(attribution.writeAttribution.executorSource, "client-asserted");

  const directHuman = daemonActorAttribution({
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    roles: ["writer"],
    providerId: "forced-command",
    resolvedCredential: {
      kind: "ssh-forced-command-person",
      issuer: "test",
      subject: "person_alice"
    }
  });
  assert.equal(directHuman.writeAttribution.actor.executor, null);
  assert.equal(directHuman.writeAttribution.executorSource, "none");
});

test("daemon command service preserves A/X attribution through the queued coordinator boundary", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-attribution-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    const requests: Parameters<CliDaemonRuntime["enqueueInteractiveWrite"]>[0][] = [];
    const runtime: CliDaemonRuntime = {
      enqueueInteractiveWrite: async (request) => {
        requests.push(request);
        return { flush: { reason: "explicit", opCount: request.ops.length, committed: true } };
      },
      status: () => ({})
    };
    const service = createCliCommandService(runtime);
    await service.runCommand({
      command: {
        rootDir,
        json: true,
        action: { kind: "new-task", title: "Cross Boundary", titleProvided: true, slug: "cross-boundary" }
      },
      session: {
        runtime: "codex",
        sessionId: "thread-cross-boundary",
        source: "runtime",
        detectedAt: "2026-07-14T00:00:00.000Z"
      }
    }, {
      actor: {
        personId: "person_alice",
        displayName: "Alice",
        primaryEmail: "alice@example.test",
        roles: ["writer"],
        providerId: "forced-command",
        resolvedCredential: { kind: "ssh-forced-command-person", issuer: "test", subject: "person_alice" }
      },
      executor: { kind: "agent", id: "codex" }
    });

    assert.ok(requests.length > 0);
    const attributed = requests.filter((request) => "attribution" in request);
    const operational = requests.filter((request) => "operationalActor" in request);
    assert.equal(attributed.every((request) => request.attribution.actor.principal.personId === "person_alice"), true);
    assert.equal(attributed.every((request) => request.attribution.actor.executor?.id === "codex"), true);
    assert.equal(attributed.every((request) => request.sessionId === "thread-cross-boundary"), true);
    assert.equal(operational.length, 1);
    assert.deepEqual(operational[0]?.operationalActor, {
      scope: "operational",
      kind: "agent",
      id: "runtime-event-cli"
    });
    assert.equal("attribution" in operational[0]!, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon command service rejects malformed caller sessions and always settles request accounting", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-session-contract-"));
  try {
    let started = 0;
    let settled = 0;
    const runtime: CliDaemonRuntime = {
      enqueueInteractiveWrite: async () => ({ flush: { reason: "explicit", opCount: 0, committed: true } }),
      status: () => ({})
    };
    const service = createCliCommandService(runtime, {
      onCommandStart: () => { started += 1; },
      onCommandSettled: () => { settled += 1; }
    });

    const receipt = await service.runCommand({
      command: {
        rootDir,
        json: true,
        action: { kind: "status" }
      },
      session: {
        runtime: "codex",
        sessionId: "../cross-request",
        source: "runtime",
        detectedAt: "not-a-timestamp"
      }
    });

    assert.equal(receipt.ok, false);
    if (!receipt.ok) {
      assert.equal(receipt.error.code, "invalid_session");
      assert.match(receipt.error.hint, /sessionId|detectedAt/u);
    }
    assert.equal(started, 1);
    assert.equal(settled, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon Session synchronization fails closed when the target branch conflicts", async () => {
  const runtime: CliDaemonRuntime = {
    enqueueInteractiveWrite: async () => ({ flush: { reason: "explicit", opCount: 0, committed: true } }),
    enqueueMaterializerBatch: async () => ({
      dryRun: false,
      merged: 0,
      considered: 1,
      branches: [{
        branch: "sessions/conflicting-session",
        commitCount: 1,
        status: "conflict",
        commits: ["abc123"],
        warning: "session merge conflict"
      }],
      warnings: ["session merge conflict"],
      projectionRebuilt: false,
      attributionEventsProjected: 0
    }),
    status: () => ({})
  };

  await assert.rejects(materializeExportedSession(runtime, {
    session: {
      schema: "provenance-session/v1",
      sessionId: "conflicting-session",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-15T00:00:00.000Z",
      exportedAt: "2026-07-15T00:01:00.000Z"
    },
    path: "sessions/conflicting-session.md"
  }), (error) => {
    assert.equal((error as { readonly code?: unknown }).code, "write_failed");
    assert.match(String((error as { readonly reason?: unknown }).reason), /session merge conflict/u);
    return true;
  });
});

test("local resolver combines configured principal and asserted executor once", () => {
  withTempRoot((rootDir) => {
    const attribution = resolveLocalCliActorAttribution(
      { rootDir },
      {
        ...actorEnv("agent:codex", "Harness Writer", "writer@example.test"),
        HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user")
      }
    );
    assert.deepEqual(attribution.writeAttribution.actor, {
      principal: { kind: "person", personId: "person_test" },
      executor: { kind: "agent", id: "codex" }
    });
    assert.deepEqual(attribution.writeAttribution.principalSource, {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: attribution.writeAttribution.principalSource.kind === "local-configured"
        ? attribution.writeAttribution.principalSource.authoritySha256
        : "unreachable"
    });
    assert.equal(attribution.writeAttribution.executorSource, "client-asserted");
  });
});

test("local resolver rejects a disabled configured person", () => {
  withTempRoot((rootDir) => {
    writeFileSync(path.join(rootDir, "harness/people.yaml"), JSON.stringify({
      schema: "harness-people/v1",
      people: [{
        personId: "person_test",
        displayName: "Harness Test",
        roles: ["writer"],
        credentials: [],
        disabled: true
      }],
      roles: [{ roleId: "writer", commandClasses: ["repo-write"] }]
    }), "utf8");
    assert.throws(
      () => resolveLocalCliActorAttribution(
        { rootDir },
        {
          ...actorEnv("agent:codex", "Harness Writer", "writer@example.test"),
          HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user")
        }
      ),
      /person_test.*disabled/u
    );
  });
});

test("local resolver accepts the I1 PersonRegistry.find seam without importing its loader", () => {
  withTempRoot((rootDir) => {
    const authorityPath = path.join(rootDir, "harness/persons.yaml");
    writeFileSync(authorityPath, "schema: persons/v1\n", "utf8");
    const attribution = resolveLocalCliActorAttribution(
      { rootDir },
      actorEnv("agent:codex", "Harness Writer", "writer@example.test"),
      undefined,
      {
        authority: "persons.yaml",
        authorityPath,
        find: (personId) => personId === "person_test"
          ? { personId, displayName: "Harness Test" }
          : undefined
      }
    );
    assert.equal(attribution.writeAttribution.principalSource.kind, "local-configured");
    if (attribution.writeAttribution.principalSource.kind === "local-configured") {
      assert.equal(attribution.writeAttribution.principalSource.authority, "persons.yaml");
    }
  });
});

test("CLI checker reports the two retained inherited-human decision records and accepts compliant records", () => {
  withTempRoot((rootDir) => {
    const env = actorEnv("agent:checker-setup", "Harness Checker", "checker@example.test");
    runJson(rootDir, ["init"], true, env);
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    mkdirSync(path.dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, [
      journalRecord("1783569188028-50553f50-f2d0970d66929820", "decision/dec_mrcz1kqh", "human", "zeyuli", "env"),
      journalRecord("1783569241103-9d404e49-5f0e69aed277e433", "decision/dec_mrcz2q6k", "human", "zeyuli", "env")
    ].join("\n") + "\n", "utf8");

    const failed = runJson(rootDir, ["check", "--profile", "source-package"], false, env);
    const findings = (failed.warnings as ReadonlyArray<Record<string, unknown>>)
      .filter((warning) => warning.source === "actor-attribution-checker");

    assert.equal(failed.ok, false);
    assert.equal(findings.length, 2);
    assert.equal(findings.every((finding) => finding.code === "human_actor_from_inherited_env"), true);
    assert.equal(findings.some((finding) => String(finding.message).includes("dec_mrcz1kqh")), true);
    assert.equal(findings.some((finding) => String(finding.message).includes("dec_mrcz2q6k")), true);

    writeFileSync(journalPath, [
      journalRecord("op-agent-env", "task/task_agent", "agent", "codex", "env"),
      journalRecord("op-human-flag", "task/task_human", "human", "person_alice", "flag")
    ].join("\n") + "\n", "utf8");

    const passed = runJson(rootDir, ["check", "--profile", "source-package"], true, env);
    assert.equal(passed.ok, true);
    assert.equal((passed.warnings as ReadonlyArray<Record<string, unknown>>)
      .some((warning) => warning.source === "actor-attribution-checker"), false);
  });
});

test("CLI local writes preserve distinct git authors for distinct actors", () => {
  withTempRoot((rootDir) => {
    const aliceEnv = actorEnv("agent:codex", "Alice Owner", "alice@example.test");
    const bobEnv = actorEnv("agent:codex", "Bob Builder", "bob@example.test");
    runJson(rootDir, ["init"], true, aliceEnv);
    setConfiguredIdentity(rootDir, "person_alice", "Alice Owner");
    const alice = runJson(rootDir, ["new-task", "--title", "Alice Authored"], true, aliceEnv);
    setConfiguredIdentity(rootDir, "person_bob", "Bob Builder");
    const bob = runJson(rootDir, ["new-task", "--title", "Bob Authored"], true, bobEnv);

    assertGeneratedTaskId(alice.taskId);
    assertGeneratedTaskId(bob.taskId);
    const authors = git(path.join(rootDir, "harness"), ["log", "--format=%an <%ae>"]).split(/\r?\n/u);
    assert.equal(authors.includes("Alice Owner <alice@example.test>"), true);
    assert.equal(authors.includes("Bob Builder <bob@example.test>"), true);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DIRECT_WRITE_REASON: "test",
        ...env
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function actorEnv(actor: string, name: string, email: string): Readonly<Record<string, string>> {
  return {
    HARNESS_ACTOR: actor,
    HARNESS_GIT_AUTHOR_NAME: name,
    HARNESS_GIT_AUTHOR_EMAIL: email
  };
}

function setConfiguredIdentity(rootDir: string, personId: string, displayName: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  const configPath = path.join(harnessRoot, "harness.yaml");
  const body = readFileSync(configPath, "utf8")
    .replace(/^    personId:.*$/mu, `    personId: ${personId}`)
    .replace(/^    displayName:.*$/mu, `    displayName: ${displayName}`);
  writeFileSync(configPath, body, "utf8");
  git(harnessRoot, ["add", "harness.yaml"]);
  git(harnessRoot, ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-m", `test: configure ${personId}`]);
}

function journalRecord(opId: string, entityId: string, kind: string, id: string, source: string): string {
  return JSON.stringify({
    schema: "write-journal/v1",
    opId,
    entityId,
    kind: "decision_propose",
    actor: { kind, id, source },
    at: "2026-07-09T03:54:01.100Z"
  });
}

function withoutActorAttributionEnv(): Readonly<Record<string, string>> {
  return {
    HARNESS_ACTOR: "",
    HARNESS_GIT_AUTHOR_NAME: "",
    HARNESS_GIT_AUTHOR_EMAIL: "",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: ""
  };
}

function git(rootDir: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
