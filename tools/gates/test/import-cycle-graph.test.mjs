// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeRuntimeImportCycles, formatCycleWitness } from "../import-cycle-graph.mjs";

function analyze(sources) {
  const files = Object.keys(sources);
  return analyzeRuntimeImportCycles({
    files,
    readSource: (file) => sources[file],
    resolveImport: (importer, specifier) => {
      if (!specifier.startsWith(".")) return null;
      const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
      return files.includes(candidate) ? candidate : null;
    },
  });
}

test("value imports that point back at each other form one cycle with a witness", () => {
  const { cycles } = analyze({
    "a.ts": 'import { bValue } from "./b.ts";\nexport const aValue = () => bValue();\n',
    "b.ts": 'import { aValue } from "./a.ts";\nexport const bValue = () => aValue();\n',
  });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].files, ["a.ts", "b.ts"]);
  assert.equal(formatCycleWitness(cycles[0].witness), "a.ts -> b.ts -> a.ts");
});

test("type-only imports do not form a runtime cycle", () => {
  const { cycles, edges } = analyze({
    "a.ts": 'import type { B } from "./b.ts";\nexport type A = B;\n',
    "b.ts": 'import type { A } from "./a.ts";\nexport type B = A;\n',
  });
  assert.deepEqual(cycles, []);
  assert.deepEqual(edges, []);
});

test("a value re-export is a runtime edge and closes the cycle", () => {
  const { cycles } = analyze({
    "a.ts": 'export { bValue } from "./b.ts";\nexport const aValue = 1;\n',
    "b.ts": 'import { aValue } from "./a.ts";\nexport const bValue = () => aValue;\n',
  });
  assert.equal(cycles.length, 1);
  assert.match(formatCycleWitness(cycles[0].witness), /^a\.ts -> b\.ts -> a\.ts$/u);
});

test("a type-only re-export does not form a runtime cycle", () => {
  const { cycles } = analyze({
    "a.ts": 'export type { B } from "./b.ts";\nexport type A = string;\n',
    "b.ts": 'import type { A } from "./a.ts";\nexport type B = A;\n',
  });
  assert.deepEqual(cycles, []);
});

test("side-effect and dynamic imports are runtime edges", () => {
  const sideEffect = analyze({
    "a.ts": 'import "./b.ts";\nexport const aValue = 1;\n',
    "b.ts": 'import { aValue } from "./a.ts";\nexport const bValue = () => aValue;\n',
  });
  assert.equal(sideEffect.cycles.length, 1);

  const dynamic = analyze({
    "a.ts": 'export const load = () => import("./b.ts");\n',
    "b.ts": 'import { load } from "./a.ts";\nexport const bValue = () => load;\n',
  });
  assert.equal(dynamic.cycles.length, 1);
});

test("a DAG has no cycles and reports no witness", () => {
  const { cycles } = analyze({
    "a.ts": 'import { bValue } from "./b.ts";\nexport const aValue = () => bValue();\n',
    "b.ts": "export const bValue = () => 1;\n",
  });
  assert.deepEqual(cycles, []);
});
