import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";

/** 长正文按块分批显形,照抄 TaskStream/DecisionPoolView 的 ROW_BATCH_SIZE 机制。 */
const BODY_BLOCK_BATCH_SIZE = 12;

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
  return <DecisionBodyDocument source={body.body} resetKey={decisionId} />;
}

function DecisionBodyDocument({ source, resetKey }: { source: string; resetKey: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(source), [source]);
  const [visible, setVisible] = useState(BODY_BLOCK_BATCH_SIZE);
  useEffect(() => {
    setVisible(BODY_BLOCK_BATCH_SIZE);
  }, [resetKey]);
  const shown = blocks.slice(0, visible),
    hidden = blocks.length - shown.length;
  return (
    <div data-testid="decision-body-document">
      <div className="prose-harness">
        {shown.map((block, index) => (
          <div key={index} data-testid="decision-body-block">
            <Markdown remarkPlugins={[remarkGfm]}>{block}</Markdown>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          data-testid="decision-body-more"
          onClick={() =>
            setVisible((count) => Math.min(count + BODY_BLOCK_BATCH_SIZE, blocks.length))
          }
          className={[
            "mt-3 w-full rounded-lg border border-dashed border-border px-4 py-2 font-mono text-[12px]",
            "text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          {t("views.decisionDetailView.bodyShowMore", {
            count: Math.min(BODY_BLOCK_BATCH_SIZE, hidden),
            remaining: hidden,
          })}
        </button>
      )}
    </div>
  );
}

/**
 * 把 Markdown 正文切成顶层块(空行分界),围栏代码块内的空行不切,
 * 纯空白的段不产生块。分批渲染的单位是块:批大小、显形按钮与剩余量上报沿用
 * TaskStream 的机制。
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
