import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { daemonBuildStamp } from "../../packages/daemon/src/build-identity.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  resolveLocalDaemonEndpoint,
} from "../../packages/daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import {
  currentDaemonProtocolVersion,
  daemonGuiInvokeFacets,
} from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import {
  seedSupersedeChain,
  seedTriadicEvents,
  seedTriadicReviewAwait,
  writeTriadicLedger,
} from "../../packages/gui/test-support/triadic-ledger.mjs";
import { seedScheduleRuntimeOrder } from "./scenarios/schedule-run-history.mjs";
import { seedGuiE2eRuntimeSessions, seedGuiE2eSessionTasks } from "./scenarios/sessions-grouping.mjs";
import { seedGuiE2eCollaborationTasks, seedGuiE2eCollaborationLeases } from "./scenarios/collaboration-view.mjs";
import { warmDaemonProjection } from "../e2e-probe.mjs";

// Long script-free HTML report: tall enough that a 150px-default webview clips after
// the first section, so the preview-height scenario measures real guest-side scrolling.
function writeHtmlPreviewArtifact(rootDir, packagePath) {
  const artifactsRoot = path.join(rootDir, "harness", packagePath, "artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const sections = Array.from(
    { length: 24 },
    (_, index) =>
      `<section><h2>第 ${index + 1} 段</h2><p>夜班战报第 ${index + 1} 段正文,占位三行,保证总高远超单屏。</p>` +
      `<p>第二段正文,占位,加高页面。</p></section>`,
  ).join("\n");
  writeFileSync(
    path.join(artifactsRoot, "preview-height.html"),
    `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>Preview height probe</title></head>\n` +
      `<body style="margin:0;padding:16px;font:14px/1.7 system-ui">\n<h1>Preview height probe</h1>\n` +
      `${sections}\n</body>\n</html>\n`,
  );
}

// A complete one-page PDF. The page paints a teal rectangle, allowing the GUI scenario
// to prove actual pixels arrived through the document read path, not merely metadata.
function writeRawArtifact(rootDir, packagePath) {
  const artifactsRoot = path.join(rootDir, "harness", packagePath, "artifacts", "reports");
  mkdirSync(artifactsRoot, { recursive: true });
  const stream = "0 0.55 0.58 rg 20 20 260 160 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.7\n%\xFF\xFE\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path.join(artifactsRoot, "dossier.pdf"), Buffer.from(pdf, "latin1"));
}

// A real two-sheet Chinese workbook: wide (45 columns) and tall (510 rows) on the summary
// sheet so the spreadsheet scenario proves cell values, sheet switching and two-axis
// internal scrolling through the same authorized daemon read path as any other artifact.
function writeSpreadsheetArtifact(rootDir, packagePath) {
  const artifactsRoot = path.join(rootDir, "harness", packagePath, "artifacts", "tables");
  mkdirSync(artifactsRoot, { recursive: true });
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ...Array.from({ length: 510 }, (_, row) =>
      Array.from({ length: 45 }, (_, column) => (row === 0 ? `表头${column + 1}` : `第${row + 1}行${column + 1}列`)),
    ),
  ]);
  summary["M2"] = { t: "n", v: 1280, f: "1000+280" };
  XLSX.utils.book_append_sheet(workbook, summary, "汇总");
  const detail = XLSX.utils.aoa_to_sheet([
    ["明细", "数量"],
    ["甲", 3],
    ["乙", 5],
  ]);
  XLSX.utils.book_append_sheet(workbook, detail, "明细");
  writeFileSync(path.join(artifactsRoot, "inventory.xlsx"), XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

/**
 * 声明实体的 e2e 素材:一篇 Markdown ADR。实体本身**不在这里 import**——那一步由
 * 场景在 GUI 上点「新建」完成,才证明得了 GUI 的写入口真的走 entity import。
 */
function writeDeclaredEntitySource(rootDir) {
  const adrRoot = path.join(rootDir, "docs", "adr");
  mkdirSync(adrRoot, { recursive: true });
  writeFileSync(
    path.join(adrRoot, "ADR-0001-declared-entity-probe.md"),
    "# ADR-0001 · 声明实体探针\n\n这是一篇普通 Markdown:实体只记指针,正文留在这里。\n",
  );
}

export async function openLane({ lane, workspaceRoot, env, runRoot, startDriver }) {
  if (lane === "canonical") {
    await warmDaemonProjection({ rootDir: workspaceRoot, workspaceRoot, env });
    const endpoint = resolveLocalDaemonEndpoint({
        userRoot: daemonUserRoot(env),
        daemonId: daemonIdFromEnv(env),
        env,
      }),
      hello = await requestDaemonJsonRpcAt(
        endpoint,
        "protocol.hello",
        { protocolVersion: currentDaemonProtocolVersion },
        2_000,
        5_000,
      ),
      build = hello.build;
    assertCanonicalDaemonMethods({
      daemonMethods: Array.isArray(hello.methods) ? hello.methods : [],
      requiredMethods: daemonGuiInvokeFacets.map((facet) => facet.method),
      daemonCommit: build && typeof build === "object" && !Array.isArray(build) ? build.commit : null,
      guiCommit: daemonBuildStamp().commit,
    });
    const driver = await startDriver({ workspaceRoot, rootDir: workspaceRoot, env, runRoot });
    driver.runRoot = runRoot;
    return { driver, close: () => driver.close() };
  }
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  let fixture;
  let sessionTaskPackages;
  try {
    fixture = await startGuiResidentDaemonFixture({
      prefix: "hg-",
      daemonId: "g",
      repoId: "gui-e2e-catalog",
      task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" },
      // 协作种子的指派目标账号(assign RPC 会在目录里核人,不登记则 person_not_found)。
      keycloakSetup: (keycloak) => {
        keycloak.account("person-ada");
        keycloak.account("person-bo");
      },
      afterRestart: seedTriadicReviewAwait,
      // 层次 fixture 的任务实体要在 daemon 停机前经 repo.task.create 落进投影;
      // 事件与派工归档仍在停机窗口里种(sessions-grouping 场景自持)。
      beforeStop: async (endpoint, repoId) => {
        sessionTaskPackages = await seedGuiE2eSessionTasks(endpoint, repoId);
        await seedGuiE2eCollaborationTasks(endpoint, repoId);
      },
      beforeRestart: async (rootDir, repoId, writerFence) => {
        await seedTriadicEvents(rootDir, repoId, writerFence);
        await seedScheduleRuntimeOrder(rootDir, repoId, writerFence);
        await seedSupersedeChain(rootDir, repoId, writerFence);
        await seedGuiE2eRuntimeSessions(rootDir, repoId, writerFence, sessionTaskPackages);
        await seedGuiE2eCollaborationLeases(rootDir, repoId, writerFence);
      },
    });
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  writeTriadicLedger(fixture.rootDir);
  writeHtmlPreviewArtifact(fixture.rootDir, fixture.packagePath);
  writeRawArtifact(fixture.rootDir, fixture.packagePath);
  writeSpreadsheetArtifact(fixture.rootDir, fixture.packagePath);
  writeDeclaredEntitySource(fixture.rootDir);
  // Electron 应用面对的是夹具 daemon:剥掉外层运行时注入的任务执行凭据,否则预载桥
  // 会把它附到每个请求上而被夹具 daemon 拒绝(canonical lane 面向真实 daemon,不动)。
  const isolatedEnv = { ...env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
  delete isolatedEnv.HARNESS_EXECUTION_CREDENTIAL;
  let driver;
  try {
    driver = await startDriver({
      workspaceRoot,
      rootDir: fixture.rootDir,
      env: isolatedEnv,
      runRoot,
    });
  } catch (error) {
    await fixture.stop();
    throw error;
  }
  driver.runRoot = runRoot;
  driver.fixture = fixture;
  return {
    driver,
    async close() {
      await driver.close();
      await fixture.stop();
    },
  };
}

export function assertCanonicalDaemonMethods({ daemonMethods, requiredMethods, daemonCommit, guiCommit }) {
  const advertised = new Set(daemonMethods),
    missing = requiredMethods.filter((method) => !advertised.has(method));
  if (missing.length === 0) return;
  throw Object.assign(
    new Error(
      `Canonical GUI lane requires daemon method(s) ${missing.join(", ")}; ` +
        `attached daemon build is ${daemonCommit ?? "unknown"}, GUI build is ${guiCommit ?? "unknown"}. ` +
        "Restart the resident daemon from an operator shell before running the canonical lane.",
    ),
    { code: "daemon_gui_method_drift" },
  );
}
