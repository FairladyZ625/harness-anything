// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startGuiResidentDaemonFixture } from "../../gui/test-support/resident-daemon.mjs";
import { seedBuiltinSidebar } from "../../../tools/gui-e2e/scenarios/builtin-sidebar-seed.mjs";

test("ha task list marks declared and derived Work and filters a page without changing its cursor", async (context) => {
  const fixture = await startGuiResidentDaemonFixture({
    identityProvider: "builtin",
    prefix: "ha-work-task-list-",
    task: { taskId: "task-derived-work", title: "Derived work fixture" },
  });
  context.after(() => fixture.stop());
  const { workId } = await seedBuiltinSidebar(fixture);
  const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
  const run = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "--root", fixture.rootDir, ...args], {
      cwd: fixture.rootDir,
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_"))),
        ...fixture.env,
        HARNESS_DAEMON_ENDPOINT: fixture.endpoint,
      },
    });
    return stdout;
  };
  await run("task", "create", "--title", "Derived child fixture", "--work", "task-derived-work");
  const listed = await run("task", "list", "--status", "planned");
  assert.match(listed, /\[work\] Builtin owner work/u);
  assert.match(listed, /\[work\] Derived work fixture/u);
  assert.match(listed, /\tplanned\tDerived child fixture\t/u);
  const unfiltered = JSON.parse(await run("task", "list", "--json"));
  assert.equal(unfiltered.rows.find((row: { taskId: string }) => row.taskId === workId)?.title, "Builtin owner work");
  const filtered = JSON.parse(await run("task", "list", "--tasks-only", "--json"));
  assert.equal(filtered.count, 2);
  assert.deepEqual(filtered.rows.map((row: { title: string }) => row.title).sort(), [
    "Builtin child task",
    "Derived child fixture",
  ]);
  assert.deepEqual(JSON.parse(filtered.evidence).rows, filtered.rows);
  const page = JSON.parse(await run("task", "list", "--limit", "1", "--json"));
  const taskPage = JSON.parse(await run("task", "list", "--limit", "1", "--tasks-only", "--json"));
  assert.equal(typeof page.page.nextCursor, "string");
  assert.deepEqual(taskPage.page, page.page);
  assert.match(await run("task", "list", "--help"), /--tasks-only/u);

  await run("task", "move", workId, "--parent", "task-derived-work");
  const subtree = ["task", "list", "--parent", "task-derived-work", "--depth", "all"];
  assert.match(
    await run(...subtree),
    /\[planned\] \[work\] Builtin owner work\n {2}\S+ \[planned\] Builtin child task/u,
  );
  const tree = JSON.parse(await run(...subtree, "--tasks-only", "--json"));
  assert.equal(tree.mode, "tree");
  assert.equal(tree.count, 2);
  assert.deepEqual(tree.rows.map((row: { title: string }) => row.title).sort(), [
    "Builtin child task",
    "Derived child fixture",
  ]);
});
