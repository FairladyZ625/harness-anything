import type { NodeProps } from "@xyflow/react";
import { t } from "../../i18n/index.tsx";

/**
 * 旧 dagre 复合布局的 module group 背景。三泳道布局不再新建 moduleGroup,
 * 但保留组件以兼容历史 / 简化 ego 之外的降级路径。
 */
export function ModuleGroupNode({ data, width, height }: NodeProps) {
  return (
    <div
      className="rounded-lg relative border-2 border-dashed"
      style={{
        width,
        height,
        backgroundColor: "rgba(255, 255, 255, 0.02)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="absolute -top-6 left-0 text-[11px] font-mono text-text-muted tracking-wider">
        {t("graph.moduleGroupNode.module")} {data.label as string}
      </div>
    </div>
  );
}
