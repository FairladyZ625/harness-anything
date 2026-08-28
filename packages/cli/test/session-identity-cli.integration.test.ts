// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts");
const claudeIdentity = {
  runtime: "claude",
  sessionId: "claude-interactive-session",
  transcriptReachability: "by_session_id",
};

test("interactive CLI Task, Fact, and Decision writes carry resolver-owned session identity", () => {
  const fixture = setup(),
    claude = {
      CLAUDE_CODE_SESSION_ID: claudeIdentity.sessionId,
      CLAUDE_CODE_HOST_SESSION_ID: "local-must-not-be-forwarded",
    };
  seedSettingsEvent({ rootDir: fixture.root, repoId: "interactive-session" });
  try {
    assert.equal(run(fixture, ["daemon", "start", "--service"]).ok, true);
    assert.equal(
      run(fixture, [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        "interactive-session",
        "--root",
        fixture.root,
        "--no-link",
      ]).ok,
      true,
    );

    assert.equal(
      run(
        fixture,
        ["task", "create", "--id", "task-interactive-session", "--admin", "--title", "Interactive Session"],
        claude,
      ).outcome,
      "applied",
    );
    const fact = run(
      fixture,
      [
        "fact",
        "record",
        "task-interactive-session",
        "--text",
        "Interactive writes retain session identity.",
        "--source",
        "cli-e2e",
        "--confidence",
        "high",
      ],
      claude,
    );
    const proposal = JSON.stringify({
      title: "Interactive session",
      question: "Should interactive writes retain session identity?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Retain it" }],
      rejected: [
        {
          id: "RJ1",
          text: "Discard it",
          whyNot: "The association cannot be recovered later",
        },
      ],
      claims: [],
      fulfillments: [],
      relations: [],
    });
    const proposed = run(fixture, ["decision", "propose", "--json-input", "@-"], claude, proposal),
      proposedEvidence = evidence(proposed),
      decisionId = String(proposedEvidence.decisionId);

    const task = evidence(run(fixture, ["task", "show", "task-interactive-session"])).task as { provenance: unknown[] };
    const shownFact = evidence(run(fixture, ["fact", "show", "--id", String(fact.factId)])).fact as {
      provenance: unknown[];
    };
    const decision = evidence(run(fixture, ["decision", "show", decisionId])).decision as { provenance: unknown[] };
    for (const provenance of [task.provenance, shownFact.provenance, decision.provenance])
      assert.deepEqual(identity(provenance), claudeIdentity);
    const decisionDocument = readFileSync(path.join(fixture.root, "harness", String(proposed.path)), "utf8");
    assert.match(decisionDocument, new RegExp(claudeIdentity.sessionId, "u"));
    assert.doesNotMatch(decisionDocument, /local-must-not-be-forwarded/u);

    assert.equal(
      run(fixture, ["task", "create", "--id", "task-interactive-codex", "--admin", "--title", "Interactive Codex"], {
        CODEX_THREAD_ID: "codex-interactive-thread",
      }).outcome,
      "applied",
    );
    const codexTask = evidence(run(fixture, ["task", "show", "task-interactive-codex"])).task as {
      provenance: unknown[];
    };
    assert.deepEqual(identity(codexTask.provenance), {
      runtime: "codex",
      sessionId: "codex-interactive-thread",
      transcriptReachability: "by_session_id",
    });

    assert.equal(
      run(fixture, ["task", "create", "--id", "task-session-unavailable", "--admin", "--title", "No Session"], {
        CLAUDE_CODE_HOST_SESSION_ID: "local-is-not-a-session",
      }).outcome,
      "applied",
    );
    const unavailable = evidence(run(fixture, ["task", "show", "task-session-unavailable"])).task as {
      provenance: unknown[];
    };
    assert.deepEqual(identity(unavailable.provenance), {
      runtime: "unavailable",
      sessionId: null,
      transcriptReachability: "unavailable",
    });
  } finally {
    stop(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

function setup(): { parent: string; root: string; userRoot: string } {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-interactive-session-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Session Identity Test");
  git(root, "config", "user.email", "session-identity@example.test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return { parent, root, userRoot };
}
function run(
  fixture: { root: string; userRoot: string },
  args: readonly string[],
  session: Readonly<Record<string, string>> = {},
  input?: string,
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot, session),
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function cliEnv(root: string, userRoot: string, session: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_DAEMON_ID: _daemonId,
    CLAUDE_CODE_SESSION_ID: _claude,
    CLAUDE_CODE_HOST_SESSION_ID: _host,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _codex,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    ...session,
  };
}
function evidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
function identity(provenance: unknown[]): Record<string, unknown> {
  assert.equal(provenance.length, 1);
  const { boundAt: _boundAt, ...value } = provenance[0] as Record<string, unknown>;
  return value;
}
function stop(fixture: { root: string; userRoot: string }): void {
  if (readDaemonPid(fixture.userRoot, "default") !== null)
    spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "stop"], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot, {}),
    });
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
