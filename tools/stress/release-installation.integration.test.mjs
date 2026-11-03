// harness-test-tier: integration
// harness-test-file-timeout: 1500000
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runReleaseCommand } from "../release-installation.mjs";
import { updateTestCenter } from "../test-center-update.mjs";
import { registerBootstrappedDaemonRepo } from "../../packages/daemon/test/repo-settings.fixture.ts";

const execute = promisify(execFile);
// This is the explicitly requested installation/switch/rollback experiment. It builds two real
// public-source archives with independent npm installs; it does not use the host daemon or store.
test(
  "fixed releases survive a development rebuild, then upgrade and roll back through the public command",
  {
    skip:
      process.env.FLEET_STRESS_RELEASE_INSTALL !== "1"
        ? "requires explicit release installation campaign"
        : process.platform === "win32"
          ? "requires POSIX atomic directory-symbolic-link replacement semantics"
          : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acceptance-")),
      repository = path.join(parent, "source"),
      root = path.join(parent, "installed"),
      workspace = path.join(parent, "ledger"),
      userRoot = path.join(parent, "user"),
      daemonId = "release-acceptance",
      saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("HARNESS_")) delete process.env[key];
    process.env.HARNESS_DAEMON_OWNER_PID = String(process.pid);
    const target = ["--root", root, "--user-root", userRoot, "--daemon-id", daemonId, "--workspace", workspace];
    let current;
    const git = async (...args) => (await execute("git", ["-C", repository, ...args])).stdout.trim();
    try {
      mkdirSync(repository);
      for (const name of [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.base.json",
        "packages",
        "tools",
      ])
        if (existsSync(name))
          cpSync(name, path.join(repository, name), {
            recursive: true,
            mode: constants.COPYFILE_FICLONE,
            verbatimSymlinks: true,
            filter: (source) =>
              !["node_modules", "dist", "dist-electron", ".git", ".harness"].includes(path.basename(source)) &&
              !source.endsWith(".tsbuildinfo"),
          });
      await git("init", "--quiet", "--initial-branch=main");
      await git("config", "user.name", "Release Acceptance Fixture");
      await git("config", "user.email", "release-acceptance@example.invalid");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "fixture release A");
      const a = await git("rev-parse", "HEAD");
      const first = await runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", a]);
      console.log("INSTALL A", JSON.stringify(first));
      assert.equal(
        realpathSync(path.join(first.directory, "node_modules/.bin/ha")),
        path.join(first.directory, "packages/cli/dist/cli/src/index.js"),
      );
      await assert.rejects(
        runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", a]),
        /already exists/u,
      );
      assert.equal((await runReleaseCommand(["status", "--root", root])).current, null);
      mkdirSync(path.join(workspace, "harness"), { recursive: true });
      await execute("git", ["init", "--quiet", workspace]);
      await execute("git", ["-C", workspace, "config", "user.name", "Release Ledger Fixture"]);
      await execute("git", ["-C", workspace, "config", "user.email", "release-ledger@example.invalid"]);
      writeFileSync(
        path.join(workspace, "harness/harness.yaml"),
        "schema: harness-anything/v1\nname: release-acceptance\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      await execute("git", ["-C", workspace, "add", "."]);
      await execute("git", ["-C", workspace, "commit", "--quiet", "-m", "fixture ledger"]);
      registerBootstrappedDaemonRepo({
        canonicalRoot: workspace,
        repoId: "release-acceptance",
        userRoot,
        createConvenienceLinks: false,
      });
      // A real same-commit development process must not masquerade as this installation.
      const development = path.join(parent, "development");
      cpSync(path.join(root, "versions", a), development, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
      });
      assert.equal(
        realpathSync(path.join(development, "node_modules/@harness-anything/daemon/package.json")),
        path.join(development, "packages/daemon/package.json"),
        "The development copy must launch its own daemon, not the installed release behind an absolutized link.",
      );
      const incumbentCli = async (...args) =>
        JSON.parse(
          (
            await execute(process.execPath, [
              path.join(development, "packages/cli/dist/cli/src/index.js"),
              "daemon",
              ...args,
              "--user-root",
              userRoot,
              "--daemon-id",
              daemonId,
              "--root",
              workspace,
              "--json",
            ])
          ).stdout,
        );
      try {
        await incumbentCli("start", "--service");
        const incumbent = await incumbentCli("status");
        assert.equal(incumbent.build.loadedBuildId, a);
        await assert.rejects(runReleaseCommand(["switch", "--revision", a, ...target]), { code: "daemon_unmanaged" });
        assert.equal((await incumbentCli("status")).pid, incumbent.pid);
        assert.equal(existsSync(path.join(root, "deployment.json")), false);
        assert.equal(existsSync(path.join(root, "current")), false);
        console.log(
          "UNMANAGED SAME-COMMIT REFUSED",
          JSON.stringify({ pid: incumbent.pid, build: incumbent.build, current: null }),
        );
      } finally {
        await incumbentCli("stop", "--force");
      }
      const activated = await runReleaseCommand(["switch", "--revision", a, ...target]);
      current = a;
      console.log("SWITCH A", JSON.stringify(activated));
      const cli = async (revision, args) => {
        const { stdout } = await execute(
          process.execPath,
          [
            path.join(root, "versions", revision, "packages/cli/dist/cli/src/index.js"),
            "daemon",
            ...args,
            "--user-root",
            userRoot,
            "--daemon-id",
            daemonId,
            "--root",
            workspace,
            "--json",
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      };
      const before = await cli(a, ["status"]);
      mkdirSync(path.join(repository, "packages/daemon/dist"), { recursive: true });
      writeFileSync(path.join(repository, "packages/daemon/dist/build-id.txt"), "development-rebuild\n");
      const after = await cli(a, ["status"]);
      assert.equal(after.pid, before.pid);
      assert.equal(after.build.loadedBuildId, a);
      assert.equal(after.build.drifted, false);
      console.log(
        "FIXED REBUILD CONTROL",
        JSON.stringify({ before: before.pid, after: after.pid, build: after.build }),
      );
      writeFileSync(path.join(repository, "release-generation.txt"), "B\n");
      await git("add", "release-generation.txt");
      await git("commit", "--quiet", "-m", "fixture release B");
      const b = await git("rev-parse", "HEAD");
      console.log(
        "INSTALL B",
        JSON.stringify(
          await runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", b]),
        ),
      );
      const upgraded = await runReleaseCommand(["switch", "--revision", b, ...target]);
      current = b;
      assert.equal(upgraded.status.build.loadedBuildId, b);
      assert.equal(upgraded.previous, a);
      console.log("UPGRADE", JSON.stringify(upgraded));
      const previousCli = await cli(a, ["status"]);
      assert.equal(previousCli.ok, true);
      assert.equal(previousCli.build.loadedBuildId, b);
      console.log("PREVIOUS BUILD CLI", JSON.stringify(previousCli));
      const rolled = await runReleaseCommand(["rollback", ...target]);
      current = a;
      assert.equal(rolled.current, a);
      assert.equal(rolled.status.build.loadedBuildId, a);
      console.log("ROLLBACK", JSON.stringify(rolled));
      await git("remote", "add", "origin", repository);
      const updated = await updateTestCenter([...target, "--repository", repository]);
      current = b;
      assert.equal(updated.current, b);
      console.log("MAIN UPDATE", JSON.stringify(updated));
      const unchanged = await updateTestCenter([...target, "--repository", repository]);
      assert.equal(unchanged.unchanged, true);
      const rolledAgain = await runReleaseCommand(["rollback", ...target]);
      current = a;
      assert.equal(rolledAgain.current, a);
      console.log("MAIN UNCHANGED", JSON.stringify(unchanged));
      // Positive drift control: mutate only the test-owned development copy.
      const devUser = path.join(parent, "dev-user"),
        devId = "development-control";
      const devCli = async (...args) =>
        execute(process.execPath, [
          path.join(development, "packages/cli/dist/cli/src/index.js"),
          "daemon",
          ...args,
          "--user-root",
          devUser,
          "--daemon-id",
          devId,
          "--root",
          workspace,
          "--json",
        ]);
      try {
        await devCli("start", "--service");
        writeFileSync(path.join(development, "packages/daemon/dist/build-id.txt"), "development-rebuild\n");
        // A same-release request observes the changed disk marker and initiates the real drain.
        await devCli("status").catch((error) => console.log("DEVELOPMENT TRANSITION", error.stdout ?? error.message));
        const lifecycle = path.join(devUser, "logs", `daemon-${devId}-lifecycle.jsonl`);
        const deadline = Date.now() + 15_000;
        for (;;) {
          const entries = existsSync(lifecycle) ? readFileSync(lifecycle, "utf8") : "";
          if (entries.includes("build_superseded")) {
            console.log("DEVELOPMENT CONTROL", entries);
            break;
          }
          assert.ok(Date.now() < deadline, `No build_superseded in ${lifecycle}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await devCli("stop", "--force").catch((error) => console.log("DEV CLEANUP", error.stdout ?? error.message));
      }
    } finally {
      if (current) {
        const entry = path.join(root, "versions", current, "packages/cli/dist/cli/src/index.js");
        await execute(process.execPath, [
          entry,
          "daemon",
          "stop",
          "--user-root",
          userRoot,
          "--daemon-id",
          daemonId,
          "--root",
          workspace,
          "--json",
        ]).catch((error) => console.log("CLEANUP", error.stdout ?? error.message));
      }
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
