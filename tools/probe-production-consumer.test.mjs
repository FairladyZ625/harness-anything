// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { probeProductionConsumers } from "./probe-production-consumer.mjs";

test("production consumer probe resolves named imports through a barrel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-probe-"));
  try {
    write(root, "packages/application/src/service.ts", "export function createService(): void {}\n");
    write(root, "packages/application/src/index.ts", 'export { createService } from "./service.ts";\n');

    const options = {
      root,
      definitions: ["value:packages/application/src/service.ts#createService"],
      consumerRoots: ["packages/daemon/src"],
      excludes: [],
      match: "all",
      sameConsumer: false
    };
    write(root, "packages/daemon/src/placeholder.ts", "export const placeholder = true;\n");
    assert.equal(probeProductionConsumers(options).activated, false);

    write(
      root,
      "packages/daemon/src/composition.ts",
      'import { createService } from "../../application/src/index.ts";\ncreateService();\n'
    );
    const activated = probeProductionConsumers(options);
    assert.equal(activated.activated, true);
    assert.deepEqual(activated.consumers.map((consumer) => consumer.file), ["packages/daemon/src/composition.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production consumer probe requires all symbols in the same composition file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-probe-"));
  try {
    write(root, "packages/application/src/service.ts", "export function createService(): void {}\n");
    write(root, "packages/daemon/src/server.ts", "export function serve(): void {}\n");
    write(root, "packages/daemon/src/one.ts", 'import { serve } from "./server.ts";\nserve();\n');
    write(
      root,
      "packages/daemon/src/two.ts",
      'import { createService } from "../../application/src/service.ts";\ncreateService();\n'
    );
    const result = probeProductionConsumers({
      root,
      definitions: [
        "value:packages/application/src/service.ts#createService",
        "value:packages/daemon/src/server.ts#serve"
      ],
      consumerRoots: ["packages/daemon/src"],
      excludes: [],
      match: "all",
      sameConsumer: true
    });
    assert.equal(result.activated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production consumer probe treats a missing target export as an instrument error", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-probe-"));
  try {
    write(root, "packages/application/src/service.ts", "export const renamed = true;\n");
    write(root, "packages/daemon/src/placeholder.ts", "export const placeholder = true;\n");
    assert.throws(() => probeProductionConsumers({
      root,
      definitions: ["value:packages/application/src/service.ts#createService"],
      consumerRoots: ["packages/daemon/src"],
      excludes: [],
      match: "all",
      sameConsumer: false
    }), /definition export not found/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(root, relativePath, body) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}
