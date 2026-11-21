// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  buildReproducibleBundle,
  computeDirectoryManifest,
  createDeterministicTarGz,
  verifyBuildManifest,
  verifyReproducibleBuild,
} from "./reproducible-build.mjs";

function parseUstarEntries(tarGzBytes) {
  const tar = gunzipSync(tarGzBytes);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readStr = (start, len) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/u, "");
    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    const mode = Number.parseInt(readStr(100, 8).trim(), 8).toString(8).padStart(4, "0");
    const size = Number.parseInt(readStr(124, 12).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156]);
    const linkTarget = readStr(157, 100);
    offset += 512;
    const content = size > 0 ? tar.subarray(offset, offset + size) : Buffer.alloc(0);
    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;
    entries.push({
      path: fullPath,
      type: typeflag === "2" ? "symlink" : "file",
      mode,
      size,
      ...(typeflag === "2" ? { linkTarget } : { content }),
    });
  }
  return entries;
}

function createFixtureGitRepo({
  nondeterministic = false,
  resolveWorkspaceDep = false,
  includeExecutableAndSymlink = false,
} = {}) {
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
  if (includeExecutableAndSymlink) {
    mkdirSync(path.join(dir, "packages/sample/bin"), { recursive: true });
    const binPath = path.join(dir, "packages/sample/bin/run.sh");
    writeFileSync(binPath, "#!/bin/sh\necho deterministic\n", { mode: 0o755 });
    chmodSync(binPath, 0o755);
    symlinkSync("run.sh", path.join(dir, "packages/sample/bin/run-link.sh"));
  }
  writeFileSync(
    path.join(dir, "packages/sample/build.mjs"),
    nondeterministic
      ? [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'writeFileSync("dist/index.js", `export const nonce = ${Math.random()}:${Date.now()}:${process.cwd()};\\n`);',
        ].join("\n")
      : resolveWorkspaceDep
        ? [
            'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
            'mkdirSync("dist", { recursive: true });',
            'const resolvedPkg = JSON.parse(readFileSync("../../node_modules/@repro/sample/package.json", "utf8"));',
            'writeFileSync("dist/index.js", `export const resolvedVersion = ${JSON.stringify(resolvedPkg.version)};\\n`);',
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
  return { dir, commit, git };
}

test("verifyReproducibleBuild confirms two independent offline builds produce bit-for-bit identical digests and tar.gz", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: false });
  try {
    const result = await verifyReproducibleBuild({
      repository: dir,
      revision: "HEAD",
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

test("offline-cache mode installs locked devDependencies (compiler) under hostile NODE_ENV=production and isolated PATH", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-repro-offline-cache-"));
  const toolPkgDir = path.join(sandbox, "repro-compiler");
  const repoDir = path.join(sandbox, "repo");
  const cacheDir = path.join(sandbox, "npm-cache");
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const nodeBinDir = path.dirname(process.execPath);
  // Isolated PATH containing only node/npm and POSIX /bin/sh (no global compilers like tsc or repro-compiler).
  const isolatedBinDir = path.join(sandbox, "isolated-bin");
  mkdirSync(isolatedBinDir, { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(process.execPath, path.join(isolatedBinDir, "node"));
    symlinkSync(path.join(nodeBinDir, "npm"), path.join(isolatedBinDir, "npm"));
    symlinkSync("/bin/sh", path.join(isolatedBinDir, "sh"));
  }
  const isolatedEnv = {
    PATH: process.platform === "win32" ? `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ""}` : isolatedBinDir,
    HOME: path.join(sandbox, "empty-home"),
    NODE_ENV: "production",
    npm_config_omit: "dev",
  };
  mkdirSync(isolatedEnv.HOME, { recursive: true });
  mkdirSync(toolPkgDir, { recursive: true });
  mkdirSync(path.join(repoDir, "packages/sample/src"), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  try {
    // 1. Create a real local devDependency compiler package and pack it into a tarball
    writeFileSync(
      path.join(toolPkgDir, "package.json"),
      `${JSON.stringify(
        {
          name: "repro-compiler",
          version: "1.0.0",
          bin: { "repro-compiler": "./cli.cjs" },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(toolPkgDir, "cli.cjs"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'fs.mkdirSync("dist", { recursive: true });',
        'const src = fs.readFileSync("src/index.js", "utf8");',
        'fs.writeFileSync("dist/index.js", `// compiled-by=repro-compiler@1.0.0 epoch=${process.env.SOURCE_DATE_EPOCH}\\n${src}`);',
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(path.join(toolPkgDir, "cli.cjs"), 0o755);

    const packRes = spawnSync(npmBin, ["pack", "--pack-destination", sandbox], {
      cwd: toolPkgDir,
      encoding: "utf8",
      env: { ...process.env, HOME: isolatedEnv.HOME },
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    assert.equal(packRes.status, 0, `npm pack failed: ${packRes.stderr}`);
    const tarballPath = path.join(sandbox, packRes.stdout.trim().split(/\r?\n/u).at(-1));

    // 2. Create a repo locking repro-compiler as devDependencies (dev: true in package-lock.json)
    writeFileSync(
      path.join(repoDir, "package.json"),
      `${JSON.stringify(
        {
          name: "offline-cache-fixture",
          version: "0.1.0",
          private: true,
          type: "module",
          workspaces: ["packages/*"],
          devDependencies: {
            "repro-compiler": `file:${tarballPath}`,
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(repoDir, "packages/sample/package.json"),
      `${JSON.stringify(
        {
          name: "@repro/sample",
          version: "0.1.0",
          type: "module",
          scripts: {
            build: "repro-compiler",
          },
          exports: { ".": "./src/index.js" },
          publishConfig: { exports: { ".": "./dist/index.js" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(repoDir, "packages/sample/src/index.js"), 'export const value = "offline-ok";\n');

    // Seed the offline cache and generate a real package-lock.json with dev:true on repro-compiler
    const seedInstall = spawnSync(
      npmBin,
      ["install", "--include=dev", "--cache", cacheDir, "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: { ...process.env, HOME: isolatedEnv.HOME },
        ...(process.platform === "win32" ? { shell: true } : {}),
      },
    );
    assert.equal(seedInstall.status, 0, `seed npm install failed: ${seedInstall.stderr}`);

    const lock = JSON.parse(readFileSync(path.join(repoDir, "package-lock.json"), "utf8"));
    assert.equal(
      lock.packages?.["node_modules/repro-compiler"]?.dev,
      true,
      "fixture lockfile must mark repro-compiler as dev:true to prove F-G7-05",
    );

    // Commit clean repository without node_modules
    rmSync(path.join(repoDir, "node_modules"), { recursive: true, force: true });
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
      GIT_AUTHOR_DATE: "2026-11-21T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-21T00:00:00Z",
    };
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoDir, env: gitEnv }).status, 0);
    assert.equal(spawnSync("git", ["add", "."], { cwd: repoDir, env: gitEnv }).status, 0);
    assert.equal(
      spawnSync("git", ["commit", "-q", "-m", "offline-cache-fixture"], { cwd: repoDir, env: gitEnv }).status,
      0,
    );
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      env: gitEnv,
    }).stdout.trim();

    // 3. Run two real --offline-cache builds under isolated PATH and hostile NODE_ENV=production
    const result = await verifyReproducibleBuild({
      repository: repoDir,
      revision: commit,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "offline-cache",
      offlineCacheDir: cacheDir,
      createArchive: true,
      env: isolatedEnv,
    });

    assert.equal(result.ok, true, `real offline-cache dual build must succeed: ${JSON.stringify(result.differences)}`);
    assert.equal(result.differences.length, 0);
    assert.equal(result.builds[0].artifactDigest, result.builds[1].artifactDigest);
    assert.equal(result.builds[0].archiveSha256, result.builds[1].archiveSha256);
    assert.match(result.archiveSha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("verifyBuildManifest detects byte, executable-mode, symlink-target, type, missing, and extra tampering, and output dir matches tar.gz 1:1", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: false, includeExecutableAndSymlink: true });
  const outDir = mkdtempSync(path.join(tmpdir(), "ha-repro-out-"));
  const archiveDir = mkdtempSync(path.join(tmpdir(), "ha-repro-archive-"));
  const archivePath = path.join(archiveDir, "bundle.tar.gz");
  try {
    const built = await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      outputDir: outDir,
      archivePath,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    const manifestPath = path.join(outDir, "build-manifest.json");
    assert.equal(verifyBuildManifest({ bundleDir: outDir, manifestPath }).ok, true);

    // Confirm output directory, manifest, and USTAR tar.gz archive are structurally equivalent (files + modes + symlinks)
    const tarEntries = parseUstarEntries(readFileSync(archivePath)).filter(
      (entry) => entry.path !== "build-manifest.json",
    );
    const manifestEntries = built.manifest.files;
    assert.equal(tarEntries.length, manifestEntries.length, "tar.gz and manifest must have identical entry counts");
    for (let i = 0; i < manifestEntries.length; i += 1) {
      const m = manifestEntries[i];
      const t = tarEntries[i];
      assert.equal(t.path, m.path);
      assert.equal(t.type, m.type);
      assert.equal(t.mode, m.mode);
      assert.equal(t.size, m.size);
      const outPath = path.join(outDir, ...m.path.split("/"));
      const outStat = lstatSync(outPath);
      if (m.type === "symlink") {
        assert.equal(outStat.isSymbolicLink(), true, `${m.path} must be a symlink in outputDir`);
        assert.equal(readlinkSync(outPath), m.linkTarget);
        assert.equal(t.linkTarget, m.linkTarget);
      } else {
        assert.equal(outStat.isFile(), true, `${m.path} must be a regular file in outputDir`);
        const outMode = (outStat.mode & 0o111) !== 0 ? "0755" : "0644";
        assert.equal(outMode, m.mode);
      }
    }

    // Executable bit tampering rejected (F-G7-06)
    const binTarget = path.join(outDir, "packages/sample/bin/run.sh");
    chmodSync(binTarget, 0o644);
    const modeCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(modeCheck.ok, false, "executable mode tampering must fail verifyBuildManifest");
    assert.ok(modeCheck.errors.some((entry) => entry.includes("mode mismatch") && entry.includes("run.sh")));
    chmodSync(binTarget, 0o755);

    // Symlink target tampering rejected (F-G7-06)
    const linkTarget = path.join(outDir, "packages/sample/bin/run-link.sh");
    unlinkSync(linkTarget);
    symlinkSync("../src/index.js", linkTarget);
    const linkCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(linkCheck.ok, false, "symlink target tampering must fail verifyBuildManifest");
    assert.ok(linkCheck.errors.some((entry) => entry.includes("symlink target mismatch")));

    // Symlink replaced with regular file rejected (type mismatch)
    unlinkSync(linkTarget);
    writeFileSync(linkTarget, "not-a-symlink\n");
    const typeCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(typeCheck.ok, false, "file type substitution must fail verifyBuildManifest");
    assert.ok(typeCheck.errors.some((entry) => entry.includes("type mismatch")));
    unlinkSync(linkTarget);
    symlinkSync("run.sh", linkTarget);

    // Extra unexpected file rejected
    const extraPath = path.join(outDir, "packages/sample/dist/injected.js");
    writeFileSync(extraPath, "injected\n");
    const extraCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(extraCheck.ok, false);
    assert.ok(extraCheck.errors.some((entry) => entry.includes("injected.js")));
    unlinkSync(extraPath);

    // F-G7-26: extra files inside previously ignored directory names (node_modules, .git) MUST be caught by verifyBuildManifest
    const injectedNodeModulesFile = path.join(outDir, "node_modules/evil-dep/index.js");
    mkdirSync(path.dirname(injectedNodeModulesFile), { recursive: true });
    writeFileSync(injectedNodeModulesFile, 'module.exports = "hijacked";\n');
    const nmCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(
      nmCheck.ok,
      false,
      "verifyBuildManifest must reject injected node_modules files inside delivered bundle",
    );
    assert.ok(nmCheck.errors.some((entry) => entry.includes("unexpected extra file: node_modules/evil-dep/index.js")));
    rmSync(path.join(outDir, "node_modules"), { recursive: true, force: true });

    const injectedNestedNm = path.join(outDir, "packages/sample/node_modules/shadow/index.js");
    mkdirSync(path.dirname(injectedNestedNm), { recursive: true });
    writeFileSync(injectedNestedNm, "export const hijacked = true;\n");
    const nestedNmCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(nestedNmCheck.ok, false, "verifyBuildManifest must reject nested node_modules files");
    assert.ok(
      nestedNmCheck.errors.some((entry) =>
        entry.includes("unexpected extra file: packages/sample/node_modules/shadow/index.js"),
      ),
    );
    rmSync(path.join(outDir, "packages/sample/node_modules"), { recursive: true, force: true });

    const injectedGitConfig = path.join(outDir, ".git/config");
    mkdirSync(path.dirname(injectedGitConfig), { recursive: true });
    writeFileSync(injectedGitConfig, "[core]\n\trepositoryformatversion = 0\n");
    const gitDirCheck = verifyBuildManifest({ bundleDir: outDir, manifestPath });
    assert.equal(gitDirCheck.ok, false, "verifyBuildManifest must reject injected .git files inside delivered bundle");
    assert.ok(gitDirCheck.errors.some((entry) => entry.includes("unexpected extra file: .git/config")));
    rmSync(path.join(outDir, ".git"), { recursive: true, force: true });

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

    // Confirm built digest matches computeDirectoryManifest when restored clean
    writeFileSync(target, original);
    const recomputed = computeDirectoryManifest(outDir, { ignoreFiles: ["build-manifest.json"] });
    assert.equal(recomputed.artifactDigest, built.manifest.artifactDigest);
    assert.equal(verifyBuildManifest({ bundleDir: outDir, manifestPath }).ok, true);

    // F-G7-16: tampering symlink manifest size or sha256 (even with recomputed artifactDigest) MUST fail verifyBuildManifest
    const baseManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const symlinkIdx = baseManifest.files.findIndex((entry) => entry.type === "symlink");
    assert.ok(symlinkIdx >= 0, "expected symlink entry in manifest");

    // 1) Tamper symlink size (artifactDigest unchanged because symlink fingerprint omits size)
    const badSizeManifest = structuredClone(baseManifest);
    badSizeManifest.files[symlinkIdx].size = 42;
    const badSizePath = path.join(archiveDir, "bad-symlink-size.json");
    writeFileSync(badSizePath, `${JSON.stringify(badSizeManifest, null, 2)}\n`);
    const badSizeRes = verifyBuildManifest({ bundleDir: outDir, manifestPath: badSizePath });
    assert.equal(badSizeRes.ok, false, "tampered symlink size in manifest must be rejected");
    assert.ok(badSizeRes.errors.some((entry) => entry.includes("size mismatch for symlink")));

    // 2) Tamper symlink sha256 AND update root artifactDigest to match the tampered entry
    const badShaManifest = structuredClone(baseManifest);
    badShaManifest.files[symlinkIdx].sha256 = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const forgedLines = badShaManifest.files
      .map((entry) =>
        entry.type === "symlink"
          ? `symlink  ${entry.mode}  ${entry.sha256}  ${entry.path} -> ${entry.linkTarget ?? ""}`
          : `file  ${entry.mode}  ${entry.sha256}  ${entry.size}  ${entry.path}`,
      )
      .join("\n");
    const { hash } = await import("node:crypto");
    badShaManifest.artifactDigest = `sha256:${hash("sha256", Buffer.from(forgedLines, "utf8"), "hex")}`;
    const badShaPath = path.join(archiveDir, "bad-symlink-sha.json");
    writeFileSync(badShaPath, `${JSON.stringify(badShaManifest, null, 2)}\n`);
    const badShaRes = verifyBuildManifest({ bundleDir: outDir, manifestPath: badShaPath });
    assert.equal(
      badShaRes.ok,
      false,
      "tampered symlink sha256 in manifest must be rejected even with updated root digest",
    );
    assert.ok(badShaRes.errors.some((entry) => entry.includes("digest mismatch for symlink")));

    // 3) Tamper fileCount / duplicate manifest entries rejected
    const badCountManifest = structuredClone(baseManifest);
    badCountManifest.fileCount = baseManifest.files.length + 1;
    const badCountPath = path.join(archiveDir, "bad-count.json");
    writeFileSync(badCountPath, `${JSON.stringify(badCountManifest, null, 2)}\n`);
    const badCountRes = verifyBuildManifest({ bundleDir: outDir, manifestPath: badCountPath });
    assert.equal(badCountRes.ok, false, "mismatched fileCount in manifest must be rejected");
    assert.ok(badCountRes.errors.some((entry) => entry.includes("fileCount mismatch")));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(archiveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("buildReproducibleBundle atomically replaces reused --out directory so deleted files never survive into verify-manifest", async () => {
  const {
    dir,
    commit: commit1,
    git,
  } = createFixtureGitRepo({ nondeterministic: false, includeExecutableAndSymlink: true });
  const outDir = path.join(mkdtempSync(path.join(tmpdir(), "ha-repro-reuse-")), "bundle");
  const archiveDir = mkdtempSync(path.join(tmpdir(), "ha-repro-reuse-arch-"));
  const archive1 = path.join(archiveDir, "v1.tar.gz");
  const archive2 = path.join(archiveDir, "v2.tar.gz");
  try {
    // Commit 1 includes an extra file that will be deleted in Commit 2
    writeFileSync(path.join(dir, "packages/sample/src/obsolete.js"), "export const old = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "add obsolete file"]);
    const cut1 = git(["rev-parse", "HEAD"]);
    assert.notEqual(cut1, commit1);

    await buildReproducibleBundle({
      repository: dir,
      revision: cut1,
      outputDir: outDir,
      archivePath: archive1,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    assert.equal(verifyBuildManifest({ bundleDir: outDir }).ok, true);
    assert.ok(lstatSync(path.join(outDir, "packages/sample/src/obsolete.js")).isFile());

    // Commit 2 deletes obsolete.js; rebuilding into the SAME --out must atomically replace it
    unlinkSync(path.join(dir, "packages/sample/src/obsolete.js"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "delete obsolete file"]);
    const cut2 = git(["rev-parse", "HEAD"]);

    const built2 = await buildReproducibleBundle({
      repository: dir,
      revision: cut2,
      outputDir: outDir,
      archivePath: archive2,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    assert.equal(
      lstatSync(path.join(outDir, "packages/sample/src/obsolete.js"), { throwIfNoEntry: false }),
      undefined,
      "reused --out directory must not retain files deleted in the second cut",
    );
    const verified2 = verifyBuildManifest({ bundleDir: outDir });
    assert.equal(verified2.ok, true, `reused --out must pass verifyBuildManifest: ${JSON.stringify(verified2.errors)}`);
    const tar2Entries = parseUstarEntries(readFileSync(archive2)).filter(
      (entry) => entry.path !== "build-manifest.json",
    );
    assert.deepEqual(
      tar2Entries.map((entry) => entry.path),
      built2.manifest.files.map((entry) => entry.path),
      "reused --out manifest and second-cut tar.gz must match 1:1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(path.dirname(outDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(archiveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("buildReproducibleBundle refuses protected paths, arbitrary non-bundle directories, and --archive inside --out (F-G7-25)", async () => {
  const { dir, commit } = createFixtureGitRepo({ nondeterministic: false });
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-repro-guard-"));
  const operatorDir = path.join(sandbox, "operator-backups");
  const fakeGitDir = path.join(sandbox, "checkout-with-manifest");
  const cleanOutDir = path.join(sandbox, "fresh-bundle");
  try {
    // 1. Existing non-empty directory created outside this tool (no build-manifest.json)
    mkdirSync(operatorDir, { recursive: true });
    const preciousFile = path.join(operatorDir, "backup-2026.sql");
    writeFileSync(preciousFile, "-- precious operator backup\n");
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: operatorDir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /without a valid harness-anything\/reproducible-build-manifest\/v1 build-manifest\.json/u,
    );
    assert.equal(
      readFileSync(preciousFile, "utf8"),
      "-- precious operator backup\n",
      "refused --out must leave existing operator files completely untouched",
    );

    // 2. Protected repository root / ancestor directory
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: dir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing to replace protected directory/u,
    );
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: path.dirname(dir),
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing to replace protected directory/u,
    );

    // 3. Git checkout directory even if it contains a valid-looking build-manifest.json
    mkdirSync(path.join(fakeGitDir, ".git"), { recursive: true });
    writeFileSync(
      path.join(fakeGitDir, "build-manifest.json"),
      JSON.stringify({ schema: "harness-anything/reproducible-build-manifest/v1", files: [] }),
    );
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: fakeGitDir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing to replace Git checkout directory/u,
    );

    // 4. --archive placed inside --out directory (including dot-prefixed filenames like ..archive.tar.gz and symlinked parent aliases) is refused before writing or replacing
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: cleanOutDir,
          archivePath: path.join(cleanOutDir, "nested/bundle.tar.gz"),
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing overlapping --archive/u,
    );
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: cleanOutDir,
          archivePath: path.join(cleanOutDir, "..archive.tar.gz"),
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing overlapping --archive/u,
    );
    assert.equal(
      lstatSync(cleanOutDir, { throwIfNoEntry: false }),
      undefined,
      "rejected overlapping --archive/--out must not create partial output",
    );

    // 5. F-G7-34: Symlinked parent directory aliasing --out must also be rejected as overlapping --archive
    mkdirSync(cleanOutDir, { recursive: true });
    const symlinkAlias = path.join(sandbox, "out-alias");
    symlinkSync(cleanOutDir, symlinkAlias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: cleanOutDir,
          archivePath: path.join(symlinkAlias, "bundle.tar.gz"),
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing overlapping --archive/u,
    );

    // 6. F-G7-34: Shallow/empty build-manifest.json alongside unmanaged files or empty subdirectories must fail strict verification before replacement
    const shallowManifestDir = path.join(sandbox, "shallow-manifest");
    mkdirSync(shallowManifestDir, { recursive: true });
    const retainedFile = path.join(shallowManifestDir, "retained-artifact.txt");
    writeFileSync(retainedFile, "must-not-be-deleted\n");
    writeFileSync(
      path.join(shallowManifestDir, "build-manifest.json"),
      JSON.stringify({ schema: "harness-anything/reproducible-build-manifest/v1", fileCount: 0, files: [] }),
    );
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: shallowManifestDir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /without a valid harness-anything\/reproducible-build-manifest\/v1 build-manifest\.json verification/u,
    );
    assert.equal(
      readFileSync(retainedFile, "utf8"),
      "must-not-be-deleted\n",
      "refused shallow-manifest replacement must preserve unmanaged files",
    );

    // 7. F-G7-34: Real built bundle with an added unmanaged file or empty subdirectory must refuse replacement and preserve unmanaged content
    const dirtyBundleDir = path.join(sandbox, "dirty-bundle");
    await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      outputDir: dirtyBundleDir,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    const extraNotes = path.join(dirtyBundleDir, "operator-notes.txt");
    writeFileSync(extraNotes, "keep-me\n");
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: dirtyBundleDir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /unexpected extra file: operator-notes\.txt/u,
    );
    assert.equal(readFileSync(extraNotes, "utf8"), "keep-me\n");
    rmSync(extraNotes, { force: true });
    const extraEmptyDir = path.join(dirtyBundleDir, "unmanaged-empty-dir");
    mkdirSync(extraEmptyDir, { recursive: true });
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: dirtyBundleDir,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /unmanaged directories/u,
    );
    assert.equal(lstatSync(extraEmptyDir).isDirectory(), true);

    // 8. F-G7-45: Hardlinked --archive pointing to an existing file inside --out must NEVER truncate the shared inode
    // when --out replacement fails or during manifest verification!
    const hardlinkBundleDir = path.join(sandbox, "hardlink-bundle");
    await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      outputDir: hardlinkBundleDir,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    const insideTarget = path.join(hardlinkBundleDir, "packages", "sample", "dist", "index.js");
    const originalBytes = readFileSync(insideTarget);
    const originalStat = lstatSync(insideTarget);
    const hardlinkArchive = path.join(sandbox, "alias.tar.gz");
    linkSync(insideTarget, hardlinkArchive);
    assert.equal(lstatSync(hardlinkArchive).ino, originalStat.ino, "fixture setup must share inode");

    // 8a. When --out replacement is rejected (unmanaged file added), BOTH the hardlinked file inside --out and --archive
    // stay completely intact (same bytes, same inode, zero leftover staging files).
    const blockerFile = path.join(hardlinkBundleDir, "unmanaged-keep.txt");
    writeFileSync(blockerFile, "blocker\n");
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          outputDir: hardlinkBundleDir,
          archivePath: hardlinkArchive,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /unexpected extra file: unmanaged-keep\.txt/u,
    );
    assert.equal(
      Buffer.compare(readFileSync(insideTarget), originalBytes),
      0,
      "rejected --out replacement must not truncate hardlinked file inside --out",
    );
    assert.equal(
      Buffer.compare(readFileSync(hardlinkArchive), originalBytes),
      0,
      "rejected --out replacement must not modify --archive target",
    );
    assert.equal(lstatSync(hardlinkArchive).ino, originalStat.ino);
    assert.deepEqual(
      readdirSync(sandbox).filter((name) => name.includes(".staging-")),
      [],
      "failed archive staging must clean up temporary files",
    );
    rmSync(blockerFile, { force: true });
    assert.equal(
      verifyBuildManifest({ bundleDir: hardlinkBundleDir }).ok,
      true,
      "existing bundle manifest must remain 100% valid after failed build with hardlinked --archive",
    );

    // 8b. When --out IS a valid bundle and --archive is hardlinked to a file inside --out, staging to an O_EXCL temp
    // inode allows --out manifest verification & atomic swap to succeed cleanly, then renames the new archive inode!
    const replaced = await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      outputDir: hardlinkBundleDir,
      archivePath: hardlinkArchive,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    assert.equal(replaced.ok, true);
    assert.equal(verifyBuildManifest({ bundleDir: hardlinkBundleDir }).ok, true);
    assert.notEqual(
      lstatSync(hardlinkArchive).ino,
      originalStat.ino,
      "atomic archive rename must publish a new inode instead of truncating the old hardlink inode",
    );
    assert.equal(parseUstarEntries(readFileSync(hardlinkArchive)).length > 0, true);

    // 8c. External hardlink pair: overwriting --archive replaces only the archive directory entry and preserves peer link bytes!
    const peerKeep = path.join(sandbox, "peer-keep.txt");
    const peerAlias = path.join(sandbox, "peer-alias.tar.gz");
    writeFileSync(peerKeep, "preserve-external-hardlink\n");
    linkSync(peerKeep, peerAlias);
    await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      archivePath: peerAlias,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "none",
    });
    assert.equal(readFileSync(peerKeep, "utf8"), "preserve-external-hardlink\n");
    assert.notEqual(lstatSync(peerKeep).ino, lstatSync(peerAlias).ino);

    // 8d. Refusing an existing directory passed as --archive
    const archiveDirCollision = path.join(sandbox, "archive-is-dir");
    mkdirSync(archiveDirCollision, { recursive: true });
    await assert.rejects(
      () =>
        buildReproducibleBundle({
          repository: dir,
          revision: commit,
          archivePath: archiveDirCollision,
          targetWorkspaces: ["@repro/sample"],
          dependencyMode: "none",
        }),
      /Refusing to overwrite directory as --archive target/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
    symlinkSync("../a.txt", path.join(dirA, "sub/a-link.txt"));

    mkdirSync(path.join(dirB, "sub"), { recursive: true });
    symlinkSync("../a.txt", path.join(dirB, "sub/a-link.txt"));
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

test("buildReproducibleBundle mirror mode rebinds workspace symlinks into the extracted commit tree", async () => {
  const { dir, commit } = createFixtureGitRepo({ resolveWorkspaceDep: true });
  const staleRoot = mkdtempSync(path.join(tmpdir(), "ha-repro-stale-"));
  const outputDir = mkdtempSync(path.join(tmpdir(), "ha-repro-mirror-out-"));
  try {
    mkdirSync(path.join(staleRoot, "packages/sample"), { recursive: true });
    writeFileSync(
      path.join(staleRoot, "packages/sample/package.json"),
      JSON.stringify({ name: "@repro/sample", version: "0.0.0-stale" }),
    );
    mkdirSync(path.join(dir, "node_modules/@repro"), { recursive: true });
    symlinkSync(
      path.join(staleRoot, "packages/sample"),
      path.join(dir, "node_modules/@repro/sample"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const built = await buildReproducibleBundle({
      repository: dir,
      revision: commit,
      targetWorkspaces: ["@repro/sample"],
      dependencyMode: "mirror",
      outputDir,
    });
    assert.equal(built.manifest.commit, commit);
    assert.ok(built.manifest.files.some((entry) => entry.path === "packages/sample/dist/index.js"));
    const distCode = readFileSync(path.join(outputDir, "packages/sample/dist/index.js"), "utf8");
    assert.match(
      distCode,
      /"0\.1\.0"/u,
      "mirror build must resolve @repro/sample from the pinned commit, not staleRoot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(staleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
