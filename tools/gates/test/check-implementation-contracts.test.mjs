// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasContractEvidence,
  eventStoreEvidence,
  missingEventStoreEvidence,
} from "../../implementation-contract-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

test("contract markers require an exact ID beside a test declaration", () => {
  assert.equal(hasContractEvidence('// harness-contract: sample.id\ntest("any title", () => {});', "sample.id"), true);
  for (const source of [
    'test("sample.id", () => {});',
    '// harness-contract: sample.id.extra\ntest("title", () => {});',
    '// harness-contract: sample.id\nconst unrelated = true;\ntest("title", () => {});',
  ])
    assert.equal(hasContractEvidence(source, "sample.id"), false);
  assert.deepEqual(missingEventStoreEvidence(eventStoreEvidence.join("\n"), ""), []);
  for (const point of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit"])
    assert.deepEqual(missingEventStoreEvidence(eventStoreEvidence.filter((value) => value !== point).join("\n"), ""), [
      point,
    ]);
});

test("implementation contracts remain on the required boundaries path", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"));
  const gate = manifest.gates.find((entry) => entry.id === "check-implementation-contracts");
  assert.equal(gate.tier, "pr-required");
  assert.ok(gate.githubContext.requiredContexts.includes("boundaries"));
  assert.ok(gate.githubContext.workflowJobs.includes("boundaries"));
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["harness:check-implementation-contracts"], "node tools/check-implementation-contracts.mjs");
  assert.match(
    readFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), "utf8"),
    /node tools\/run-manifest-gates\.mjs --workflow-job boundaries/,
  );
});

test("renderer rule blocks credential token shapes and private paths but passes token usage telemetry", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "implementation-contract-renderer-"));
  try {
    const files = globSync(["packages/**/*", "package.json", "package-lock.json", "tsconfig.json"], {
      cwd: root,
      withFileTypes: true,
      exclude: ["**/node_modules/**", "**/dist/**"],
    })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    for (const file of files) {
      const destination = path.join(fixture, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, file), destination);
    }
    const runGate = () =>
      spawnSync(process.execPath, [path.join(root, "tools/check-implementation-contracts.mjs")], {
        cwd: fixture,
        encoding: "utf8",
      });
    const rendererDir = path.join(fixture, "packages/gui/src/renderer");
    const writeRenderer = (name, body) => writeFileSync(path.join(rendererDir, name), body);

    // LLM usage telemetry (the squad-run token board shapes) is display data, not credential
    // access: tokenUsage fields, totalTokens/exactTokens helpers, TokenBoard copy must all pass.
    writeRenderer(
      "TokenTelemetry.tsx",
      [
        'import { totalTokens, exactTokens, compactTokens } from "./metrics.ts";',
        "export function TokenBoard({ turns, attempts }) {",
        "  const tokenScale = Math.max(0, ...turns.map(totalTokens), ...attempts.map(totalTokens));",
        "  const input = turns.reduce((sum, turn) => sum + turn.tokenUsage.input, 0);",
        "  const output = attempts.reduce((sum, m) => sum + m.tokenUsage.output, 0);",
        "  return (",
        '    <p data-testid="squad-run-token-board-total">',
        "      Token overhead · {compactTokens(input)} / {exactTokens(output)} · scale {tokenScale}",
        "    </p>",
        "  );",
        "}",
      ].join("\n"),
    );
    const telemetry = runGate();
    assert.equal(telemetry.status, 0, telemetry.stderr);

    // Each credential shape gets its own file so one violation message per file proves the
    // pattern fires on that shape specifically, not just on the union of all of them.
    const credentialShapes = {
      "AccessTokenShape.tsx": "export const accessToken = session.accessToken;\n",
      "EnvAuthTokenShape.tsx": 'export const authHeader = process.env.AUTH_TOKEN ?? "";\n',
      "SessionTokenShape.tsx": "export const header = `X-Session-Token: ${sessionToken}`;\n",
      "SessionTokensShape.tsx": "export const sessionTokens: readonly string[] = [];\n",
      "RefreshTokenShape.tsx": "export const refreshToken = rotate(currentRefreshToken);\n",
      "ApiTokenShape.tsx": "export const apiToken = provider.api_token;\n",
      "ClientTokenShape.tsx": "export const clientToken = oauth.client_token;\n",
      "OperatorTokenShape.tsx": "export const operatorToken = daemon.operator_token;\n",
      "BearerHeaderShape.tsx": "export const header = `Authorization: Bearer ${opaqueValue}`;\n",
      "HarnessPrivateShape.tsx": 'export const reviewPath = ".harness-private/review.md";\n',
      "RawProjectPathsShape.tsx": "// raw project paths from the daemon stay in the main process.\n",
    };
    for (const [name, body] of Object.entries(credentialShapes)) writeRenderer(name, body);
    const blocked = runGate();
    assert.equal(blocked.status, 1, blocked.stdout);
    for (const name of Object.keys(credentialShapes)) {
      assert.ok(
        blocked.stderr.includes(
          `packages/gui/src/renderer/${name}: renderer must not directly access private paths, credentials, or raw project paths`,
        ),
        `expected renderer rule to flag ${name}\n${blocked.stderr}`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("daemon status-branch rule judges by protocol handler landing site, not comparison syntax", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "implementation-contract-status-"));
  try {
    const files = globSync(["packages/**/*", "package.json", "package-lock.json", "tsconfig.json"], {
      cwd: root,
      withFileTypes: true,
      exclude: ["**/node_modules/**", "**/dist/**"],
    })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    for (const file of files) {
      const destination = path.join(fixture, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, file), destination);
    }
    const runGate = () =>
      spawnSync(process.execPath, [path.join(root, "tools/check-implementation-contracts.mjs")], {
        cwd: fixture,
        encoding: "utf8",
      });
    const readModelProbe = path.join(fixture, "packages/daemon/src/probe-read-model.ts");
    const handlerProbe = path.join(fixture, "packages/daemon/src/protocol/probe-handler.ts");
    const wireProbe = path.join(fixture, "packages/daemon/src/protocol/probe-wire-validate.ts");

    // Below the protocol surface, status classification is the file's own business logic:
    // a direct comparison and the synonymous membership spelling must be treated alike.
    writeFileSync(
      readModelProbe,
      'export const settled = (row) => {\n  if (row.status === "succeeded") return true;\n  return false;\n};\n',
    );
    assert.equal(runGate().status, 0, "direct status comparison in a non-handler file must pass");
    writeFileSync(
      readModelProbe,
      'export const settled = (row) => {\n  if (["succeeded"].includes(row.status)) return true;\n  return false;\n};\n',
    );
    assert.equal(runGate().status, 0, "synonymous membership spelling in a non-handler file must pass");

    // Wire declaration modules inside protocol/ compare status fields for schema
    // validation — the transport-error mapping the contract permits handlers to do.
    writeFileSync(
      wireProbe,
      'export const check = (value) => {\n  if (value.status === "accepted_durable") return [];\n  return ["bad"];\n};\n',
    );
    assert.equal(runGate().status, 0, "schema validation in a wire declaration module must pass");

    // Inside the JSON-RPC handler surface, branching behavior on a status value is the
    // business-state inference the contract forbids.
    writeFileSync(
      handlerProbe,
      'export const settle = (row) => {\n  if (row.status === "succeeded") return "done";\n  return "wait";\n};\n',
    );
    const branch = runGate();
    assert.equal(branch.status, 1, branch.stdout);
    assert.match(
      branch.stderr,
      /packages\/daemon\/src\/protocol\/probe-handler\.ts: daemon protocol handlers must not infer business state from status values/,
    );
    writeFileSync(
      handlerProbe,
      'export const settle = (row) => {\n  switch (row.status) {\n    case "succeeded":\n      return "done";\n  }\n  return "wait";\n};\n',
    );
    const switchBranch = runGate();
    assert.equal(switchBranch.status, 1, switchBranch.stdout);
    assert.match(switchBranch.stderr, /probe-handler\.ts: daemon protocol handlers must not infer business state/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("real implementation gate accepts renamed titles and rejects each missing or misplaced contract marker", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "implementation-contract-"));
  try {
    const files = globSync(["packages/**/*", "package.json", "package-lock.json", "tsconfig.json"], {
      cwd: root,
      withFileTypes: true,
      exclude: ["**/node_modules/**", "**/dist/**"],
    })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    const anchors = [];
    for (const file of files) {
      const destination = path.join(fixture, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, file), destination);
      if (!file.endsWith(".test.ts")) continue;
      const source = readFileSync(destination, "utf8");
      for (const match of source.matchAll(/^[ \t]*\/\/ harness-contract: ([a-z0-9.-]+)$/gm))
        anchors.push({ file, marker: match[0], id: match[1] });
    }
    assert.equal(anchors.length, 15);
    const run = () =>
      spawnSync(process.execPath, [path.join(root, "tools/check-implementation-contracts.mjs")], {
        cwd: fixture,
        encoding: "utf8",
      });
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stderr);
    let renamedCount = 0;
    for (const file of new Set(anchors.map((anchor) => anchor.file))) {
      const destination = path.join(fixture, file);
      writeFileSync(
        destination,
        readFileSync(destination, "utf8").replace(
          /(\/\/ harness-contract: [a-z0-9.-]+\r?\n\s*test\(\s*)(?:"[^"\n]*"|`[^`\n]*`)/g,
          (_title, declaration) => {
            renamedCount += 1;
            return `${declaration}"freely edited human title"`;
          },
        ),
      );
    }
    assert.equal(renamedCount, 15);
    const renamed = run();
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.equal(renamed.stdout, baseline.stdout);
    for (const { file, marker, id } of anchors) {
      const destination = path.join(fixture, file);
      const source = readFileSync(destination, "utf8");
      writeFileSync(destination, source.replace(marker, ""));
      // The ID still exists beside a test in another file: file identity must matter.
      writeFileSync(path.join(fixture, "packages/misplaced.test.ts"), `${marker}\ntest("moved", () => {});\n`);
      const missing = run();
      assert.equal(missing.status, 1, missing.stdout);
      assert.match(missing.stderr, new RegExp(`missing test contract marker ${id.replaceAll(".", "\\.")}`));
      writeFileSync(destination, source);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
