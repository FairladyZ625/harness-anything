import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeTaskEventStore, ciRunObservationWritePlan } from "@harness-anything/kernel";
import { openPersistentWriterEpoch, readLedgerWriterEpoch } from "../../../packages/daemon/src/writer-epoch.ts";
import { ciPresentationSource, ciPresentationFixture } from "./ci-observations.fixture.mjs";

export default {
  id: "ci-observations",
  feature: "ci-observations",
  lane: "isolated",
  description:
    "Shared CLI/GUI cut: failure/location, file timeout, recovery, explicit detail, missing cache, owner/claim error and center unavailable.",
  async run({ app, page, fixture, shot, runRoot }) {
    // Seed immutable CI evidence only while the disposable fixture daemon is stopped.
    await fixture.pauseDaemon();
    const authority = openPersistentWriterEpoch({
      stateRoot: path.join(fixture.userRoot, "fleet"),
      holderId: "ci-gui-fixture",
    });
    try {
      const lease = authority.acquire(fixture.repoId, readLedgerWriterEpoch(fixture.repoId, fixture.rootDir));
      const writerFence = {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: path.join(fixture.userRoot, "fleet"),
        repoId: fixture.repoId,
        holderId: lease.holderId,
        epoch: lease.epoch,
      };
      const store = makeTaskEventStore({
        rootDir: fixture.rootDir,
        repoId: fixture.repoId,
        writerFence: () => writerFence,
      });
      try {
        const source = ciPresentationSource();
        for (const entry of source.events) {
          const event = { ...entry, workspaceRevision: (store.readHead()?.revision ?? 0) + 1 };
          const ref = event.payload.detailRef,
            bytes = ref ? source.blobs.get(ref.sha256) : null;
          store.append({
            event,
            plan: ciRunObservationWritePlan(event),
            blobs: ref
              ? [
                  {
                    sha256: ref.sha256,
                    size: bytes.length,
                    mediaType: "application/json",
                    body: new TextDecoder().decode(bytes),
                  },
                ]
              : [],
          });
        }
      } finally {
        await store.drain();
      }
    } finally {
      authority.close();
    }
    await fixture.resumeDaemon();
    const cliEnv = { ...process.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
    delete cliEnv.HARNESS_EXECUTION_CREDENTIAL;
    const cliPath = path.resolve("packages/cli/src/index.ts");
    const readCli = async (fetch) => {
      const args = [
        cliPath,
        "ci",
        "observe",
        "statistics",
        "--window",
        "30",
        "--json",
        ...(fetch ? ["--fetch-details"] : []),
      ];
      const result = await promisify(execFile)(process.execPath, args, {
        cwd: fixture.rootDir,
        env: cliEnv,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      writeFileSync(path.join(runRoot, `cli-${fetch ? "cold" : "hot"}.json`), result.stdout);
      return JSON.parse(result.stdout);
    };
    const hot = await readCli(false),
      cold = await readCli(true);
    assert.equal(hot.sourceRevision, cold.sourceRevision);
    assert.equal(hot.runs.length, 3);
    assert.equal(hot.runs[0].detail, null);
    assert.equal(cold.recoveries.length, 1);
    assert.ok(cold.runs[0].detail);
    const human = await promisify(execFile)(
      process.execPath,
      [cliPath, "ci", "observe", "statistics", "--window", "30", "--fetch-details"],
      { cwd: fixture.rootDir, env: cliEnv, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    writeFileSync(path.join(runRoot, "cli-human.txt"), human.stdout);
    assert.match(human.stdout, new RegExp(`sourceRevision=${hot.sourceRevision}`));
    assert.match(human.stdout, /timeout.test.ts.*810000/u);
    assert.match(human.stdout, /attempt 1 -> 2/u);
    assert.match(human.stdout, /Full assertion stack/u);
    // Freeze exactly the CLI cut in the IPC fixture, so UI/CLI comparison cannot drift.
    // Additional error/cache states below are controlled presentation fixtures, not provider fault injection.
    await app.evaluate(
      ({ ipcMain }, values) => {
        globalThis.__ciValues = values;
        globalThis.__ciState = "shared";
        ipcMain.removeHandler("harness:getCiObservatory");
        ipcMain.handle("harness:getCiObservatory", (_event, payload) => {
          if (globalThis.__ciState === "offline")
            return {
              ok: false,
              code: "center_unreachable",
              rejectionExplanation: "center_unreachable: detail fetch is unavailable",
            };
          if (globalThis.__ciState === "missing")
            return payload.fetchDetails ? globalThis.__ciValues.fixtureCold : globalThis.__ciValues.fixtureHot;
          return payload.fetchDetails ? globalThis.__ciValues.cold : globalThis.__ciValues.hot;
        });
      },
      {
        hot,
        cold,
        fixtureHot: ciPresentationFixture(),
        fixtureCold: ciPresentationFixture({ cached: true, includeDetails: true }),
      },
    );
    const open = async () => {
      await page.reload();
      await page.getByTestId("overview-ci-alert").waitFor();
      await page.getByTestId("overview-ci-alert").click();
      await page.getByTestId("ci-selected-run").waitFor();
      await page
        .getByTestId("ci-run-list")
        .getByRole("button", { name: /202\.1/u })
        .click();
    };
    await open();
    const selected = page.getByTestId("ci-selected-run");
    assert.match(await selected.innerText(), /Expected result to equal 42/u);
    assert.match(await selected.innerText(), /fixture.test.ts:27:5/u);
    assert.match(await page.getByTestId("ci-file-outcomes").innerText(), /timeout.test.ts.*timeout.*810000/u);
    assert.equal(await page.getByTestId("ci-cold-detail").count(), 0);
    assert.match(await page.getByTestId("ci-cut").innerText(), new RegExp(String(hot.sourceRevision)));
    await shot("ci-failure-timeout-before-detail");
    await page.getByTestId("ci-fetch-details").click();
    await page.getByTestId("ci-cold-detail").waitFor();
    assert.match(await page.getByTestId("ci-cold-detail").innerText(), /Full assertion stack/u);
    assert.match(await page.getByTestId("ci-recoveries").innerText(), /1 → 2/u);
    await shot("ci-recovery-after-detail");
    const geometry = [];
    for (const [width, theme] of [
      [1440, "dark"],
      [1120, "light"],
    ]) {
      const actual = await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(width, 920);
        return window.getSize();
      }, width);
      assert.equal(actual[0], width, "acceptance must use the actual requested window width");
      await page.evaluate((theme) => globalThis.document.documentElement.setAttribute("data-theme", theme), theme);
      await page.waitForTimeout(450);
      const boxes = await page.evaluate(() => {
        const detail = globalThis.document.querySelector("[data-focus-detail]"),
          list = globalThis.document.querySelector("[data-focus-list]");
        const panel = globalThis.document.querySelector('[data-testid="ci-observation-detail"]');
        return {
          detailWidth: detail.clientWidth,
          listWidth: list.clientWidth,
          panelWidth: panel.getBoundingClientRect().width,
          detailOverflow: detail.scrollWidth > detail.clientWidth,
          cap: globalThis.getComputedStyle(panel.querySelector(".bounded-content")).maxBlockSize,
        };
      });
      assert.ok(boxes.detailWidth > boxes.listWidth, "diagnostic prose must have more width than the job list");
      assert.equal(boxes.detailOverflow, false, "long identities and stacks must not cross the detail column");
      geometry.push({ width, theme, actual, ...boxes });
      await page.keyboard.press("ArrowUp");
      assert.match(await selected.innerText(), /101\.2/u);
      await page.keyboard.press("ArrowDown");
      assert.match(await selected.innerText(), /202\.1/u);
      await shot(`ci-detail-${width}-${theme}`);
    }
    writeFileSync(path.join(runRoot, "ci-geometry.json"), JSON.stringify(geometry, null, 2) + "\n");
    await app.evaluate(() => {
      globalThis.__ciState = "missing";
    });
    await open();
    assert.match(await page.getByTestId("ci-statistics").innerText(), /pending/u);
    assert.match(await page.getByTestId("ci-detail-availability").innerText(), /not_cached/u);
    assert.match(await page.getByTestId("ci-importer").innerText(), /center.*occurrence-present.*fence-present/su);
    assert.match(await page.getByTestId("ci-importer").innerText(), /claim_fence_expired/u);
    assert.match(await page.getByTestId("ci-importer").innerText(), /HTTP 401/u);
    await shot("ci-missing-cache-claim-error");
    await page.getByTestId("ci-fetch-details").click();
    await page.getByTestId("ci-cold-detail").waitFor();
    assert.match(await page.getByTestId("ci-detail-availability").innerText(), /ready/u);
    await shot("ci-cache-ready");
    await app.evaluate(() => {
      globalThis.__ciState = "offline";
    });
    await page.getByTestId("ci-fetch-details").click();
    await page.getByTestId("ci-read-error").waitFor();
    assert.match(await page.getByTestId("ci-read-error").innerText(), /center_unreachable/u);
    await shot("ci-center-unavailable");
    writeFileSync(
      path.join(runRoot, "ci-acceptance.json"),
      JSON.stringify(
        {
          source: "real CLI command on disposable daemon, frozen same-cut DTO presented through Electron IPC",
          sourceRevision: hot.sourceRevision,
          cliRuns: hot.runs.map((run) => run.eventId),
          real: [
            "CLI JSON stdout",
            "CI accepted store events",
            "hidden Electron",
            "failure",
            "timeout",
            "recovery",
            "explicit full detail",
          ],
          controlledPresentation: [
            "edge cache missing to ready",
            "center_unreachable",
            "import owner/error/claim fence",
          ],
          backendFleetEvidence: "packages/daemon/test/ci-rerun-fleet.integration.test.ts",
        },
        null,
        2,
      ) + "\n",
    );
  },
};
