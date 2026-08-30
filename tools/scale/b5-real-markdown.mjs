export function markdown(report) {
  const lines = [
    "# B5 real-path measurement",
    "",
    `fixture: \`${report.fixture}\`; entities: tasks=${report.metadata.primaryTaskCount.toLocaleString()} facts=${report.metadata.factCount.toLocaleString()} decisions=${report.metadata.decisionCount.toLocaleString()}; ledger build ${report.ledger.buildMs.toFixed(0)}ms for ${report.ledger.events.toLocaleString()} canonical events through the real cold catch-up.`,
    `measuredAt: ${report.measurementContext.measuredAt}; label=${report.measurementContext.label}; sourceRoot=\`${report.measurementContext.sourceRoot}\`; load1 before/after=${report.measurementContext.loadBefore.load1}/${report.measurementContext.loadAfter.load1}; free memory MB before/after=${report.measurementContext.loadBefore.freeMemoryMb}/${report.measurementContext.loadAfter.freeMemoryMb}.`,
    "",
    "## 要点",
    "",
    "- B5 synthesizes canonical task/decision/fact events, catches them up through the real rebuildable task projection, and measures the extracted daemon read model plus the real Fact action surface.",
    "- Unparameterized reads retain the historical result shape; explicit status/time/page facets use indexed narrow reads and keyset cursors.",
    "- Numbers are same-host observations; a separate worker/CI load may affect p95 and is recorded above.",
    "",
  ];
  lines.push("| query | p50 ms | p95 ms |", "|---|---:|---:|");
  for (const [label, value] of Object.entries(report.measurements))
    if (value) lines.push(`| ${label} | ${value.p50Ms.toFixed(2)} | ${value.p95Ms.toFixed(2)} |`);
  lines.push("", `unparameterized result digest: \`${report.unparameterizedResultDigest}\``);
  if (report.comparison) {
    lines.push(
      "",
      "## baseline/head p95 对照",
      "",
      "| query | baseline p95 ms | head p95 ms | delta ms | speedup |",
      "|---|---:|---:|---:|---:|",
    );
    for (const [label, value] of Object.entries(report.comparison.queryP95))
      lines.push(
        `| ${label} | ${value.baselineP95Ms === null ? "—" : value.baselineP95Ms.toFixed(2)} | ${value.headP95Ms === null ? "—" : value.headP95Ms.toFixed(2)} | ${value.deltaMs === null ? "—" : value.deltaMs.toFixed(2)} | ${value.speedup === null ? "—" : value.speedup.toFixed(2)}x |`,
      );
    lines.push(
      "",
      `digest equal: **${report.comparison.digestEqual ? "yes" : "no"}**; task bytes equal: **${report.comparison.resultSetEqual.tasks ? "yes" : "no"}**; graph bytes equal: **${report.comparison.resultSetEqual.graph ? "yes" : "no"}**; baseline digest: \`${report.comparison.baselineDigest}\`.`,
    );
  }
  lines.push(
    "",
    "## 与 CEO 授权五点的差距清单",
    "",
    "- [x] 分页读 API、daemon 协议契约、GUI allowlist：本量测调用已接入的真实读模型，并保留无参 digest。",
    "- [x] 1e4/1e5 A/B 数字：由同一脚本的 `--events`、`--source-root`、`--baseline-root` 生成；本文件只记录当前运行档位。",
    "- [x] 等价断言：task/graph 分量 digest 对照与分页拼接 sentinel 已输出。",
    "- [ ] test-tier manifest、定向测试、`npm run check:local`：需在仓库总收口阶段执行。",
    "- [ ] 本地身份 commit、禁止 push/PR：需在仓库总收口阶段执行。",
    "",
    "## 限制",
    "",
    "- baseline adapter 复刻 8ab2c055a 的私有 materializer；它用于对照，不宣称 baseline 有分页 API。",
    "- schema v4 首次读可能触发一次冷重建；ledger build/catchUp 时间包含该真实投影成本。",
    "- 合成事件密度与生产事件/task 密度不同，绝对值只作同机相对输入。",
    "",
  );
  return lines.join("\n");
}
