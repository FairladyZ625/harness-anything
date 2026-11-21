// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReproducibleBundle,
  computeDirectoryManifest,
  createDeterministicTarGz,
  verifyBuildManifest,
  verifyReproducibleBuild,
} from "./reproducible-build.mjs";

function createFixtureGitRepo({ nondeterministic = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-repro-repo-"));
  mkdirSync(path.join(dir, "packages/sample/src"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "repro-fixture",
        version: "0.1.0",
        private: true,
        type: "module",
        workspaces: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "repro-fixture",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: { "": { name: "repro-fixture", version: "0.1.0" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(dir, "packages/sample/package.json"),
    `${JSON.stringify(
      {
        name: "@repro/sample",
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "node build.mjs",
        },
        exports: {
          ".": "./src/index.js",
        },
        publishConfig: {
          exports: {
            ".": "./dist/index.js",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, "packages/sample/src/index.js"), 'export const greeting = "hello-deterministic";\n');
  writeFileSync(
    path.join(dir, "packages/sample/build.mjs"),
    nondeterministic
      ? [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'writeFileSync("dist/index.js", `export const nonce = ${Math.random()}:${Date.now()}:${process.cwd()};\\n`);',
        ].join("\n")
      : [
          'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'const src = readFileSync("src/index.js", "utf8");',
          'const epoch = process.env.SOURCE_DATE_EPOCH ?? "0";',
          'writeFileSync("dist/index.js", `// epoch=${epoch}\\n${src}`);',
        ].join("\n"),
  );

  const git = (args) => {
    const res = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
        GIT_AUTHOR_DATE: "2026-11-21T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-21T00:00:00Z",
      },
    });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout.trim();
  };

  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  return { dir, commit };
}

test("verifyReproducibleBuild confirms two independent offline builds produce bit-for-bit identical digests and tar.gz", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: false });
  try {
    const result = await verifyReproducibleBuild({
      repository: dir,
      revision: commit,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
      createArchive: true,
    });
    assert.equal(result.ok, true, `expected reproducible build to pass: ${JSON.stringify(result.differences)}`);
    assert.equal(result.commit, commit);
    assert.equal(result.differences.length, 0);
    assert.match(result.artifactDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.builds[0].artifactDigest, result.builds[1].artifactDigest);
    assert.match(result.archiveSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.builds[0].archiveSha256, result.builds[1].archiveSha256);
    assert.ok(result.fileCount >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("verifyBuildManifest detects byte tampering, deleted files, and extra injected files", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: false });
  const outDir = mkdtempSync(path.join(tmpdir(), "ha-repro-out-"));
  try {
    const built = await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      outputDir: outDir,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    const manifestPath = path.join(outDir, "build-manifest.json");
    assert.equal(verifyBuildManifest({ bundleDir: outDir, manifestPath }).ok, true);

    // Extra unexpected file rejected
    const extraPath = path.join(outDir, "packages/sample/dist/injected.js");
    writeFileSync(extraPath, "injected\n");
    const extraCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(extraCheck.ok, false);
    assert.ok(extraCheck.errors.some((entry) => entry.includes("injected.js")));
    unlinkSync(extraPath);

    // Single-byte tamper rejected
    const target = path.join(outDir, "packages/sample/dist/index.js");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original} `);
    const tamperCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(tamperCheck.ok, false);
    assert.ok(tamperCheck.errors.some((entry) => entry.includes("packages/sample/dist/index.js")));
    writeFileSync(target, original);

    // Missing file rejected
    unlinkSync(target);
    const missingCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(missingCheck.ok, false);
    assert.ok(missingCheck.errors.some((entry) => entry.includes("missing")));

    // Confirm built digest matches computeDirectoryManifest when clean
    writeFileSync(target, original);
    const recomputed = computeDirectoryManifest(outDir, { ignoreFiles: ["build-manifest.json"] });
    assert.equal(recomputed.artifactDigest, built.manifest.artifactDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("verifyReproducibleBuild fails closed when build output is non-deterministic", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: true });
  try {
    const result = await verifyReproducibleBuild({
      repository: dir,
      revision: commit,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    assert.equal(result.ok, false);
    assert.ok(result.differences.some((entry) => entry.path === "packages/sample/dist/index.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("createDeterministicTarGz emits bit-for-bit identical gzipped tar regardless of mtime or creation order", () => {
  const dirA = mkdtempSync(path.join(tmpdir(), "ha-tar-a-"));
  const dirB = mkdtempSync(path.join(tmpdir(), "ha-tar-b-"));
  try {
    mkdirSync(path.join(dirA, "sub"), { recursive: true });
    writeFileSync(path.join(dirA, "b.txt"), "beta\n");
    writeFileSync(path.join(dirA, "a.txt"), "alpha\n");
    writeFileSync(path.join(dirA, "sub/c.txt"), "gamma\n");

    mkdirSync(path.join(dirB, "sub"), { recursive: true });
    writeFileSync(path.join(dirB, "sub/c.txt"), "gamma\n");
    writeFileSync(path.join(dirB, "a.txt"), "alpha\n");
    writeFileSync(path.join(dirB, "b.txt"), "beta\n");

    const archiveA = createDeterministicTarGz(dirA, { sourceDateEpoch: 1_700_000_000 });
    const archiveB = createDeterministicTarGz(dirB, { sourceDateEpoch: 1_700_000_000 });
    assert.equal(Buffer.compare(archiveA, archiveB), 0, "deterministic tar.gz bytes must match exactly");
  } finally {
    rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
