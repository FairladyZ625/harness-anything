import { useId, useState } from "react";
import { Brain } from "@phosphor-icons/react";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { t } from "../../i18n/index.tsx";

/**
 * 流式思考过程折叠块(dec_C0AF8CBBFFECF71F4F34FB76F9/CH4):
 * 原位替代裸 <pre> 渲染;默认收起为单行摘要 + 字符统计,
 * 展开后展示完整思考内容与一键复制,live 态呼吸动画。
 */
export function ThinkingState({
  thinking,
  summary,
  live = false,
  defaultExpanded = false,
  testId = "session-transcript-thinking",
}: {
  readonly thinking: string;
  readonly summary?: string;
  readonly live?: boolean;
  readonly defaultExpanded?: boolean;
  readonly testId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const title = t("agentRuntime.transcriptThinking");
  const displaySummary = summary || thinking.slice(0, 80);

  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-border/80 bg-surface-raised/20">
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface"
      >
        <Brain
          weight="bold"
          size="0.875em"
          aria-hidden
          className={`shrink-0 text-text-muted ${live ? "animate-pulse text-accent" : ""}`}
        />
        <span className="shrink-0 font-mono ui-meta font-semibold text-text-muted">{title}</span>
        <span className="min-w-0 flex-1 truncate ui-meta text-text-faint">{displaySummary}</span>
        <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          role="region"
          aria-label={title}
          className="flex flex-col gap-2 border-t border-border/60 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono ui-micro tabular-nums text-text-faint">{thinking.length} chars</span>
            <CopyContextButton
              buildText={() => thinking}
              label={t("agentRuntime.copyThinking")}
              title={t("agentRuntime.copyThinkingTip")}
            />
          </div>
          <div
            data-testid={`${testId}-detail`}
            className="bounded-content overflow-auto whitespace-pre-wrap font-sans ui-meta text-text-muted [overflow-wrap:anywhere]"
          >
            {thinking}
          </div>
        </div>
      )}
    </div>
  );
}
