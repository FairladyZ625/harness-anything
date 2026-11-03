// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runReleaseCommand } from "./release-installation.mjs";
import { updateTestCenter } from "./test-center-update.mjs";
const execute = promisify(execFile);

// The process controller is a fixture; npm, Git archives, export materialization, locks,
// state, pointer replacement and updater calls are real. The real-daemon campaign lives
// under tools/stress and is explicitly selected for release qualification.
test(
  "release commands preserve the predecessor across failure, rollback and main updates",
  {
    skip: process.platform === "win32" ? "requires POSIX atomic directory-symbolic-link replacement semantics" : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-release-commands-")),
      repository = path.join(parent, "source"),
      root = path.join(parent, "installed"),
      userRoot = path.join(parent, "state"),
      workspace = path.join(parent, "ledger");
    const write = (file, body) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
    };
    const git = async (...args) => (await execute("git", ["-C", repository, ...args])).stdout.trim();
    const cliManifest = {
      name: "@harness-anything/cli",
      version: "0.1.0",
      type: "module",
      scripts: { build: "node build.mjs" },
      dependencies: { "@harness-anything/daemon": "0.1.0" },
      bin: { ha: "dist/cli/src/index.js" },
      exports: "./src/index.ts",
      publishConfig: { exports: "./dist/cli/src/index.js" },
    };
    const daemonManifest = {
      name: "@harness-anything/daemon",
      version: "0.1.0",
      type: "module",
      scripts: { build: "node build.mjs" },
      bin: { "harness-anything-daemon": "dist/index.js" },
      exports: "./src/index.ts",
      publishConfig: { exports: "./dist/index.js" },
    };
    const controller = `import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1], user=option('--user-root'), workspace=option('--root'), file=path.join(user,'running.json'), own=readFileSync(new URL('../../build-id.txt',import.meta.url),'utf8').trim();mkdirSync(user,{recursive:true});
const running=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;let receipt;
if(args[1]==='start'){if(existsSync(path.join(user,'fail'))&&readFileSync(path.join(user,'fail'),'utf8')===own)receipt={ok:false,code:'fixture_start_failed'};else{writeFileSync(file,JSON.stringify({commit:existsSync(path.join(user,'wrong-entry'))?readFileSync(path.join(user,'wrong-entry'),'utf8'):own,pid:42}));receipt={ok:true};}}
else if(!running)receipt={ok:false,code:'daemon_unavailable'};
else if(args[1]==='stop'){unlinkSync(file);receipt={ok:true};}
else receipt={ok:true,pid:42,build:{loadedBuildId:running.commit},repos:[{rootDir:workspace,state:'attached'}]};console.log(JSON.stringify(receipt));process.exitCode=receipt.ok?0:1;`;
    try {
      write(path.join(repository, "package.json"), {
        name: "release-command-fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["packages/*"],
      });
      for (const [name, manifest] of [
        ["cli", cliManifest],
        ["daemon", daemonManifest],
      ])
        write(path.join(repository, `packages/${name}/package.json`), manifest);
      write(
        path.join(repository, "packages/cli/build.mjs"),
        `import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('dist/cli/src',{recursive:true});writeFileSync('dist/cli/src/index.js',${JSON.stringify(controller)});writeFileSync('dist/build-id.txt',process.env.HARNESS_BUILD_COMMIT);`,
      );
      write(
        path.join(repository, "packages/daemon/build.mjs"),
        "import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','export {};');",
      );
      await execute("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: repository,
      });
      await git("init", "--quiet", "--initial-branch=main");
      await git("config", "user.name", "Release Command Fixture");
      await git("config", "user.email", "release-command@example.invalid");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "fixture A");
      const a = await git("rev-parse", "HEAD");
      mkdirSync(workspace);
      const target = ["--root", root, "--user-root", userRoot, "--daemon-id", "fixture", "--workspace", workspace];
      const installed = await runReleaseCommand([
        "install",
        "--root",
        root,
        "--repository",
        repository,
        "--revision",
        a,
      ]);
      assert.equal(
        JSON.parse(readFileSync(path.join(installed.directory, "packages/cli/package.json"), "utf8")).exports,
        "./dist/cli/src/index.js",
      );
      assert.equal((await runReleaseCommand(["status", "--root", root])).current, null);
      await assert.rejects(
        runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", a]),
        /already exists/u,
      );
      // A development daemon built from A is still outside this installation's ownership.
      write(path.join(userRoot, "running.json"), { commit: a, pid: 42 });
      await assert.rejects(runReleaseCommand(["switch", "--revision", a, ...target]), /daemon_unmanaged/u);
      assert.equal(existsSync(path.join(root, "deployment.json")), false);
      assert.equal(existsSync(path.join(root, "current")), false);
      assert.deepEqual(JSON.parse(readFileSync(path.join(userRoot, "running.json"), "utf8")), { commit: a, pid: 42 });
      unlinkSync(path.join(userRoot, "running.json"));
      await runReleaseCommand(["switch", "--revision", a, ...target]);
      write(path.join(repository, "generation.txt"), "B");
      await git("add", "generation.txt");
      await git("commit", "--quiet", "-m", "fixture B");
      const b = await git("rev-parse", "HEAD");
      await runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", b]);
      // A service manager may restart the predecessor even though the protocol is compatible.
      write(path.join(userRoot, "wrong-entry"), a);
      await assert.rejects(runReleaseCommand(["switch", "--revision", b, ...target]), {
        code: "daemon_release_mismatch",
      });
      unlinkSync(path.join(userRoot, "wrong-entry"));
      assert.equal((await runReleaseCommand(["rollback", ...target])).current, a);
      write(path.join(userRoot, "fail"), b);
      await assert.rejects(runReleaseCommand(["switch", "--revision", b, ...target]), (error) => {
        assert.equal(error.code, "fixture_start_failed");
        assert.match(error.message, /fixture_start_failed.*rollback/u);
        return true;
      });
      assert.deepEqual((await runReleaseCommand(["status", "--root", root])).previous, a);
      const recovered = await runReleaseCommand(["rollback", ...target]);
      assert.equal(recovered.current, a);
      write(path.join(userRoot, "fail"), "");
      await git("remote", "add", "origin", repository);
      const deployed = await updateTestCenter([...target, "--repository", repository]);
      assert.equal(deployed.current, b);
      assert.equal(deployed.previous, a);
      assert.equal((await updateTestCenter([...target, "--repository", repository])).unchanged, true);
      assert.equal((await runReleaseCommand(["rollback", ...target])).current, a);
      await git("remote", "set-url", "origin", path.join(parent, "missing-remote"));
      await assert.rejects(updateTestCenter([...target, "--repository", repository]));
      assert.equal(
        existsSync(path.join(root, "failed-update.json")),
        true,
        "fetch failure must stop repeated installations too",
      );
      await assert.rejects(updateTestCenter([...target, "--repository", repository]), /Previous main update failed/u);
      assert.equal((await runReleaseCommand(["status", "--root", root])).current, a);
      unlinkSync(path.join(root, "failed-update.json"));
      write(path.join(root, ".deployment-lock"), `${process.pid}\n`);
      await assert.rejects(runReleaseCommand(["switch", "--revision", b, ...target]), { code: "EEXIST" });
      assert.equal(existsSync(path.join(root, ".deployment-lock")), true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
