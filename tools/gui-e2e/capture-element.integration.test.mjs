// harness-test-tier: integration
// 元素取景截图工具的阴性/阳性对照(任务验收契约):
//   阴性——不在视口内 / display:none / 选择器无匹配:非零退出等价(抛错)、不落图;
//   阳性——正常元素:出图且 clip 内含该元素(PNG 尺寸 ≈ clip)。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveE2EProbeElectronForTest } from "../e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import { runElementCaptureSession } from "./capture-element.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

function readPngSize(file) {
  const buffer = readFileSync(file);
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test(
  "element capture frames the target and refuses invisible or off-screen targets",
  { timeout: 300_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-gui-capture-element-",
      daemonId: "gui-capture-element",
      repoId: "gui-capture-element",
      task: { taskId: "task-gui-capture-element", title: "Element capture evidence tool" },
    });
    t.after(fixture.stop);
    const isolatedEnv = { ...runtime.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
    delete isolatedEnv.HARNESS_EXECUTION_CREDENTIAL;
    const outDir = mkdtempSync(path.join(tmpdir(), "capture-element-it-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    await runElementCaptureSession(
      {
        codeTree: workspaceRoot,
        env: isolatedEnv,
        out: outDir,
        route: "/component-catalog.html",
        pad: 24,
        height: 900,
        settleTimeoutMs: 20_000,
      },
      async (session) => {
        const combo = { theme: "dark", width: 1440, reduced: false };
        await session.applyCombo(combo);
        const dir = session.comboDir(combo);

        // 阳性:catalog 取代链(真实组件),出图且 PNG 尺寸与 clip 一致。
        const shot = await session.framedShot(
          { selector: '[data-testid="catalog-supersede-chain"]', name: "pos-chain" },
          dir,
        );
        assert.ok(existsSync(shot.file), "positive shot must be written");
        assert.ok(shot.paintedRatio > 0.99, "an unclipped target must paint in full");
        assert.ok(shot.elementPx[0] > 0 && shot.elementPx[1] > 0);
        const png = readPngSize(shot.file);
        assert.ok(
          Math.abs(png.width - shot.clipPx[0]) <= 3 && Math.abs(png.height - shot.clipPx[1]) <= 3,
          `PNG ${png.width}x${png.height} must match clip ${shot.clipPx.join("x")}`,
        );

        // 阳性(被裁剪目标):prose 比文档 Region 滚动口高,只框实际画得出的切片。
        const clipped = await session.framedShot(
          { selector: '[data-testid="catalog-documents"] .prose-harness', name: "pos-clipped" },
          dir,
        );
        assert.ok(existsSync(clipped.file));
        assert.ok(
          clipped.paintedRatio > 0 && clipped.paintedRatio < 0.99,
          "clipped target must record a partial slice",
        );
        assert.ok(clipped.paintedPx[1] < clipped.elementPx[1], "painted slice must be shorter than the raw bbox");

        // 同一会话注入阴性探针,逐类断言:抛错 + 不留图。
        await session.page.evaluate(() => {
          globalThis.document.body.insertAdjacentHTML(
            "beforeend",
            `<div data-testid="probe-hidden" style="display:none;width:120px;height:60px;">probe-hidden</div>
             <div data-testid="probe-offscreen" style="position:fixed;top:-9999px;left:0;width:120px;height:60px;">probe-offscreen</div>`,
          );
        });
        const negatives = [
          { selector: '[data-testid="probe-hidden"]', name: "neg-hidden", error: /隐藏链/ },
          { selector: '[data-testid="probe-offscreen"]', name: "neg-offscreen", error: /没有可拍内容/ },
          { selector: "#no-such-element-anywhere", name: "neg-missing", error: /未匹配/ },
        ];
        for (const target of negatives) {
          await assert.rejects(() => session.framedShot({ ...target, settleTimeoutMs: 300 }, dir), target.error);
          assert.equal(existsSync(path.join(dir, `${target.name}.png`)), false, `${target.name} must leave no image`);
        }

        // 主应用路由 + 侧栏导航 + 亮色/窄窗矩阵组合(隐藏窗口下取景)。
        const appCombo = { theme: "light", width: 1120, reduced: false };
        await session.applyCombo(appCombo, "/");
        await session.navTo(/^(?:总览|Overview)$/u);
        const appShot = await session.framedShot(
          { selector: '[data-testid="app-sidebar"]', name: "pos-sidebar" },
          session.comboDir(appCombo),
        );
        assert.ok(existsSync(appShot.file));
        assert.ok(appShot.elementPx[0] > 100, "sidebar must have real width");
      },
    );
  },
);
