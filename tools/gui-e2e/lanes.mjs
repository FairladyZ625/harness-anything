import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import { seedTriadicEvents, writeTriadicLedger } from "../../packages/gui/test-support/triadic-ledger.mjs";
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
    const driver = await startDriver({ workspaceRoot, rootDir: workspaceRoot, env, runRoot });
    driver.runRoot = runRoot;
    return { driver, close: () => driver.close() };
  }
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  let fixture;
  try {
    fixture = await startGuiResidentDaemonFixture({
      prefix: "hg-",
      daemonId: "g",
      repoId: "gui-e2e-catalog",
      task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" },
      beforeRestart: seedTriadicEvents,
    });
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  writeTriadicLedger(fixture.rootDir);
  writeHtmlPreviewArtifact(fixture.rootDir, fixture.packagePath);
  writeDeclaredEntitySource(fixture.rootDir);
  const isolatedEnv = { ...env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
  const driver = await startDriver({
    workspaceRoot,
    rootDir: fixture.rootDir,
    env: isolatedEnv,
    runRoot,
  });
  driver.runRoot = runRoot;
  return {
    driver,
    async close() {
      await driver.close();
      await fixture.stop();
    },
  };
}
