// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader, type FrozenCompletionContract } from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  validateDaemonTaskSnapshotList,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// Submission pulls CI observations for the configured workflows; this repository has no GitHub remote.
const ciBin = mkdtempSync(path.join(tmpdir(), "ha-contract-freeze-gh-")),
  originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(path.join(ciBin, "gh"), 'console.log("[]");\n');
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const worker = withRoleBinding(
  { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } }, source: "local" },
  "repo-write",
);
const owner = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" } as const;
const githubCiMapping =
  "  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

async function submittedTask(name: string, gates: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${name}-`)),
    repoId = workspaceId(name),
    taskId = `task-${name}`,
    executionId = `execution-${name}`;
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), `settings:\n  ci:\n    workflows: [rewrite-ci]\n${gates}`);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: name });
  const created = (await cell.run({ kind: "task-create", taskId, title: "Contract freeze" }, worker)) as Record<
    string,
    unknown
  >;
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const packagePath = String(created.packagePath);
  await realizeTaskPlanFixture(rootDir, packagePath, (planPath: string) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, worker),
  );
  assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, worker)).outcome, "applied");
  await writeCloseout(cell, rootDir, packagePath, "Frozen delivery.");
  return { rootDir, repoId, taskId, executionId, packagePath, cell };
}

async function writeCloseout(cell: Cell, rootDir: string, packagePath: string, summary: string): Promise<void> {
  await cell.settlePendingMaterialization("closeout git commit");
  writeFileSync(path.join(rootDir, "README.md"), `# ${summary}\n`);
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "test: delivery");
  writeFileSync(
    path.join(rootDir, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary} Commit ${git(rootDir, "rev-parse", "HEAD")}.\n\n` +
      "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable.\n",
  );
}

async function submitOverTransport(cell: Cell, repoId: string, payload: Record<string, unknown>) {
  const server = createJsonRpcProtocolServer({
    host: {
      remoteProxy: { route: () => false },
      run: async (_repoId: string, action: Record<string, unknown>) =>
        cell.run(action as { readonly kind: string }, worker),
    } as never,
    build: { commit: null },
    authContext: {} as never,
    emit: async () => undefined,
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "repo.task.submit",
      params: { repo: { repoId }, payload },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    return (response as { readonly result: Record<string, unknown> }).result;
  } finally {
    server.close();
  }
}

function submittedContracts(rootDir: string, repoId: string): readonly FrozenCompletionContract[] {
  return makeTaskEventReader({ repoId, rootDir })
    .read()
    .events.flatMap((event) =>
      event.schema === "task-event/v1" &&
      event.type === "execution_submitted" &&
      event.payload.execution.submission !== null
        ? [event.payload.execution.submission.completionContract]
        : [],
    );
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("submit freezes the resolved gate contract into the cut; later harness.yaml edits never reach it", async () => {
  const fixture = await submittedTask("contract-freeze", githubCiMapping),
    { rootDir, repoId, taskId, executionId, packagePath, cell } = fixture,
    frozen: FrozenCompletionContract = {
      gates: [
        {
          gateId: "ci",
          appliesTo: "code",
          witness: {
            adapterId: "github-actions",
            adapterOptions: {
              workflows: ["rewrite-ci"],
              branch: "main",
              event: "push",
              coverage: "descendant",
              selection: "newest",
            },
          },
        },
        {
          gateId: "code-doc-reconciliation",
          appliesTo: "code",
          witness: { adapterId: "code-doc-reconciliation", adapterOptions: {} },
        },
      ],
    };
  try {
    const submitted = await submitOverTransport(cell, repoId, { taskId, executionId });
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(submittedContracts(rootDir, repoId), [frozen]);
    const listed = await cell.read("repo.tasks.list");
    assert.deepEqual(validateDaemonTaskSnapshotList(listed), []);

    const edited = await cell.run(
      { kind: "settings-update", ciWorkflows: ["rebuild-gates"], idempotencyKey: "contract-freeze-ci" },
      owner,
    );
    assert.equal(edited.outcome, "applied", JSON.stringify(edited));
    const settings = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly ci: unknown; readonly gates: unknown };
    };
    assert.deepEqual(settings.settings.ci, { workflows: ["rebuild-gates"] });
    assert.deepEqual(settings.settings.gates, [
      {
        gateId: "ci",
        adapter: "github-actions",
        appliesTo: "code",
        branch: "main",
        event: "push",
        coverage: "descendant",
        selection: "newest",
      },
    ]);

    const resumed = await submitOverTransport(cell, repoId, { taskId, executionId });
    assert.notEqual(resumed.outcome, "op_rejected", JSON.stringify(resumed));
    assert.deepEqual(submittedContracts(rootDir, repoId), [frozen]);

    await writeCloseout(cell, rootDir, packagePath, "Amended delivery.");
    const amended = await submitOverTransport(cell, repoId, { taskId, executionId, amend: true });
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.deepEqual(submittedContracts(rootDir, repoId), [frozen, frozen]);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a declared gate without a harness.yaml witness mapping stops submit before any cut is recorded", async () => {
  const { rootDir, repoId, taskId, executionId, cell } = await submittedTask("contract-unmapped", "");
  try {
    const rejected = await submitOverTransport(cell, repoId, { taskId, executionId });
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "gate_mapping_invalid");
    assert.match(String(rejected.rejectionExplanation), /completion gate ci.*settings\.gates maps no witness/u);
    assert.deepEqual(submittedContracts(rootDir, repoId), []);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
