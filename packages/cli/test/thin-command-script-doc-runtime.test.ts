// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  daemonProtocolCommands,
  thinCliCommands,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { main, resolveCliVersion } from "../src/index.ts";
import {
  deriveCliCapabilities,
  firstCliCommand,
  firstCliCommandIndex,
  parseThinCommand,
  renderThinHelp,
} from "../src/cli/thin-command.ts";

test("thin parser converts the sole preset script target into closed typed start params", () => {
  const parsed = parseThinCommand([
    "script",
    "run",
    "preset:user-canary/check",
    "--idempotency-key",
    "once",
    "--task-id",
    "task-1",
    "--inputs",
    '{"title":"Canary"}',
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command, {
      rootDir: parsed.command.rootDir,
      json: false,
      method: "repo.preset.run.start",
      action: {
        kind: "preset-run-start",
        presetId: "user-canary",
        entrypoint: "check",
        idempotencyKey: "once",
        taskId: "task-1",
        inputs: { title: "Canary" },
      },
    });
  assert.equal(
    parseThinCommand([
      "script",
      "run",
      "user-canary/check",
      "--idempotency-key",
      "once",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "script",
      "run",
      "preset:user-canary/check",
      "--idempotency-key",
      "once",
      "--inputs",
      "not-json",
    ]).ok,
    false,
  );
});

test("thin doc commands derive descriptor-only actions from the protocol directory", () => {
  const status = parseThinCommand(["doc", "status"]),
    selectedStatus = parseThinCommand([
      "doc",
      "status",
      "--path",
      "context/a.md",
      "--path",
      "context/b.md",
    ]),
    dryRun = parseThinCommand([
      "doc",
      "sync",
      "--dry-run",
      "--path",
      "context/a.md",
      "--path",
      "context/b.md",
    ]),
    materialize = parseThinCommand(["doc", "materialize"]),
    show = parseThinCommand(["doc", "show", "--path", "tasks/task-1/INDEX.md"]),
    retire = parseThinCommand([
      "doc",
      "retire",
      "--path",
      "context/old.md",
      "--reason",
      "superseded scratch",
    ]),
    submit = parseThinCommand([
      "doc",
      "sync",
      "--submit",
      "--execution-id",
      "exec-1",
      "--path",
      "context/a.md",
      "--path",
      "context/b.md",
    ]);
  assert.equal(status.ok, true);
  assert.equal(selectedStatus.ok, true);
  assert.equal(dryRun.ok, true);
  assert.equal(materialize.ok, true);
  assert.equal(show.ok, true);
  assert.equal(retire.ok, true);
  assert.equal(submit.ok, true);
  if (status.ok)
    assert.deepEqual(status.command.action, { kind: "doc-status", paths: [] });
  if (selectedStatus.ok)
    assert.deepEqual(selectedStatus.command.action, {
      kind: "doc-status",
      paths: ["context/a.md", "context/b.md"],
    });
  if (dryRun.ok)
    assert.deepEqual(dryRun.command.action, {
      kind: "doc-dry-run",
      paths: ["context/a.md", "context/b.md"],
    });
  if (materialize.ok)
    assert.deepEqual(materialize.command.action, { kind: "doc-materialize" });
  if (show.ok)
    assert.deepEqual(show.command.action, {
      kind: "doc-show",
      path: "tasks/task-1/INDEX.md",
    });
  if (retire.ok)
    assert.deepEqual(retire.command.action, {
      kind: "doc-retire",
      path: "context/old.md",
      reason: "superseded scratch",
    });
  if (submit.ok) {
    assert.deepEqual(submit.command.action, {
      kind: "doc-submit",
      executionId: "exec-1",
      paths: ["context/a.md", "context/b.md"],
    });
    assert.deepEqual(Object.keys(submit.command.action).sort(), [
      "executionId",
      "kind",
      "paths",
    ]);
  }
  assert.equal(
    parseThinCommand(["doc", "show", "--path", "INDEX.md", "--body", "inline"])
      .ok,
    false,
  );
  assert.equal(
    parseThinCommand(["doc", "retire", "--path", "context/old.md"]).ok,
    false,
  );
});

test("doc CLI and GUI delivery surfaces do not import store, Git, or semantic compiler code", () => {
  const sources = [
    "../src/cli/thin-command.ts",
    "../../gui/src/api/api-contract-registry.ts",
    "../../gui/src/api/service-bridge.ts",
    "../../gui/src/main/local-composition-root.ts",
  ];
  for (const source of sources)
    assert.doesNotMatch(
      readFileSync(new URL(source, import.meta.url), "utf8"),
      /kernel\/src\/(?:store|domain)|local-version-control|simple-git|semantic-compiler|node:(?:child_process|fs)/u,
      source,
    );
});

test("thin parser exposes daemon-backed workspace bootstrap", () => {
  const parsed = parseThinCommand([
    "init",
    "--repo-id",
    "alpha",
    "--person-id",
    "owner",
    "--display-name",
    "Owner",
    "--name",
    "Alpha Project",
    "--add-npm-scripts",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "repo-bootstrap",
      repoId: "alpha",
      personId: "owner",
      displayName: "Owner",
      name: "Alpha Project",
      addNpmScripts: true,
    });
  assert.equal(
    parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner"]).ok,
    false,
  );
  const configureOnly = parseThinCommand([
    "init",
    "--repo-id",
    "alpha",
    "--person-id",
    "owner",
    "--display-name",
    "Owner",
    "--configure-only",
  ]);
  assert.equal(configureOnly.ok, true);
  if (configureOnly.ok)
    assert.deepEqual(configureOnly.command.action, {
      kind: "repo-bootstrap",
      repoId: "alpha",
      personId: "owner",
      displayName: "Owner",
      configureOnly: true,
    });
});

test("runtime work commands parse into closed daemon facade actions", () => {
  const run = parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--agent",
      "fable",
      "--to",
      "terra",
      "--prompt",
      "Inspect",
      "--cwd",
      "packages/cli",
      "--task",
      "task-1",
      "--resume",
      "provider-1",
      "--idempotency-key",
      "once",
      "--no-stream",
    ]),
    taskOnly = parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--agent",
      "terra",
      "--task",
      "task-1",
      "--cwd",
      ".",
    ]),
    file = parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--prompt-file",
      "prompt.txt",
    ]),
    batch = parseThinCommand(["runtime", "batch", "dispatches.json"]),
    detached = parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--prompt",
      "Inspect",
      "--detach",
      "--on-exit",
      "./notify.sh",
    ]),
    resumed = parseThinCommand([
      "runtime",
      "run",
      "--resume-dispatch",
      "dispatch_0123456789abcdef01234567",
      "--prompt",
      "Continue",
    ]),
    dispatches = parseThinCommand(["task", "dispatches", "task-1"]),
    list = parseThinCommand(["runtime", "status", "--task", "task-1"]),
    show = parseThinCommand(["runtime", "status", "runtime-1"]),
    wait = parseThinCommand([
      "runtime",
      "status",
      "runtime-1",
      "--wait",
      "--no-stream",
    ]),
    cancel = parseThinCommand(["runtime", "cancel", "runtime-1"]);
  for (const parsed of [
    run,
    taskOnly,
    file,
    batch,
    detached,
    resumed,
    dispatches,
    list,
    show,
    wait,
    cancel,
  ])
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (run.ok)
    assert.deepEqual(run.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      agentId: "fable",
      targetAgentId: "terra",
      prompt: "Inspect",
      cwd: { scope: "repo-relative", path: "packages/cli" },
      taskId: "task-1",
      providerSessionId: "provider-1",
      idempotencyKey: "once",
      noStream: true,
    });
  if (taskOnly.ok)
    assert.deepEqual(taskOnly.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      agentId: "terra",
      cwd: { scope: "repo-root" },
      taskId: "task-1",
    });
  if (file.ok)
    assert.deepEqual(file.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      promptFile: "prompt.txt",
      cwd: { scope: "repo-root" },
      taskId: null,
    });
  if (batch.ok)
    assert.deepEqual(batch.command.action, {
      kind: "runtime-batch",
      batchFile: "dispatches.json",
    });
  if (detached.ok)
    assert.deepEqual(detached.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      prompt: "Inspect",
      cwd: { scope: "repo-root" },
      taskId: null,
      detach: true,
      onExitCommand: "./notify.sh",
    });
  if (resumed.ok)
    assert.deepEqual(resumed.command.action, {
      kind: "runtime-run",
      dispatchId: "dispatch_0123456789abcdef01234567",
      prompt: "Continue",
      cwd: { scope: "repo-root" },
      taskId: null,
    });
  if (dispatches.ok)
    assert.deepEqual(
      { method: dispatches.command.method, action: dispatches.command.action },
      {
        method: "repo.task.dispatches",
        action: { kind: "task-dispatches", taskId: "task-1" },
      },
    );
  if (list.ok)
    assert.deepEqual(
      { method: list.command.method, action: list.command.action },
      {
        method: "repo.agentRuntime.overview",
        action: { kind: "runtime-status", taskId: "task-1" },
      },
    );
  if (show.ok)
    assert.deepEqual(
      { method: show.command.method, action: show.command.action },
      {
        method: "repo.agentRuntime.sessions.read",
        action: { kind: "runtime-status", runtimeSessionId: "runtime-1" },
      },
    );
  if (wait.ok)
    assert.deepEqual(wait.command.action, {
      kind: "runtime-status",
      runtimeSessionId: "runtime-1",
      wait: true,
      noStream: true,
    });
  if (cancel.ok)
    assert.deepEqual(cancel.command.action, {
      kind: "runtime-cancel",
      runtimeSessionId: "runtime-1",
    });
  assert.equal(parseThinCommand(["runtime", "run", "worker"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "batch"]).ok, false);
  assert.equal(
    parseThinCommand(["runtime", "batch", "dispatches.json", "--detach"]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--prompt",
      "Inspect",
      "--on-exit",
      "./notify.sh",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--prompt",
      "one",
      "--prompt-file",
      "two",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--task",
      "task-1",
      "--prompt",
      "one",
      "--prompt-file",
      "two",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--to",
      "terra",
      "--prompt",
      "Inspect",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand(["runtime", "status", "runtime-1", "--task", "task-1"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["runtime", "status", "--wait"]).ok, false);
  assert.equal(
    parseThinCommand(["runtime", "status", "runtime-1", "--no-stream"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["runtime", "wait", "runtime-1"]).ok, false);
});
