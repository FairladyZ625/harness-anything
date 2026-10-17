#!/usr/bin/env node
// One-click reproducible performance baseline for CLI, daemon, kernel, and GUI. Every arm runs on
// throwaway fixtures (temp user roots + temp repos); the owner's resident daemon and the three
// edge VMs are never touched. Output: <out>/baseline.json (machine) + <out>/baseline.md (the
// baseline document, with the exact commands, sample counts, and host conditions embedded).
//
//   node tools/perf/baseline-suite.mjs --out <dir>                       # all arms
//   node tools/perf/baseline-suite.mjs --out <dir> --arms cli,daemon     # subset
//   node tools/perf/baseline-suite.mjs --out <dir> --sizes 1000,10000,100000
//
// Requires the compiled CLI (npm run build -w @harness-anything/cli). The kernel arm reuses
// tools/scale/b5-real.mjs; the cli arm reuses tools/measure-cli-command-timing.mjs; the gui arm
// reuses the gui-e2e hidden-window driver.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostSnapshot } from "./baseline-stats.mjs";
import { runCliArm } from "./baseline-cli-arm.mjs";
import { runDaemonArm } from "./baseline-daemon-arm.mjs";
import { DEFAULT_KERNEL_SIZES, runKernelArm } from "./baseline-kernel-arm.mjs";
import { runGuiArm } from "./baseline-gui-arm.mjs";

const ARM_FACTORIES = {
  cli: runCliArm,
  daemon: runDaemonArm,
  kernel: runKernelArm,
  gui: runGuiArm,
};

export function parseArgs(argv) {
  const options = {
    arms: Object.keys(ARM_FACTORIES),
    out: null,
    rootDir: null,
    coldCycles: 5,
    docSamples: 10,
    readRounds: 10,
    writeRounds: 8,
    rounds: null,
    samples: null,
    sizes: DEFAULT_KERNEL_SIZES,
    seed: 20261018,
    idleMs: 10_000,
    guiIdleMs: 30_000,
    navSamples: 8,
    guiNoBuild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const need = () => {
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === "--arms")
      options.arms = need()
        .split(",")
        .map((arm) => arm.trim())
        .filter(Boolean);
    else if (flag === "--out") options.out = need();
    else if (flag === "--root") options.rootDir = path.resolve(need());
    else if (flag === "--cold-cycles") options.coldCycles = positiveInt(need(), flag);
    else if (flag === "--doc-samples") options.docSamples = positiveInt(need(), flag);
    else if (flag === "--read-rounds") options.readRounds = positiveInt(need(), flag);
    else if (flag === "--write-rounds") options.writeRounds = positiveInt(need(), flag);
    else if (flag === "--rounds") options.rounds = positiveInt(need(), flag);
    else if (flag === "--samples") options.samples = positiveInt(need(), flag);
    else if (flag === "--sizes")
      options.sizes = need()
        .split(",")
        .map((size) => positiveInt(size.trim(), flag));
    else if (flag === "--seed") options.seed = positiveInt(need(), flag);
    else if (flag === "--idle-ms") options.idleMs = positiveInt(need(), flag);
    else if (flag === "--gui-idle-ms") options.guiIdleMs = positiveInt(need(), flag);
    else if (flag === "--nav-samples") options.navSamples = positiveInt(need(), flag);
    else if (flag === "--gui-no-build") options.guiNoBuild = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const arm of options.arms)
    if (!ARM_FACTORIES[arm]) throw new Error(`unknown arm: ${arm} (known: ${Object.keys(ARM_FACTORIES).join(", ")})`);
  if (options.arms.length === 0) throw new Error("at least one arm is required");
  if (!options.out) throw new Error("--out <dir> is required");
  return options;
}

function positiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export async function runSuite(options) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outDir = path.resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  const runRoot = path.join(outDir, "gui-run");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const sha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceStatus = execFileSync("git", ["-C", rootDir, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const logLine = (line) => process.stdout.write(`${line}\n`);
  const report = {
    schema: "perf-baseline-suite/v1",
    measuredAt: new Date().toISOString(),
    basisRevision: sha,
    sourceState: { dirty: sourceStatus.length > 0, status: sourceStatus },
    host: hostSnapshot(),
    parameters: {
      arms: options.arms,
      coldCycles: options.coldCycles,
      docSamples: options.docSamples,
      readRounds: options.readRounds,
      writeRounds: options.writeRounds,
      cliTiming: { rounds: options.rounds, samplesPerRound: options.samples },
      kernelSizes: options.sizes,
      kernelSeed: options.seed,
      daemonIdleMs: options.idleMs,
      guiIdleMs: options.guiIdleMs,
      navSamples: options.navSamples,
    },
    reproduction: {
      build: "npm run build -w @harness-anything/cli",
      command: `node tools/perf/baseline-suite.mjs --out <dir> --arms ${options.arms.join(",")} --cold-cycles ${options.coldCycles} --read-rounds ${options.readRounds} --write-rounds ${options.writeRounds} --sizes ${options.sizes.join(",")}`,
      arms: {
        cli: "source-entry CLI (packages/cli/src/index.ts) on a fake-realm fixture: ha init + resident daemon; cold cycles stop the daemon and time the first command; compiled per-command ratios come from tools/gates/cli-command-timing.json (nightly lane)",
        daemon:
          "source-entry daemon on a throwaway user root (fake realm) with tools/perf/daemon-eventloop-probe.mjs preloaded; sequential RPC reads, durable fact writes, ps RSS, event-loop histogram",
        kernel:
          "tools/scale/b5-real.mjs per size: synthesized canonical ledger, real projection cold catch-up, real read-model sampling",
        gui: "gui-e2e hidden-window driver over the disposable resident-daemon fixture; startup, idle ps sampling, view-switch latency",
      },
    },
  };
  if (options.arms.includes("cli"))
    report.cli = await runCliArm({
      rootDir,
      outDir,
      coldCycles: options.coldCycles,
      docSamples: options.docSamples,
      rounds: options.rounds,
      samples: options.samples,
      log: logLine,
    });
  if (options.arms.includes("daemon"))
    report.daemon = await runDaemonArm({
      rootDir,
      outDir,
      readRounds: options.readRounds,
      writeRounds: options.writeRounds,
      idleMs: options.idleMs,
      log: logLine,
    });
  if (options.arms.includes("kernel"))
    report.kernel = await runKernelArm({ rootDir, outDir, sizes: options.sizes, seed: options.seed, log: logLine });
  if (options.arms.includes("gui"))
    report.gui = await runGuiArm({
      rootDir,
      runRoot,
      idleMs: options.guiIdleMs,
      navSamples: options.navSamples,
      noBuild: options.guiNoBuild,
      log: logLine,
    });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(path.join(outDir, "baseline.json"), json, "utf8");
  writeFileSync(path.join(outDir, "baseline.md"), renderMarkdown(report), "utf8");
  logLine(`baseline=${path.join(outDir, "baseline.json")}`);
  logLine(`document=${path.join(outDir, "baseline.md")}`);
  return report;
}

export function renderMarkdown(report) {
  const ms2 = (value) => (Number.isFinite(value) ? (Math.round(value * 100) / 100).toFixed(2) : "—");
  const lines = [
    "# 性能基线（CLI · daemon · kernel · GUI）",
    "",
    `- 测量时间：${report.measuredAt}；基线 revision：\`${report.basisRevision}\`；源码状态：${report.sourceState.dirty ? `dirty（${report.sourceState.status.join(", ")}）` : "clean"}。`,
    `- 主机：${[report.host.cpuModel, `${report.host.parallelism} 并行度`, `${report.host.totalMemMib} MiB`, report.host.platform, report.host.arch, report.host.node].filter(Boolean).join(" · ")}。`,
    `- 复跑：先 \`${report.reproduction.build}\`，再 \`${report.reproduction.command}\`。各臂口径：`,
    ...Object.entries(report.reproduction.arms).map(([arm, shape]) => `  - ${arm}: ${shape}`),
    "",
  ];
  if (report.cli) {
    lines.push("## CLI", "", `入口口径：${report.cli.cliEntry}`, "");
    if (report.cli.warm.measurement.ran) {
      lines.push(
        "| 命令 | total p50 | total p95 | 相对 --help 比值 | daemon 侧 p50 | CLI 本地 p50 |",
        "|---|---:|---:|---:|---:|---:|",
      );
      for (const [id, row] of Object.entries(report.cli.warm.measurement.commands)) {
        if (id === "compiled-cli-help-noop") continue;
        lines.push(
          `| ${id} | ${row.totalMs.p50Ms} | ${row.totalMs.p95Ms} | ${row.ratio ? `${row.ratio.p50}x` : "—"} | ${row.daemonHandlerMs ? row.daemonHandlerMs.p50Ms : "—"} | ${row.localMs ? row.localMs.p50Ms : "—"} |`,
        );
      }
    } else {
      lines.push(
        `- 编译 CLI 逐命令计时未在本机运行：${report.cli.warm.measurement.reason}。`,
        `- 已提交的比值 ratchet（\`${report.cli.warm.committedRatchet.source}\`，basis \`${report.cli.warm.committedRatchet.basisRevision}\`）的现值：`,
        ...Object.entries(report.cli.warm.committedRatchet.limits).map(
          ([id, limit]) =>
            `  - ${id}: ≤ ${limit.maxTotalRatio ?? limit.totalRatio}x（最近实测 p50 比值 ${limit.observedP50 ?? "—"}）`,
        ),
      );
    }
    lines.push(
      "",
      `- 冷启动（${report.cli.coldStart.cycles} 轮 daemon stop → 首命令）：冷 p50 ${report.cli.coldStart.coldWallMs.p50Ms} ms / p95 ${report.cli.coldStart.coldWallMs.p95Ms} ms；同命令热对照 p50 ${report.cli.coldStart.warmControlWallMs.p50Ms} ms；CLI 报告的 daemonRoundTrip 相位 p50 ${report.cli.coldStart.coldDaemonRoundTripMs.p50Ms} ms；日志 repo_attach_completed p50 ${report.cli.coldStart.attachP50Ms} ms（样本 ${report.cli.coldStart.attachDurationMsFromLog.length}）。`,
      "",
    );
    lines.push(
      report.cli.docShow.measured
        ? `- doc show（${report.cli.docShow.samples} 次热样本，${report.cli.docShow.path}）：p50 ${report.cli.docShow.wallMs.p50Ms} ms / p95 ${report.cli.docShow.wallMs.p95Ms} ms。`
        : `- doc show：未测得（${report.cli.docShow.reason}）。`,
      `- task ci：${report.cli.taskCi.reason}。`,
      "",
    );
  }
  if (report.daemon) {
    lines.push("## daemon（独立实例）", "");
    lines.push(
      `- 冷启动：spawn → socket 可答 ${report.daemon.socketReadyMs} ms；随后真实 ha init 注册并附上仓库后 ${report.daemon.coldBootMs} ms（空 user-root 首启，非缓存复启）。`,
      "",
    );
    lines.push(
      "| 方法 | 样本 | 客户端 p50 | 客户端 p95 | 服务端 serviceMs p50 | 服务端 p95 |",
      "|---|---:|---:|---:|---:|---:|",
    );
    for (const [method, row] of Object.entries(report.daemon.reads.clientWallMs)) {
      const server = report.daemon.reads.serverServiceMs[method];
      lines.push(
        `| ${method}（读） | ${row.count} | ${row.p50Ms} | ${row.p95Ms} | ${server ? server.p50Ms : "—"} | ${server ? server.p95Ms : "—"} |`,
      );
    }
    const writeClient = report.daemon.writes.clientWallMs;
    const writeServer = report.daemon.writes.serverServiceMs;
    lines.push(
      `| repo.task.run fact-record（写） | ${writeClient.count} | ${writeClient.p50Ms} | ${writeClient.p95Ms} | ${writeServer ? writeServer.p50Ms : "—"} | ${writeServer ? writeServer.p95Ms : "—"} |`,
      "",
      `- 常驻内存：空闲 ps RSS p50 ${report.daemon.memory.idleRssMib.p50Ms} MiB；负载期 ps RSS p50 ${report.daemon.memory.loadRssMib.p50Ms} MiB；daemon 内报告 RSS 空闲 ${report.daemon.memory.inDaemonIdleRssMib ?? "—"} MiB / 负载 ${report.daemon.memory.inDaemonLoadRssMib ?? "—"} MiB。`,
      `- 事件循环延迟（探针 2s 直方图）：空闲 p95 ${report.daemon.eventLoopDelay.idle?.delayP95Ms ?? "—"} ms / max ${report.daemon.eventLoopDelay.idle?.delayMaxMs ?? "—"} ms；负载 p95 ${report.daemon.eventLoopDelay.load?.delayP95Ms ?? "—"} ms / max ${report.daemon.eventLoopDelay.load?.delayMaxMs ?? "—"} ms（解析失败行 ${report.daemon.eventLoopParseErrors}）。`,
      "",
    );
  }
  if (report.kernel) {
    lines.push("## kernel（规模曲线）", "");
    lines.push(`种子 ${report.kernel.seed}；每规模一轮账本构建 + 投影冷追平 + 每查询 10 次采样（b5-real 口径）。`, "");
    lines.push(
      "| 规模（tasks） | events | 账本构建 ms | 投影冷追平 ms | taskList p50 | singleTask p50 | factSearch p50 | relationGraph p50 |",
      "|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const run of report.kernel.runs) {
      lines.push(
        `| ${run.entities.toLocaleString()} | ${run.events.toLocaleString()} | ${run.ledgerBuildMs} | ${run.catchUpMs} | ${ms2(run.reads.taskList?.p50Ms)} | ${ms2(run.reads.singleTaskRead?.p50Ms)} | ${ms2(run.reads.factSearch?.p50Ms)} | ${ms2(run.reads.relationGraph?.p50Ms)} |`,
      );
    }
    lines.push("");
  }
  if (report.gui) {
    lines.push("## GUI（隐藏窗口 lane）", "");
    lines.push(
      `- 启动：launch → 首窗口就绪 ${report.gui.startup.windowReadyMs} ms；→ 总览首个可用内容 ${report.gui.startup.firstUsableMs} ms。`,
      `- 空闲（${report.gui.idle.windowMs / 1000}s，${report.gui.idle.processCount} 进程）：主进程 RSS p50 ${report.gui.idle.mainRssMib.p50Ms} MiB；进程树 RSS p50 ${report.gui.idle.treeRssMib.p50Ms} MiB；进程树 CPU p50 ${report.gui.idle.treeCpuPercent.p50Ms}%（${report.gui.idle.cpuNote}；尾段 p50 ${report.gui.idle.trailingTreeCpuPercent.p50Ms ?? "—"}%）。`,
      `- GPU：${report.gui.gpu.reason}。`,
      "",
      "| 视图 | 样本 | 切换 p50 | 切换 p95 |",
      "|---|---:|---:|---:|",
    );
    for (const [label, row] of Object.entries(report.gui.viewSwitchMs))
      lines.push(`| ${label} | ${row.count} | ${row.p50Ms} | ${row.p95Ms} |`);
    lines.push("");
  }
  lines.push(
    "## 未覆盖（unverified）",
    "",
    "- GUI 桌面 GPU 占用（隐藏窗口 lane 禁 GPU）。",
    "- `ha task ci` 的 PR-present 路径（夹具无法持有派工 GitHub 凭据）。",
    "- 边缘复制链路与中心/边缘生产 daemon 的资源占用（本基线只在独立实例上测；生产观测沿用工作线 Context 里的单机单时点数字）。",
    "- 主从复制 10/50/100 边缘压测（父工作线已立独立任务）。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await runSuite(options);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await main();
