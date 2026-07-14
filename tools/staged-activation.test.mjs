// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probePath = path.join(repoRoot, "tools/probe-production-consumer.mjs");
const runnerPath = path.join(repoRoot, "tools/run-staged-activation.mjs");
const registry = JSON.parse(readFileSync(path.join(repoRoot, "tools/staged-activation.json"), "utf8"));

test("every registered island is currently inactive and its fixture flips the probe to activated", () => {
  assert.equal(registry.islands.length, 4);
  for (const island of registry.islands) {
    const current = runProbe(island, repoRoot);
    assert.equal(current.status, 1, `${island.id}: ${current.stdout}\n${current.stderr}`);

    const root = mkdtempSync(path.join(tmpdir(), `ha-${island.id}-`));
    try {
      writeIslandDefinitions(root, island);
      write(root, "packages/daemon/src/placeholder.ts", "export const placeholder = true;\n");
      const inactive = runProbe(island, root);
      assert.equal(inactive.status, 1, `${island.id}: ${inactive.stdout}\n${inactive.stderr}`);

      writeIslandConsumer(root, island);
      const activated = runProbe(island, root);
      assert.equal(activated.status, 0, `${island.id}: ${activated.stdout}\n${activated.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("runner distinguishes pending, activated, and expired islands", () => {
  const root = makeRunnerFixture();
  try {
    const fixtureRegistry = makeRegistry([
      island("pending", "pending.ts", "Pending"),
      island("activated", "activated.ts", "Activated"),
      { ...island("expired", "expired.ts", "Expired"), expiresAt: "2026-07-13" }
    ]);
    write(root, "tools/staged-activation.json", `${JSON.stringify(fixtureRegistry, null, 2)}\n`);
    const result = runRunner(root, ["--today", "2026-07-13", "--json"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /1 岛未激活 \/ 1 岛已激活（应从登记表移除） \/ 1 岛过期（红） \/ 0 仪器错误/u);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(receipt.counts, { inactive: 1, activated: 1, expired: 1, errors: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner stays non-blocking when every island is inactive and unexpired", () => {
  const root = makeRunnerFixture();
  try {
    write(root, "tools/staged-activation.json", `${JSON.stringify(makeRegistry([
      island("pending", "pending.ts", "Pending")
    ]), null, 2)}\n`);
    const result = runRunner(root, ["--today", "2026-07-13"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 岛未激活/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner fails loud when a probe target disappears", () => {
  const root = makeRunnerFixture();
  try {
    write(root, "tools/staged-activation.json", `${JSON.stringify(makeRegistry([
      island("broken", "missing.ts", "Missing")
    ]), null, 2)}\n`);
    const result = runRunner(root, ["--today", "2026-07-13"]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /0 岛未激活 \/ 0 岛已激活（应从登记表移除） \/ 0 岛过期（红） \/ 1 仪器错误/u);
    assert.match(result.stderr, /definition file does not exist/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects shell-shaped or alternate probe commands", () => {
  const root = makeRunnerFixture();
  try {
    const invalid = makeRegistry([island("invalid", "pending.ts", "Pending")]);
    invalid.islands[0].probe.command = "sh";
    write(root, "tools/staged-activation.json", `${JSON.stringify(invalid, null, 2)}\n`);
    const result = runRunner(root, ["--today", "2026-07-13"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /command must be node/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runProbe(islandEntry, root) {
  return spawnSync(process.execPath, [probePath, ...islandEntry.probe.args.slice(1), "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: islandEntry.probe.timeoutMs
  });
}

function runRunner(root, extraArgs) {
  return spawnSync(process.execPath, [runnerPath, "--root", root, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000
  });
}

function writeIslandDefinitions(root, islandEntry) {
  const byFile = new Map();
  for (const definition of parseDefinitions(islandEntry)) {
    const declarations = byFile.get(definition.file) ?? [];
    declarations.push(definition.importKind === "value"
      ? `export function ${definition.symbol}(): void {}`
      : `export interface ${definition.symbol} { readonly fixture?: true }`);
    byFile.set(definition.file, declarations);
  }
  for (const [file, declarations] of byFile) write(root, file, `${declarations.join("\n")}\n`);
}

function writeIslandConsumer(root, islandEntry) {
  const consumer = `packages/daemon/src/fixture/${islandEntry.id}.ts`;
  const imports = [];
  const uses = [];
  for (const definition of parseDefinitions(islandEntry)) {
    const specifier = relativeImport(path.dirname(consumer), definition.file);
    imports.push(definition.importKind === "value"
      ? `import { ${definition.symbol} } from ${JSON.stringify(specifier)};`
      : `import type { ${definition.symbol} } from ${JSON.stringify(specifier)};`);
    uses.push(definition.importKind === "value"
      ? `${definition.symbol}();`
      : `export type Uses${definition.symbol} = ${definition.symbol};`);
  }
  write(root, consumer, `${imports.join("\n")}\n${uses.join("\n")}\n`);
}

function parseDefinitions(islandEntry) {
  const definitions = [];
  for (let index = 0; index < islandEntry.probe.args.length; index += 1) {
    if (islandEntry.probe.args[index] !== "--definition") continue;
    const encoded = islandEntry.probe.args[index + 1];
    const kindSeparator = encoded.indexOf(":");
    const symbolSeparator = encoded.lastIndexOf("#");
    definitions.push({
      importKind: encoded.slice(0, kindSeparator),
      file: encoded.slice(kindSeparator + 1, symbolSeparator),
      symbol: encoded.slice(symbolSeparator + 1)
    });
  }
  return definitions;
}

function relativeImport(fromDirectory, target) {
  let relative = path.posix.relative(fromDirectory, target);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function makeRunnerFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-staged-runner-"));
  write(root, "packages/application/src/pending.ts", "export interface Pending {}\n");
  write(root, "packages/application/src/activated.ts", "export interface Activated {}\n");
  write(root, "packages/application/src/expired.ts", "export interface Expired {}\n");
  write(
    root,
    "packages/daemon/src/consumer.ts",
    'import type { Activated } from "../../application/src/activated.ts";\nexport type Active = Activated;\n'
  );
  return root;
}

function makeRegistry(islands) {
  return {
    schema: "harness-anything/staged-activation/v1",
    schemaDocumentation: "tools/staged-activation.schema.md",
    islands
  };
}

function island(id, file, symbol) {
  return {
    id,
    description: `${symbol} fixture`,
    probe: {
      command: "node",
      args: [
        "tools/probe-production-consumer.mjs",
        "--definition",
        `any:packages/application/src/${file}#${symbol}`,
        "--consumer-root",
        "packages/daemon/src",
        "--match",
        "all"
      ],
      timeoutMs: 10000
    },
    anchor: "task_01KXDT1CVHBZ5YD619PRJWWZMQ",
    registeredAt: "2026-07-13"
  };
}

function write(root, relativePath, body) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}
