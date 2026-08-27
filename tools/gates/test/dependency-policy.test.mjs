// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { eventContext, validateDependencyDeclaration, validateLockfile } from "../dependency-policy.mjs";
import { makeRepo } from "./helpers.mjs";

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

test("G31 rejects an empty Dependency-Change before another line", () => {
  const errors = validateDependencyDeclaration(["package.json"], "Dependency-Change:\n## Task And Scope");

  assert.match(errors.join("\n"), /must describe the deterministic dependency change/u);
});

test("G31 skips the declaration for Mergify queue drafts but not human PRs", () => {
  const contextFor = (headRefName, authorLogin) =>
    eventContext({
      pull_request: {
        base: { sha: "base-sha" },
        body: "",
        head: { ref: headRefName },
        user: { login: authorLogin },
      },
    });
  const draft = contextFor("mergify/merge-queue/e00b463e2d", "app/mergify");
  assert.equal(draft.mergifyQueueDraft, true);
  assert.deepEqual(validateDependencyDeclaration(["package.json"], draft.body, draft.declarationRequired), []);

  const human = contextFor("codex/not-a-queue", "FairladyZ625");
  assert.equal(human.mergifyQueueDraft, false);
  assert.match(
    validateDependencyDeclaration(["package.json"], human.body, human.declarationRequired).join("\n"),
    /Dependency-Change/u,
  );
});
