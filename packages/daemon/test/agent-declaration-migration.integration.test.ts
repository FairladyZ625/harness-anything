// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAgentDeclarationV1 } from "@harness-anything/kernel";
import { migrateAgentDeclarations } from "../src/agent-declaration-migration.ts";
import { install, run } from "./agent-entities.fixtures.ts";

const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));

const legacyDevin = {
    schema: "agent-declaration/v1",
    id: "de-ml",
    name: "AI4S 蛋白 ML 工程师",
    instructions: "迁移前的旧格式声明。",
    runtime_type: "devin",
    model: "swe2",
  },
  legacyZcode = {
    schema: "agent-declaration/v1",
    id: "legacy-zcode",
    name: "Legacy Zcode",
    instructions: "旧格式，无顶层 model。",
    runtime_type: "zcode",
    permissionMode: "workspace-write",
    role: "worker",
  },
  currentAgent = {
    schema: "agent-declaration/v1",
    id: "current",
    name: "Current",
    instructions: "Already on runtimes.",
    runtimes: [{ type: "zcode", model: "GLM-5.3" }],
  };

function writeJson(root: string, name: string, value: unknown): string {
  writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  return path.join(root, name);
}

function userRootWithInstances(root: string, instances: readonly unknown[]): string {
  writeFileSync(
    path.join(root, "runtime-instances.json"),
    JSON.stringify({ schema: "runtime-instances/v1", instances }),
  );
  return root;
}

function cliMigrate(
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; receipt: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [cli, "migrate", "agent-declaration", ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.ok(result.stdout.trim(), result.stderr);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
  };
}

test("legacy runtime_type and model declarations convert to runtimes, schema-valid, source untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-decl-migration-")),
    source = path.join(root, "agents"),
    destination = path.join(root, "converted"),
    userRoot = userRootWithInstances(mkdirSync(path.join(root, "user"), { recursive: true }), [
      { instanceId: "zcode-main", kindId: "zcode", models: ["GLM-5.3"], enabled: true },
    ]);
  try {
    mkdirSync(source);
    writeJson(source, "de-ml.json", legacyDevin);
    writeJson(source, "legacy-zcode.json", legacyZcode);
    const currentBytes = readFileSync(writeJson(source, "current.json", currentAgent), "utf8");
    const before = readFileSync(path.join(source, "de-ml.json"), "utf8");

    const preview = migrateAgentDeclarations({ source, dryRun: true, userRoot });
    assert.equal(preview.ok, true);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(
      preview.entries.map(({ file, outcome }) => ({ file, outcome })),
      [
        { file: "current.json", outcome: "current" },
        { file: "de-ml.json", outcome: "converted" },
        { file: "legacy-zcode.json", outcome: "converted" },
      ],
    );

    const converted = migrateAgentDeclarations({ source, destination, dryRun: false, userRoot });
    assert.equal(converted.ok, true);
    assert.equal(readFileSync(path.join(source, "de-ml.json"), "utf8"), before);
    const devin = JSON.parse(readFileSync(path.join(destination, "de-ml.json"), "utf8"));
    assert.deepEqual(devin.runtimes, [{ type: "devin", model: "swe2" }]);
    assert.equal(Object.hasOwn(devin, "runtime_type"), false);
    assert.equal(Object.hasOwn(devin, "model"), false);
    assert.equal(devin.permissionMode, undefined);
    const zcode = JSON.parse(readFileSync(path.join(destination, "legacy-zcode.json"), "utf8"));
    assert.deepEqual(zcode.runtimes, [{ type: "zcode" }]);
    assert.equal(zcode.permissionMode, "workspace-write");
    assert.equal(zcode.role, "worker");
    for (const name of ["de-ml.json", "legacy-zcode.json", "current.json"]) {
      const value = JSON.parse(readFileSync(path.join(destination, name), "utf8"));
      assert.deepEqual(validateAgentDeclarationV1(value), [], `${name}: ${JSON.stringify(value)}`);
    }
    assert.equal(readFileSync(path.join(destination, "current.json"), "utf8"), currentBytes);

    const rerun = migrateAgentDeclarations({ source: destination, dryRun: true, userRoot });
    assert.equal(rerun.converted, 0);
    assert.equal(rerun.current, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable runtime kinds surface the install-time issue without failing conversion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-decl-unavailable-")),
    source = path.join(root, "agents"),
    destination = path.join(root, "converted"),
    userRoot = userRootWithInstances(mkdirSync(path.join(root, "user"), { recursive: true }), [
      { instanceId: "zcode-main", kindId: "zcode", models: ["GLM-5.3"], enabled: true },
      { instanceId: "devin-old", kindId: "devin", models: ["swe2"], enabled: false },
    ]);
  try {
    mkdirSync(source);
    writeJson(source, "de-ml.json", legacyDevin);
    writeJson(source, "de-zcode.json", {
      schema: "agent-declaration/v1",
      id: "de-zcode",
      name: "Zcode Worker",
      instructions: "模型本机未提供。",
      runtime_type: "zcode",
      model: "GLM-5.9-unheard",
    });
    writeJson(source, "de-zcode-ok.json", {
      schema: "agent-declaration/v1",
      id: "de-zcode-ok",
      name: "Zcode OK",
      instructions: "模型本机已提供。",
      runtime_type: "zcode",
      model: "GLM-5.3",
    });

    const converted = migrateAgentDeclarations({ source, destination, dryRun: false, userRoot });
    assert.equal(converted.ok, true);
    assert.equal(converted.runtimeAvailability, "checked");
    assert.deepEqual(
      converted.runtimeIssues.map(({ id, code }) => ({ id, code })),
      [
        { id: "de-ml", code: "agent_runtime_type_unavailable" },
        { id: "de-zcode", code: "agent_model_unavailable" },
      ],
    );
    for (const issue of converted.runtimeIssues) assert.match(issue.message, /ha runtime instance list/u);
    assert.equal(existsSync(path.join(destination, "de-ml.json")), true);

    const unknown = migrateAgentDeclarations({
      source,
      dryRun: true,
      userRoot: path.join(root, "no-instances-here"),
    });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.runtimeAvailability, "unknown");
    assert.deepEqual(unknown.runtimeIssues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unconvertible files are rejected per file without aborting the batch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-decl-rejected-")),
    source = path.join(root, "agents"),
    destination = path.join(root, "converted"),
    userRoot = userRootWithInstances(mkdirSync(path.join(root, "user"), { recursive: true }), [
      { instanceId: "zcode-main", kindId: "zcode", models: ["GLM-5.3"], enabled: true },
    ]);
  try {
    mkdirSync(source);
    writeJson(source, "good.json", legacyZcode);
    writeJson(source, "fallback.json", {
      schema: "agent-declaration/v1",
      id: "with-fallback",
      name: "With Fallback",
      instructions: "退役字段必须显式处置。",
      runtime_type: "zcode",
      fallback: { providerPriority: ["codex"], backoff: { baseMs: 100, maxMs: 1000 } },
    });
    writeJson(source, "ambiguous.json", {
      schema: "agent-declaration/v1",
      id: "ambiguous",
      name: "Ambiguous",
      instructions: "两种形状同时出现。",
      runtime_type: "zcode",
      runtimes: [{ type: "zcode" }],
    });
    writeJson(source, "orphan-model.json", {
      schema: "agent-declaration/v1",
      id: "orphan-model",
      name: "Orphan Model",
      instructions: "有 model 无 runtime_type。",
      model: "GLM-5.3",
    });
    writeJson(source, "squad.json", {
      schema: "squad-declaration/v1",
      id: "core-squad",
      name: "Core Squad",
      leader: "good",
      workers: ["good"],
      leaderTurnBudget: 8,
      roster: "# roster",
    });
    writeFileSync(path.join(source, "garbage.json"), "{ not json");

    const converted = migrateAgentDeclarations({ source, destination, dryRun: false, userRoot });
    assert.equal(converted.ok, false);
    assert.equal(converted.converted, 1);
    assert.equal(converted.rejected, 5);
    const rejected = Object.fromEntries(
      converted.entries.filter(({ outcome }) => outcome === "rejected").map(({ file, issues }) => [file, issues]),
    );
    assert.match(rejected["fallback.json"]!.join("\n"), /fallback/u);
    assert.match(rejected["ambiguous.json"]!.join("\n"), /runtimes/u);
    assert.match(rejected["orphan-model.json"]!.join("\n"), /runtime_type/u);
    assert.match(rejected["squad.json"]!.join("\n"), /agent-declaration\/v1/u);
    assert.match(rejected["garbage.json"]!.join("\n"), /not valid JSON/u);
    assert.equal(existsSync(path.join(destination, "good.json")), true);
    assert.equal(existsSync(path.join(destination, "fallback.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("converted declarations validate, install, and list as valid through the production path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-decl-e2e-")),
    source = path.join(root, "agents"),
    destination = path.join(root, "converted"),
    userRoot = userRootWithInstances(mkdirSync(path.join(root, "user"), { recursive: true }), [
      { instanceId: "zcode-main", kindId: "zcode", models: ["GLM-5.3"], enabled: true },
    ]),
    instances = [{ instanceId: "zcode-main", kindId: "zcode", models: ["GLM-5.3"], enabled: true }];
  try {
    mkdirSync(source);
    writeJson(source, "de-ml.json", legacyDevin);
    writeJson(source, "legacy-zcode.json", legacyZcode);
    migrateAgentDeclarations({ source, destination, dryRun: false, userRoot });

    const packageDir = path.join(root, "package");
    mkdirSync(packageDir);
    writeFileSync(
      path.join(packageDir, "agent.json"),
      readFileSync(path.join(destination, "legacy-zcode.json"), "utf8"),
    );
    assert.equal(
      (
        run({ rootDir: root, kind: "agent-validate", packageSource: packageDir, runtimeInstances: instances }) as {
          valid: boolean;
        }
      ).valid,
      true,
    );
    await install({ rootDir: root, kind: "agent-install", packageSource: packageDir, runtimeInstances: instances });
    assert.deepEqual(
      (
        run({ rootDir: root, kind: "agent-list", runtimeInstances: instances }) as {
          agents: Array<{ id: string; runtimes: readonly { type: string }[] }>;
        }
      ).agents.map(({ id, runtimes }) => ({ id, runtimes })),
      [{ id: "legacy-zcode", runtimes: [{ type: "zcode" }] }],
    );

    const devinPackage = path.join(root, "devin-package");
    mkdirSync(devinPackage);
    writeFileSync(path.join(devinPackage, "agent.json"), readFileSync(path.join(destination, "de-ml.json"), "utf8"));
    const devinReport = run({
      rootDir: root,
      kind: "agent-validate",
      packageSource: devinPackage,
      runtimeInstances: instances,
    }) as { valid: boolean; issues: readonly { code: string }[] };
    assert.equal(devinReport.valid, false);
    assert.equal(devinReport.issues[0]?.code, "agent_runtime_type_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI routes migrate agent-declaration through the offline daemon bin", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-decl-cli-")),
    userRoot = mkdirSync(path.join(root, "user"), { recursive: true });
  try {
    const file = writeJson(root, "de-ml.json", legacyDevin);
    const preview = cliMigrate(["--source", file, "--mode", "dry-run"], { HARNESS_DAEMON_USER_ROOT: userRoot });
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.receipt.schema, "agent-declaration-migration-receipt/v1");
    assert.equal(preview.receipt.kind, "declaration");
    assert.equal(preview.receipt.ok, true);

    const destination = path.join(root, "converted.json");
    const converted = cliMigrate(["--source", file, "--mode", "convert", "--destination", destination], {
      HARNESS_DAEMON_USER_ROOT: userRoot,
    });
    assert.equal(converted.status, 0, converted.stderr);
    assert.deepEqual((JSON.parse(readFileSync(destination, "utf8")) as { runtimes: unknown }).runtimes, [
      { type: "devin", model: "swe2" },
    ]);
    assert.match(String(converted.receipt.next), /ha agent install/u);

    const missingDestination = cliMigrate(["--source", file, "--mode", "convert"], {
      HARNESS_DAEMON_USER_ROOT: userRoot,
    });
    assert.equal(missingDestination.status, 1);
    assert.match(String(missingDestination.receipt.hint), /--destination/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
