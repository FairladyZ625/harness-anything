// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPath = path.join(root, "packages/api-contracts/src/daemon-registry.ts");
const kernelPath = path.join(root, "packages/kernel/src/daemon/registry.ts");

test("api-contracts and kernel daemon registry DTOs remain mutually assignable", () => {
  const program = ts.createProgram({
    rootNames: [apiPath, kernelPath],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true
    }
  });
  const checker = program.getTypeChecker();
  const apiType = exportedType(checker, program.getSourceFile(apiPath), "DaemonRegistryRepo");
  const kernelType = exportedType(checker, program.getSourceFile(kernelPath), "DaemonRegistryRepo");
  assert.equal(checker.isTypeAssignableTo(apiType, kernelType), true, "api-contracts DTO drifted from kernel DTO");
  assert.equal(checker.isTypeAssignableTo(kernelType, apiType), true, "kernel DTO drifted from api-contracts DTO");
});

function exportedType(checker, sourceFile, name) {
  assert.ok(sourceFile, `missing source file for ${name}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert.ok(moduleSymbol, `missing module symbol for ${sourceFile.fileName}`);
  const symbol = checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === name);
  assert.ok(symbol, `${sourceFile.fileName} must export ${name}`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}
