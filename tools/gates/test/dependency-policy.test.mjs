// harness-test-tier: contract
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  hasDependencyChange,
  main,
  readDependencyDeclarations,
  replaceDependencyDeclaration,
  validateDependencyDeclaration,
  validateLockfile,
} from "../dependency-policy.mjs";
import { captureGate, commitAll, makeRepo, writeRepoFile } from "./helpers.mjs";

test("G31 accepts a lockfile consistent with root and workspace manifests", () => {
  const rootPackage = { name: "root", version: "1.0.0", dependencies: { effect: "1.0.0" } };
  const childPackage = { name: "child", version: "1.0.0", devDependencies: { typescript: "5.0.0" } };
  const lock = {
    name: "root",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", version: "1.0.0", dependencies: rootPackage.dependencies },
      "packages/child": { name: "child", version: "1.0.0", devDependencies: childPackage.devDependencies },
    },
  };
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify(rootPackage),
    "packages/child/package.json": JSON.stringify(childPackage),
    "package-lock.json": JSON.stringify(lock),
  });
  assert.deepEqual(validateLockfile(rootDir), []);
});

test("G31 rejects lock drift and undeclared dependency changes", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ dependencies: { effect: "2.0.0" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { effect: "1.0.0" } } },
    }),
  });
  assert.match(validateLockfile(rootDir).join("\n"), /effect.*2\.0\.0.*1\.0\.0/u);
  assert.match(
    validateDependencyDeclaration(["package-lock.json"], "No declaration.").join("\n"),
    /Dependency-Change/u,
  );
  assert.deepEqual(validateDependencyDeclaration(["package.json"], "Dependency-Change: pin effect to 2.0.0"), []);
  assert.deepEqual(validateDependencyDeclaration(["package.json"], "", false), []);
});

test("G31 identifies the dependency surface from changed paths", () => {
  for (const filePath of ["package.json", "package-lock.json", "packages/authorization-gui/package.json"])
    assert.equal(hasDependencyChange([filePath]), true, filePath);
  for (const filePath of ["packages/authorization-gui/src/index.ts", "docs/package.json.md", "package.json.bak"])
    assert.equal(hasDependencyChange([filePath]), false, filePath);
});

test("G31 exposes the declaration line format the renderer writes", () => {
  const body = "Dependency-Change: none\n\n<!-- keep -->\n";

  assert.deepEqual(readDependencyDeclarations(body), ["none"]);
  assert.equal(
    replaceDependencyDeclaration(body, "bump effect to 2.0.0"),
    "Dependency-Change: bump effect to 2.0.0\n\n<!-- keep -->\n",
  );
  assert.equal(
    replaceDependencyDeclaration("Dependency-Change: none\r\n", "bump effect"),
    "Dependency-Change: bump effect\r\n",
  );
  assert.deepEqual(
    validateDependencyDeclaration(["package.json"], replaceDependencyDeclaration(body, "bump effect")),
    [],
  );
});

test("G31 rejects an empty Dependency-Change before another line", () => {
  const errors = validateDependencyDeclaration(["package.json"], "Dependency-Change:\n## Task And Scope");

  assert.match(errors.join("\n"), /must describe the deterministic dependency change/u);
});

test("G31 main judges the declaration against the supplied body file", () => {
  const { rootDir, base } = makeRepo({
    "package.json": JSON.stringify({ dependencies: { effect: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { effect: "1.0.0" } } },
    }),
  });
  writeRepoFile(rootDir, "package.json", JSON.stringify({ dependencies: { effect: "2.0.0" } }));
  writeRepoFile(
    rootDir,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { effect: "2.0.0" } } } }),
  );
  commitAll(rootDir);
  const bodyFile = path.join(rootDir, "pr-body.md");
  const previous = process.cwd();
  process.chdir(rootDir);
  try {
    writeFileSync(bodyFile, "No declaration.");
    assert.equal(captureGate(() => main(["--base", base, "--pr-body-file", bodyFile])).code, 1);
    writeFileSync(bodyFile, "Dependency-Change: bump effect to 2.0.0");
    assert.equal(captureGate(() => main(["--base", base, "--pr-body-file", bodyFile])).code, 0);
    // Without a body source the gate is lockfile-only, so a declaration is never required.
    assert.equal(captureGate(() => main([])).code, 0);
  } finally {
    process.chdir(previous);
  }
});

test("G31 main reads the declaration from the named environment variable", () => {
  const { rootDir, base } = makeRepo({
    "package.json": JSON.stringify({ dependencies: { effect: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { effect: "1.0.0" } } },
    }),
  });
  writeRepoFile(rootDir, "package.json", JSON.stringify({ dependencies: { effect: "2.0.0" } }));
  writeRepoFile(
    rootDir,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { effect: "2.0.0" } } } }),
  );
  commitAll(rootDir);
  const previous = process.cwd();
  process.chdir(rootDir);
  try {
    process.env.PR_BODY = "Dependency-Change: none";
    assert.equal(captureGate(() => main(["--base", base, "--pr-body-env", "PR_BODY"])).code, 1);
    process.env.PR_BODY = "Dependency-Change: bump effect to 2.0.0";
    assert.equal(captureGate(() => main(["--base", base, "--pr-body-env", "PR_BODY"])).code, 0);
  } finally {
    delete process.env.PR_BODY;
    process.chdir(previous);
  }
});
