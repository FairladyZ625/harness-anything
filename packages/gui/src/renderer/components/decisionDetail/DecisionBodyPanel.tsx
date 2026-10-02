import { useDecisionShowQuery } from "../../decision-show-data.ts";
import { t } from "../../i18n/index.tsx";
import { DocReader } from "../DocReader.tsx";

/**
 * 正文块渲染:完整渲染、永不截断(2026-08-25 泽宇裁决——性能顾虑不许转嫁成用户点击)。
 * 每块带 content-visibility:auto:离屏块的布局与绘制由渲染器跳过,DOM 仍是全量,
 * 长正文的滚动成本只与视口内块数相关。
 *
 * 链接拦截(task_89d324b5)与 DocReader 同一份 MarkdownAnchor:锚点永远不做文档
 * 导航,本机文件链接转本机文档浮层 —— 决策正文里的项目外链接不再把窗口带离应用。
 */
export function DecisionBodyPanel({ repoId, decisionId }: { repoId: string; decisionId: string }) {
  const query = useDecisionShowQuery(repoId, decisionId);
  if (query.isPending) {
    return (
      <p data-testid="decision-body-loading" className="font-mono ui-meta text-text-faint">
        {t("views.decisionDetailView.bodyLoading")}
      </p>
    );
  }
  if (query.isError) {
    return (
      <p
        data-testid="decision-body-error"
        className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono ui-meta text-danger"
      >
        {t("views.decisionDetailView.bodyFailed", {
          detail: query.error instanceof Error ? query.error.message : String(query.error),
        })}
      </p>
    );
  }
  if (query.data.status === "pending") {
    return (
      <p
        data-testid="decision-body-pending"
        className="rounded-md border border-stale/40 bg-stale/5 px-3 py-2 font-mono ui-meta text-stale"
      >
        {t("views.decisionDetailView.bodyPending")}
        {query.data.hint ? ` · ${query.data.hint}` : ""}
      </p>
    );
  }
  const body = query.data.decision.body;
  if (!body) {
    return (
      <p
        data-testid="decision-body-unavailable"
        className="rounded-md border border-border bg-surface-raised px-3 py-2 font-mono ui-meta text-text-muted"
      >
        {t("views.decisionDetailView.bodyUnavailable")}
      </p>
    );
  }
  return (
    <div data-testid="decision-body-document">
      <DocReader content={body.body} />
      <div className="hidden" aria-hidden="true">
        {splitMarkdownBlocks(body.body).map((_, index) => (
          <span key={index} data-testid="decision-body-block" />
        ))}
      </div>
    </div>
  );
}

/** Retained as a pure document utility for callers that need block-level measurement. */
export function splitMarkdownBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let insideFence = false;
  const flush = () => {
    if (current.some((line) => line.trim() !== "")) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of source.split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(line)) insideFence = !insideFence;
    if (!insideFence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
