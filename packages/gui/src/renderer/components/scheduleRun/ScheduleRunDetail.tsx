import { Badge, Chip, Empty, Hint, KV, KVRow } from "../runtime/parts.tsx";
import { SessionTranscript } from "../sessions/SessionTranscript.tsx";
import { DocReader } from "../DocReader.tsx";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import type { ScheduleGuiRowDto } from "../../../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { ScheduleGuiRunRowDto, ScheduleRunOutcomeWord } from "../../schedules-client.ts";
import { formatDurationMs, RUN_OUTCOME_META } from "./runMeta.ts";

// 单次 occurrence 的内嵌详情(M4):失败原因、内嵌会话(全轮次)、报告正文(与产物页
// 同一个 DocReader)、产出互链全部在这一页。没有的数据就是真实空态,不渲染模板句。
// 实体跳转一律走宿主注入的 entity 导航(ref 由 entityRoutes 解析)。

const RUN_TONE: Record<ScheduleRunOutcomeWord, string> = {
  running: "active",
  succeeded: "done",
  failed: "blocked",
  missed: "planned",
  cancelled: "cancelled",
  unknown: "unknown",
};

const time = (iso: string | null): string => (iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso));

/** JSON 回执(如 e2e 探针的 journey 结果)按折叠代码块原样展示,不截断。 */
export function scheduleReportIsJsonReceipt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function ScheduleRunDetail({
  repoId,
  row,
  occurrence,
  onRefetchRuns,
  onSelectEntity,
}: {
  readonly repoId: string;
  readonly row: ScheduleGuiRowDto;
  readonly occurrence: ScheduleGuiRunRowDto;
  readonly onRefetchRuns: () => void;
  /** 实体导航出口(session/fact/decision/task 引用经 entityRoutes 落各自详情页)。 */
  readonly onSelectEntity: (ref: string) => void;
}) {
  const meta = RUN_OUTCOME_META[occurrence.outcome],
    outputs = occurrence.outputs,
    outputCount = outputs.facts.length + outputs.decisions.length + outputs.tasks.length;
  return (
    <div data-testid="schedule-run-detail" className="mt-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2.5">
        <Badge status={RUN_TONE[occurrence.outcome]}>{t(meta.key)}</Badge>
        <b className="font-mono ui-body">{occurrence.occurrenceId}</b>
        {occurrence.kind !== null && <Chip tone="mono">{occurrence.kind}</Chip>}
        <span className="flex-1" />
        <Hint>
          node {occurrence.nodeId ?? "—"} · {t("schedules.fields.nextRun")} {time(occurrence.scheduledFor)} ·{" "}
          {time(occurrence.endedAt)} · {formatDurationMs(occurrence.durationMs)}
        </Hint>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-[5fr_7fr]">
        <div className="min-w-0">
          <h4 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.session.title")}
          </h4>
          {/* M4: the run session is embedded here — occurrence replay through the
              dispatch ledger, not a jump into the global Sessions view. */}
          {occurrence.dispatchId === null ? (
            <div data-testid="schedule-run-session-empty">
              <Empty>{t("schedules.run.session.noDispatch")}</Empty>
            </div>
          ) : (
            <div data-testid={`schedule-run-session-${occurrence.occurrenceId}`}>
              <SessionTranscript
                repoId={repoId}
                dispatchId={occurrence.dispatchId}
                live={occurrence.outcome === "running"}
                onSettled={onRefetchRuns}
              />
            </div>
          )}
          <KV>
            {occurrence.dispatchId !== null && (
              <KVRow name={t("schedules.fields.dispatch")}>
                {occurrence.runtimeSessionId !== null ? (
                  <button
                    type="button"
                    data-testid="schedule-run-dispatch-link"
                    onClick={() => onSelectEntity(`session/${occurrence.runtimeSessionId}`)}
                    className="font-mono ui-micro text-accent hover:underline"
                  >
                    {occurrence.dispatchId}
                  </button>
                ) : (
                  <span className="font-mono ui-micro text-text-muted">{occurrence.dispatchId}</span>
                )}
              </KVRow>
            )}
            {/* G10:会话是 Entity——转写内嵌在本页,同时 id 可点去会话页对应 runtime session。 */}
            {occurrence.runtimeSessionId !== null && (
              <KVRow name={t("schedules.fields.session")}>
                <button
                  type="button"
                  data-testid="schedule-run-session-link"
                  onClick={() => onSelectEntity(`session/${occurrence.runtimeSessionId}`)}
                  className="font-mono ui-micro text-accent hover:underline"
                >
                  {occurrence.runtimeSessionId}
                </button>
              </KVRow>
            )}
            <KVRow name={t("schedules.fields.attempt")}>
              {occurrence.attemptIndex === null ? "—" : String(occurrence.attemptIndex)}
            </KVRow>
            <KVRow name={t("schedules.fields.claimedAt")}>{time(occurrence.claimedAt)}</KVRow>
            <KVRow name={t("schedules.fields.agent")}>
              {row.target.kind === "agent" ? row.target.agentId : row.target.squadId}
            </KVRow>
          </KV>
        </div>
        <div className="min-w-0">
          {occurrence.detail !== null && (
            <section data-testid="schedule-run-failure-detail" className="mb-3">
              <h4 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-status-blocked">
                {t("schedules.run.failure.title")}
              </h4>
              <p className="rt-pre whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-danger/40 bg-status-blocked/10 px-2.5 py-2 font-mono ui-micro text-text">
                {occurrence.detail}
              </p>
            </section>
          )}
          <h4 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.report.title")}
          </h4>
          {occurrence.reportText === null && occurrence.reportRef === null ? (
            <div data-testid="schedule-run-report-empty">
              <Empty>{t("schedules.run.report.none")}</Empty>
            </div>
          ) : occurrence.reportText === null ? (
            <p data-testid="schedule-run-report" className="break-all font-mono ui-micro text-text-muted">
              {occurrence.reportRef}
            </p>
          ) : scheduleReportIsJsonReceipt(occurrence.reportText) ? (
            <details
              data-testid="schedule-run-report-json"
              className="rounded border border-border bg-surface-raised px-2.5 py-1.5"
            >
              <summary className="cursor-pointer font-mono ui-micro text-text-muted">
                {t("schedules.run.report.jsonReceipt")}
              </summary>
              <pre className="rt-pre mt-1.5 max-h-[28rem] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                {occurrence.reportText}
              </pre>
            </details>
          ) : (
            // 报告内嵌:与产物页 Markdown 预览同一个 DocReader,不新写渲染器。
            <div data-testid="schedule-run-report">
              <DocReader content={occurrence.reportText} />
            </div>
          )}
          <h4 className="mb-1.5 mt-3 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">
            {t("schedules.run.outputs.title")}
          </h4>
          {outputCount === 0 ? (
            <div data-testid="schedule-run-outputs-empty">
              <Empty>{t("schedules.run.outputs.empty")}</Empty>
            </div>
          ) : (
            <div data-testid="schedule-run-outputs" className="flex flex-wrap gap-1.5">
              {outputs.facts.map((factId) => (
                <button
                  key={`fact-${factId}`}
                  type="button"
                  data-testid={`schedule-run-output-fact-${factId}`}
                  onClick={() => onSelectEntity(factId.startsWith("fact/") ? factId : `fact/${factId}`)}
                  className="rounded border border-border px-2 py-0.5 font-mono ui-micro text-text-muted hover:border-accent hover:text-accent"
                >
                  {t("schedules.run.outputs.fact")}: {factId}
                </button>
              ))}
              {outputs.decisions.map((decisionId) => (
                <button
                  key={`decision-${decisionId}`}
                  type="button"
                  data-testid={`schedule-run-output-decision-${decisionId}`}
                  onClick={() => onSelectEntity(`decision/${decisionId}`)}
                  className="rounded border border-border px-2 py-0.5 font-mono ui-micro text-text-muted hover:border-accent hover:text-accent"
                >
                  {t("schedules.run.outputs.decision")}: {decisionId}
                </button>
              ))}
              {outputs.tasks.map((taskId) => (
                <button
                  key={`task-${taskId}`}
                  type="button"
                  data-testid={`schedule-run-output-task-${taskId}`}
                  onClick={() => onSelectEntity(`task/${taskId}`)}
                  className="rounded border border-border px-2 py-0.5 font-mono ui-micro text-text-muted hover:border-accent hover:text-accent"
                >
                  {t("schedules.run.outputs.task")}: {taskId}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
