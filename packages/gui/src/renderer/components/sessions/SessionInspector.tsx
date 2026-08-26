import {
  sessionStatusDot,
  sessionStatusKey,
  sessionStatusTone,
  shortRef,
  type SessionRow,
} from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Empty, KV, KVRow, LiveDot } from "../runtime/parts.tsx";

/**
 * 会话页右栏:同一个选中会话从侧面的视角——归属事实 + 同组兄弟会话(设计稿 §7.1)。
 * 兄弟 = 同一任务组的其余行,整段渲染不分批(2026-08-25 泽宇裁决:性能顾虑用按需
 * 渲染解决,不转嫁给用户点击),离屏行靠 content-visibility 跳过。
 */
export function SessionInspector({
  row,
  siblings,
  squadNames,
  onSelectSession,
  onOpenTask,
  onSelectEntity,
}: {
  readonly row: SessionRow | null;
  readonly siblings: readonly SessionRow[];
  readonly squadNames: ReadonlyMap<string, string>;
  readonly onSelectSession: (runtimeSessionId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  return (
    <aside
      data-testid="runtime-inspector"
      aria-label={t("agentRuntime.inspectorSession")}
      className="w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface"
    >
      <h2
        className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-[10.5px] font-bold uppercase
        tracking-[0.09em] text-text-faint"
      >
        {t("agentRuntime.inspectorSession")}
      </h2>
      <SessionFacts row={row} squadNames={squadNames} onOpenTask={onOpenTask} onSelectEntity={onSelectEntity} />
      <section className="border-b border-border px-3 py-2 last:border-b-0">
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
          {t("agentRuntime.inspectorSessions", { count: siblings.length })}
        </h3>
        {siblings.length === 0 ? (
          <Empty>{t("agentRuntime.noSessions")}</Empty>
        ) : (
          siblings.map((sibling) => (
            <SiblingRow key={sibling.runtimeSessionId} sibling={sibling} onSelectSession={onSelectSession} />
          ))
        )}
      </section>
    </aside>
  );
}

// A selected session seen from the side: whose it is and which task holds it, with the
// reverse jump into that task's detail. Facts come from the row the page already holds;
// the jump target is the same task the main panel shows.
function SessionFacts({
  row,
  squadNames,
  onOpenTask,
  onSelectEntity,
}: {
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const squadId = row?.kind === "round" ? row.squadId : null;
  return (
    <section className="border-b border-border px-3 py-2">
      <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
        {t("agentRuntime.inspectorSessionFacts")}
      </h3>
      {row === null ? (
        <Empty>{t("agentRuntime.notFound")}</Empty>
      ) : (
        <>
          <KV>
            {row.kind === "round" && row.agentId ? (
              <KVRow name="agent">
                <EntityRefLink
                  entityRef={`agent/${row.agentId}`}
                  onNavigate={onSelectEntity}
                  title={row.agentId}
                  className="text-accent hover:underline"
                />
              </KVRow>
            ) : (
              <KVRow name="agent">{t("agentRuntime.unattributed")}</KVRow>
            )}
            {squadId ? (
              <KVRow name="squad">
                <EntityRefLink
                  entityRef={`squad/${squadId}`}
                  onNavigate={onSelectEntity}
                  title={squadId}
                  className="text-accent hover:underline"
                >
                  {squadNames.get(squadId) ?? squadId}
                </EntityRefLink>
              </KVRow>
            ) : (
              <KVRow name="squad">—</KVRow>
            )}
            <KVRow name="instance">
              <EntityRefLink
                entityRef={`provider/${row.instanceId}`}
                onNavigate={onSelectEntity}
                title={row.instanceId}
                className="text-accent hover:underline"
              />
            </KVRow>
            <KVRow name="dispatch">{row.kind === "round" ? row.dispatchId : "—"}</KVRow>
            <KVRow name="status">{t(sessionStatusKey[row.status] as never)}</KVRow>
          </KV>
          <button
            type="button"
            data-testid="inspector-open-task"
            data-task={row.taskId}
            title={t("agentRuntime.openTask")}
            onClick={() => onOpenTask(row.taskId)}
            className={
              "mt-2 flex w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-left " +
              "hover:border-accent hover:text-accent"
            }
          >
            <span className="min-w-0 flex-1 truncate text-[11px]">{row.taskTitle ?? row.taskId}</span>
            <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{shortRef(row.taskId, 14)}</span>
            <span aria-hidden className="shrink-0 text-[9.5px] text-text-faint">
              ↗
            </span>
          </button>
        </>
      )}
    </section>
  );
}

function SiblingRow({
  sibling,
  onSelectSession,
}: {
  readonly sibling: SessionRow;
  readonly onSelectSession: (runtimeSessionId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectSession(sibling.runtimeSessionId)}
      className="cv-auto-2r flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised"
    >
      <LiveDot state={sessionStatusDot[sibling.status]} tip={t(sessionStatusKey[sibling.status] as never)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px]">
          {sibling.kind === "round" ? (sibling.agentName ?? sibling.instanceId) : sibling.instanceId}
        </span>
        <span className="block truncate font-mono text-[10px] text-text-faint">
          {sibling.kind === "round" ? shortRef(sibling.dispatchId, 16) : t("agentRuntime.sessionsNoDispatchTag")}
        </span>
      </span>
      <span className={`shrink-0 font-mono text-[9.5px] ${sessionStatusTone[sibling.status]}`}>
        {t(sessionStatusKey[sibling.status] as never)}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-text-faint">
        {formatTime(sibling.startedAt, { style: "time" }) ?? sibling.startedAt}
      </span>
    </button>
  );
}
