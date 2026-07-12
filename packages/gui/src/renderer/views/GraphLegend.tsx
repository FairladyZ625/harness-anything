/**
 * GraphView 顶部图例 + 状态栏(dec_01KXA7811SVVT8P66HNDFZQ7DF)。
 *
 * 从 GraphView.tsx 抽出来,让 GraphView 主文件回到 600 行内的复杂度门。
 * 纯展示 + 把交互提示话术随焦点状态切换。
 */

interface Props {
  visibleNodeCount: number;
  edgeCount: number;
  resolvedFocusId: string | null;
  cycleWarning: { count: number; cycles: string[][] };
  hasFocus: boolean;
}

export function GraphLegend({
  visibleNodeCount,
  edgeCount,
  resolvedFocusId,
  cycleWarning,
  hasFocus,
}: Props) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-text-muted">
      <span className="font-mono text-text-faint">
        {visibleNodeCount} 节点 · {edgeCount} 边
        {resolvedFocusId ? ` · 聚焦 ${resolvedFocusId}` : ""}
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm border"
          style={{
            borderColor: "var(--color-axis-execution)",
            background: "var(--color-surface-raised)",
          }}
        />
        task（方块·派生）
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded border" style={{ borderColor: "var(--color-accent)", background: "rgba(176,124,240,0.2)" }} />
        decision（菱形·主张+claim）
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border" style={{ borderColor: "var(--color-axis-evidence)", background: "rgba(240,162,60,0.2)" }} />
        fact（圆·证据徽章）
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="text-text-faint">coverage:</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--color-status-done)" }} /> 已佐证
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--color-danger)" }} /> 无证据
        </span>
      </span>
      {cycleWarning.count > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger"
          title={cycleWarning.cycles.map((c) => c.join(" → ")).join("\n")}
        >
          INV-3 环警告 · {cycleWarning.count}
        </span>
      )}
      <span className="ml-auto text-text-faint">
        {hasFocus
          ? "Esc / 点击空白处关抽屉 · 单击=选中 · 双击=设焦点 · 点击 claim 行展开证据 fact"
          : "默认聚焦式 ego · 左栏搜索/双击节点换焦点 (Powered by React Flow)"}
      </span>
    </header>
  );
}
