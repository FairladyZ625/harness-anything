/* global document */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import electronPath from "electron";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { canonicalEventWritePlan } from "../../kernel/src/index.ts";
import { makeTaskEventStore, openPersistentWriterEpoch, readLedgerWriterEpoch } from "../../storage/src/index.ts";
import { startGuiDriver } from "../../../tools/gui-e2e/driver.mjs";
import { openProject } from "../../../tools/gui-e2e/capture-nav.mjs";
import { bridgeReady } from "../../../tools/gui-e2e/scenarios/helpers.mjs";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

/**
 * issue #4267 的入口/UI 回归:同一个 Electron 主进程,旧根被删,再 `ha gui --root <new>`
 * (第二实例经 requestSingleInstanceLock additionalData 把根送达持锁进程),断言新窗口的
 * 标题/切换器与台账桥、在跑的任务、工作简报都落在新仓;随后在窗口内切到第三个仓再断言。
 *
 * 三块面板各用不同仓的真实数据:工作简报显示该仓的工作根标题,台账桥显示 revision,
 * 「在跑」区域与其它读面共用 repo-scoped 请求;旧仓的工作根标题不得出现在新窗口。
 */

const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;
const OLD_REPO = "gui-stale-old";
const OLD_PROJECT = "repo";
const NEW_REPO = "gui-stale-new";
const NEW_PROJECT = "repo-new";
const THIRD_REPO = "gui-stale-third";
const THIRD_PROJECT = "repo-third";

async function createTask(endpoint, repoId, taskId, title, parentTaskId) {
  const created = await requestDaemonJsonRpcAt(
    endpoint,
    "repo.task.create",
    { repo: { repoId }, payload: { taskId, title, ...(parentTaskId ? { parentTaskId } : {}) } },
    5_000,
    30_000,
  );
  assert.equal(created.ok, true, `create ${taskId} in ${repoId}: ${JSON.stringify(created).slice(0, 300)}`);
  return String(created.packagePath ?? "");
}

async function createWorkRoot(endpoint, repoId, rootTaskId, rootTitle, childTaskId, childTitle) {
  await createTask(endpoint, repoId, rootTaskId, rootTitle);
  await createTask(endpoint, repoId, childTaskId, childTitle, rootTaskId);
}

/**
 * Seed a live, task-bound runtime lane while the resident daemon is stopped. The GUI's
 * 「在跑的任务」 reads the same canonical agent-runtime projection as the sessions page; a
 * dispatch/session pair bound to a task gives the region a repo-discriminating row.
 */
async function seedRunningLane({ rootDir, repoId, userRoot, taskId, executionId, title, packagePath }) {
  const stateRoot = path.join(userRoot, "fleet"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "gui-stale-root-e2e" });
  let writerFence;
  try {
    const lease = authority.acquire(repoId, readLedgerWriterEpoch(repoId, rootDir));
    writerFence = Object.freeze({
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId,
      holderId: lease.holderId,
      epoch: lease.epoch,
    });
  } finally {
    authority.close();
  }
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    digest = createHash("sha256").update(`${repoId}\0${taskId}`).digest("hex"),
    dispatchId = `dispatch_${digest.slice(0, 24)}`,
    runtimeSessionId = `runtime_${digest.slice(24, 48)}`,
    instanceId = `instance-${repoId}`,
    installationId = `installation-${repoId}`,
    startedAt = new Date().toISOString(),
    definitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId,
      installationId,
      kindId: "codex",
      providerId: "openai",
      model: "gpt-e2e",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    append = (type, payload, blobs = []) => {
      const revision = (store.readHead()?.revision ?? 0) + 1,
        opId = `stale-root-${type}-${revision}`,
        event = {
          schema: "agent-runtime-event/v1",
          eventId: `event-${opId}`,
          workspaceRevision: revision,
          opId,
          type,
          actor: { principal: { personId: "person-gui" }, executor: null },
          source: "local",
          occurredAt: startedAt,
          payload,
        };
      store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", opId), blobs });
    };
  append("runtime_dispatch_requested", {
    dispatchId,
    runtimeSessionId,
    taskId,
    executionId,
    agentId: "stale-worker",
    agentName: "Stale Worker",
    startedAt,
    instanceId,
    installationId,
    kindId: "codex",
    dispatchKey: `stale-root-${repoId}`,
    definitionSnapshotRef: `provider:definition/${repoId}`,
    definitionSnapshot,
  });
  append("runtime_session_started", {
    runtimeSessionId,
    instanceId,
    installationId,
    kindId: "codex",
    definitionSnapshotRef: `provider:definition/${repoId}`,
    launchGeneration: 1,
    attachable: false,
  });
  append("runtime_session_task_bound", {
    runtimeSessionId,
    taskId,
    executionId,
    providerSessionId: `provider-${runtimeSessionId}`,
    transcriptRef: `file:transcript/${runtimeSessionId}.log`,
  });
  await store.drain();
  if (packagePath) {
    const dispatchRoot = path.join(rootDir, "harness", packagePath, "artifacts", "dispatches");
    mkdirSync(dispatchRoot, { recursive: true });
    writeFileSync(
      path.join(dispatchRoot, `${dispatchId}.json`),
      `${JSON.stringify(
        {
          schema: "runtime-dispatch/v1",
          dispatchId,
          taskId,
          executionId,
          runtimeSessionId,
          instanceId,
          agentId: "stale-worker",
          agentName: "Stale Worker",
          startedAt,
          endedAt: startedAt,
          outcome: "running",
          provider: { instance: instanceId, model: "gpt-e2e" },
        },
        null,
        2,
      )}
`,
    );
  }
  return title;
}

async function repoSourceRevision(endpoint, repoId) {
  const result = await requestDaemonJsonRpcAt(
    endpoint,
    "repo.tasks.list",
    { repo: { repoId }, payload: {} },
    5_000,
    30_000,
  );
  assert.equal(result.ok, true, `repo.tasks.list ${repoId}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(typeof result.sourceRevision, "number");
  return result.sourceRevision;
}

async function waitForProject(page, project, expectedBrief, expectedRevision, expectedRunning, forbiddenTexts) {
  await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
  await page.waitForFunction((expected) => globalThis.document.title === expected, `${project} — Harness Anything`, {
    timeout: 20_000,
  });
  await page.getByTitle(SWITCHER_TITLE).getByText(project, { exact: true }).waitFor({ timeout: 20_000 });
  await bridgeReady(page);
  await page.getByTestId("overview-view").waitFor({ timeout: 20_000 });
  await page.getByTestId("real-task-summary").waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="real-task-summary"]');
      return element !== null && !/正在读取|Reading/u.test(element.textContent ?? "");
    },
    null,
    { timeout: 30_000 },
  );
  const briefs = page.getByTestId("overview-region-briefs");
  await briefs.waitFor({ timeout: 20_000 });
  await briefs.getByText(expectedBrief, { exact: true }).waitFor({ timeout: 20_000 });
  const running = page.getByTestId("overview-region-running");
  await running.waitFor({ timeout: 20_000 });
  await running.getByText(expectedRunning, { exact: false }).waitFor({ timeout: 20_000 });
  const ledger = page.getByTestId("real-task-summary");
  const ledgerText = (await ledger.innerText()).trim();
  const ledgerRevision = Number(/revision\s+([\d,]+)/u.exec(ledgerText)?.[1]?.replaceAll(",", "") ?? NaN);
  assert.equal(ledgerRevision, expectedRevision, `${project}: ledger bridge revision ${ledgerText}`);
  const body = await page.locator("body").innerText();
  assert.equal(body.includes("invalid_root"), false, `${project}: body contains invalid_root`);
  assert.equal(body.includes("Canonical root does not exist"), false, `${project}: body contains deleted root error`);
  for (const forbidden of forbiddenTexts)
    assert.equal(body.includes(forbidden), false, `${project}: leaked another project's data (${forbidden})`);
  return {
    title: await page.title(),
    project: (await page.getByTitle(SWITCHER_TITLE).innerText()).trim(),
    ledgerBridge: ledgerText,
    runningTasks: (await running.innerText()).trim(),
    workBriefs: (await briefs.innerText()).trim(),
  };
}

async function launchSecondInstance({ workspaceRoot, mainPath, profile, env, rootDir }) {
  const launchEnv = {
    ...env,
    ELECTRON_DISABLE_SANDBOX: "1",
    HARNESS_GUI_ROOT: rootDir,
  };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  delete launchEnv.ELECTRON_RENDERER_URL;
  const child = spawn(
    electronPath,
    [mainPath, `--user-data-dir=${profile}`, "--no-sandbox", "--headless", "--disable-gpu", "--disable-dev-shm-usage"],
    { cwd: workspaceRoot, env: launchEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  let timer;
  const exited = Promise.race([
    once(child, "exit").then(([code, signal]) => {
      clearTimeout(timer);
      return { code, signal };
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`second instance did not exit; stderr=${stderr}`));
      }, 20_000);
      timer.unref?.();
    }),
  ]);
  return { child, exited, stderr: () => stderr };
}

test(
  "same Electron process opens a new root after the old root is deleted, then switches in-window",
  { timeout: 240_000 },
  async () => {
    const workspaceRoot = path.resolve(import.meta.dirname, "../../.."),
      mainPath = path.join(workspaceRoot, "packages/gui/dist-electron/electron-main.js"),
      parent = mkdtempSync(path.join(tmpdir(), "hg-stale-root-")),
      runRoot = process.env.HARNESS_GUI_E2E_SHOTS ?? path.join(parent, "shots"),
      newRoot = path.join(parent, NEW_PROJECT),
      thirdRoot = path.join(parent, THIRD_PROJECT);
    mkdirSync(runRoot, { recursive: true });
    let fixture, driver, endpoint;
    const consoleFailures = [];
    try {
      fixture = await startGuiResidentDaemonFixture({
        prefix: "hg-stale-root-fixture-",
        daemonId: "stale-root",
        repoId: OLD_REPO,
        displayName: OLD_PROJECT,
        identityProvider: "builtin",
        task: { taskId: "task-stale-old", title: "Old root task" },
      });
      endpoint = fixture.endpoint;
      await createWorkRoot(
        endpoint,
        OLD_REPO,
        "task-stale-old-work",
        "Stale Old Work",
        "task-stale-old-child",
        "Stale Old Child",
      );

      // The extra projects are created before Electron starts; the test then selects the old
      // project in the first window, exactly the reported starting state.
      for (const [rootDir, repoId, project] of [
        [newRoot, NEW_REPO, NEW_PROJECT],
        [thirdRoot, THIRD_REPO, THIRD_PROJECT],
      ]) {
        const bootstrapped = await requestDaemonJsonRpcAt(
          endpoint,
          "daemon.repo.bootstrap",
          { rootDir, repoId, displayName: project },
          5_000,
          60_000,
        );
        assert.equal(bootstrapped.ok, true, `bootstrap ${repoId}: ${JSON.stringify(bootstrapped).slice(0, 300)}`);
      }
      await createWorkRoot(
        endpoint,
        NEW_REPO,
        "task-stale-new-work",
        "Stale New Work",
        "task-stale-new-child",
        "Stale New Child",
      );
      await createWorkRoot(
        endpoint,
        THIRD_REPO,
        "task-stale-third-work",
        "Stale Third Work",
        "task-stale-third-child",
        "Stale Third Child",
      );
      // Extra task makes the third project's ledger revision differ from the new project's,
      // so the sidebar revision is a repo-discriminating assertion, not a shared constant.
      await createTask(endpoint, THIRD_REPO, "task-stale-third-extra", "Stale Third Extra");
      const oldLanePackage = await createTask(endpoint, OLD_REPO, "task-stale-old-lane", "Stale Old Running"),
        newLanePackage = await createTask(endpoint, NEW_REPO, "task-stale-new-lane", "Stale New Running"),
        thirdLanePackage = await createTask(endpoint, THIRD_REPO, "task-stale-third-lane", "Stale Third Running");

      // Seed one live, task-bound runtime lane per project. 「在跑的任务」 then carries a
      // distinct task title per repo instead of an empty state shared by all three.
      await fixture.pauseDaemon();
      try {
        await seedRunningLane({
          rootDir: fixture.rootDir,
          repoId: OLD_REPO,
          userRoot: fixture.userRoot,
          taskId: "task-stale-old-lane",
          executionId: "exe-stale-old-lane",
          title: "Stale Old Running",
          packagePath: oldLanePackage,
        });
        await seedRunningLane({
          rootDir: newRoot,
          repoId: NEW_REPO,
          userRoot: fixture.userRoot,
          taskId: "task-stale-new-lane",
          executionId: "exe-stale-new-lane",
          title: "Stale New Running",
          packagePath: newLanePackage,
        });
        await seedRunningLane({
          rootDir: thirdRoot,
          repoId: THIRD_REPO,
          userRoot: fixture.userRoot,
          taskId: "task-stale-third-lane",
          executionId: "exe-stale-third-lane",
          title: "Stale Third Running",
          packagePath: thirdLanePackage,
        });
      } finally {
        endpoint = await fixture.resumeDaemon();
      }
      const revisions = {
        old: await repoSourceRevision(endpoint, OLD_REPO),
        new: await repoSourceRevision(endpoint, NEW_REPO),
        third: await repoSourceRevision(endpoint, THIRD_REPO),
      };
      assert.notEqual(revisions.new, revisions.third, "the new and third ledger revisions must differ");

      driver = await startGuiDriver({
        workspaceRoot,
        rootDir: fixture.rootDir,
        env: { ...process.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: endpoint },
        runRoot,
        headless: true,
        mainPath,
      });
      await driver.page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      assert.equal(await openProject({ page: driver.page }, OLD_PROJECT), OLD_PROJECT);
      // The first window is on the old project; wait until its lane and ledger read succeeded
      // before deleting the directory, so the test proves a live main process, not a dead one.
      const oldState = await waitForProject(
        driver.page,
        OLD_PROJECT,
        "Stale Old Work",
        revisions.old,
        "Stale Old Running",
        ["Stale New Work", "Stale Third Work", "Stale New Running", "Stale Third Running"],
      );
      await driver.page.screenshot({ path: path.join(runRoot, "stale-root-before-delete.png"), fullPage: true });

      rmSync(fixture.rootDir, { recursive: true, force: true });

      const second = await launchSecondInstance({
        workspaceRoot,
        mainPath,
        profile: driver.profile,
        env: { ...process.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: endpoint },
        rootDir: newRoot,
      });
      const [newPage] = await Promise.all([driver.app.waitForEvent("window", { timeout: 30_000 }), second.exited]);
      newPage.setDefaultTimeout(20_000);
      newPage.on("console", (message) => {
        if (message.type() === "error") consoleFailures.push(message.text());
      });
      newPage.on("pageerror", (error) => consoleFailures.push(error.message));
      const newState = await waitForProject(
        newPage,
        NEW_PROJECT,
        "Stale New Work",
        revisions.new,
        "Stale New Running",
        ["Stale Old Work", "Stale Third Work", "Stale Old Running", "Stale Third Running"],
      );
      await newPage.screenshot({ path: path.join(runRoot, "stale-root-second-instance.png"), fullPage: true });

      const switched = await openProject({ page: newPage }, THIRD_PROJECT);
      assert.equal(switched, THIRD_PROJECT);
      const thirdState = await waitForProject(
        newPage,
        THIRD_PROJECT,
        "Stale Third Work",
        revisions.third,
        "Stale Third Running",
        ["Stale Old Work", "Stale New Work", "Stale Old Running", "Stale New Running"],
      );
      await newPage.screenshot({ path: path.join(runRoot, "stale-root-in-window-switch.png"), fullPage: true });
      await driver.assertBackground();
      assert.deepEqual(consoleFailures, [], `new window renderer errors:\n${consoleFailures.join("\n")}`);
      writeFileSync(
        path.join(runRoot, "result.json"),
        `${JSON.stringify(
          {
            schema: "gui-stale-root-e2e/v1",
            outcome: "passed",
            mainBundle: "packages/gui/dist-electron/electron-main.js",
            oldProject: OLD_PROJECT,
            newProject: NEW_PROJECT,
            thirdProject: THIRD_PROJECT,
            secondInstanceExit: await second.exited,
            revisions,
            oldWindow: oldState,
            newWindow: newState,
            inWindowSwitch: thirdState,
            background: true,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await driver?.close();
      await fixture?.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
