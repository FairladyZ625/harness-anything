import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 正文块渲染:完整渲染、永不截断(2026-08-25 泽宇裁决——性能顾虑不许转嫁成用户点击)。
 * 每块带 content-visibility:auto:离屏块的布局与绘制由渲染器跳过,DOM 仍是全量,
 * 长正文的滚动成本只与视口内块数相关。
 */
const BLOCK_CLASS = "[contain-intrinsic-size:auto_5rem] [content-visibility:auto]";

export function DecisionBodyPanel({ repoId, decisionId }: { repoId: string; decisionId: string }) {
  const query = useQuery({
    queryKey: ["decision-body", repoId, decisionId],
    queryFn: () => harnessClient.showDecision({ repoId, decisionId, includeBody: true }),
    enabled: decisionId !== "",
    staleTime: 10_000,
  });
  if (query.isPending) {
    return (
      <p data-testid="decision-body-loading" className="font-mono text-[12px] text-text-faint">
        {t("views.decisionDetailView.bodyLoading")}
      </p>
    );
  }
  if (query.isError) {
    return (
      <p
        data-testid="decision-body-error"
        className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] text-danger"
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
        className="rounded-md border border-stale/40 bg-stale/5 px-3 py-2 font-mono text-[12px] text-stale"
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
        className="rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[12px] text-text-muted"
      >
        {t("views.decisionDetailView.bodyUnavailable")}
      </p>
    );
  }
  return <DecisionBodyDocument source={body.body} />;
}

function DecisionBodyDocument({ source }: { source: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(source), [source]);
  return (
    <div data-testid="decision-body-document">
      <div className="prose-harness">
        {blocks.map((block, index) => (
          <div key={index} data-testid="decision-body-block" className={BLOCK_CLASS}>
            <Markdown remarkPlugins={[remarkGfm]}>{block}</Markdown>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 把 Markdown 正文切成顶层块(空行分界),围栏代码块内的空行不切,
 * 纯空白的段不产生块。块是渲染与测量的单位,渲染不再分批。
 */
export function splitMarkdownBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [],
    insideFence = false;
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
