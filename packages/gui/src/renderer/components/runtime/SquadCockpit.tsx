import type { SquadEntityDetail } from "../../agent-entity-client.ts";
import { formatTime } from "../../model/time.ts";
import { sessionStatusDot, type SessionStatus } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { Avatar, Badge, Btn, Hint, LiveDot } from "./parts.tsx";
import type { RuntimeDockRow } from "./useRuntimeWorkspace.ts";

// Squad cockpit(dec_AB0672F220EE630C0A06C575B8 CH3):一个小队是一个页面,页内同时呈现
// Commander 流与 Worker 流及其组织关系,读者不下钻就能看出谁是谁的下级、谁与谁同属
// 一个小队。组织关系只从派工行已有字段派生:squadId 定小队、delegatedByAgentId 定
// leader→worker 边、parentRuntimeSessionId 定「哪一次 Commander 会话派出的」——不引入
// 第二个真相源,不做时间邻近猜测。

export interface SquadCockpitRow extends RuntimeDockRow {
  readonly delegatedByAgentId: string | null;
  readonly parentRuntimeSessionId: string | null;
}

export type SquadCommanderRun = {
  readonly row: SquadCockpitRow;
  readonly children: readonly SquadCockpitRow[];
};

export type SquadCockpitModel = {
  readonly commanderRuns: readonly SquadCommanderRun[];
  readonly unboundWorkers: readonly SquadCockpitRow[];
};

/** 纯分组:Commander 行 = 该小队里执行者是 leader 的派工;下级行按
 * parentRuntimeSessionId 绑到对应 Commander 会话,没有该边的历史行走 unbound,
 * 仍以 squadId + delegatedByAgentId 呈现小队归属与 agent 级组织边。 */
export function squadCockpitModel(squad: SquadEntityDetail, rows: readonly SquadCockpitRow[]): SquadCockpitModel {
  const ordered = [...rows]
      .filter((row) => row.squadId === squad.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    commanderRuns = ordered
      .filter((row) => row.agentId === squad.leader)
      .map((row) => ({ row, children: [] as SquadCockpitRow[] })),
    bySession = new Map(commanderRuns.map((run) => [run.row.runtimeSessionId, run])),
    unboundWorkers: SquadCockpitRow[] = [];
  for (const row of ordered) {
    if (row.agentId === squad.leader) continue;
    const parent = row.parentRuntimeSessionId === null ? undefined : bySession.get(row.parentRuntimeSessionId);
    if (parent) parent.children.push(row);
    else unboundWorkers.push(row);
  }
  return { commanderRuns, unboundWorkers };
}

export function SquadCockpit({
  squad,
  rows,
  busy,
  onLaunch,
  onOpenSession,
}: {
  readonly squad: SquadEntityDetail;
  readonly rows: readonly SquadCockpitRow[];
  readonly busy: boolean;
  readonly onLaunch: () => void;
  readonly onOpenSession: (runtimeSessionId: string) => void;
}) {
  const model = squadCockpitModel(squad, rows),
    workerCount =
      model.commanderRuns.reduce((total, run) => total + run.children.length, 0) + model.unboundWorkers.length;
  return (
    <section
      data-testid="squad-cockpit"
      aria-label={t("agentRuntime.cockpitTitle", { name: squad.name })}
      className="mb-4 rounded-lg border border-border bg-surface-raised"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Avatar id={squad.leader} size="lg" />
        <div className="min-w-0">
          <b className="block truncate text-[13px]">{squad.name}</b>
          <span className="block truncate font-mono text-[10px] text-text-faint">{squad.id}</span>
        </div>
        <Badge>{t("agentRuntime.cockpitCommanderRuns", { count: model.commanderRuns.length })}</Badge>
        <Badge>{t("agentRuntime.cockpitWorkers", { count: workerCount })}</Badge>
        <span className="flex-1" />
        <Btn variant="primary" testId="squad-launch-commander" disabled={busy} onClick={onLaunch}>
          {t("agentRuntime.launchSquad")}
        </Btn>
      </header>
      <div className="px-3 py-2.5">
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
          {t("agentRuntime.cockpitCommanderLane")}
        </h3>
        {model.commanderRuns.length === 0 ? (
          <p data-testid="squad-cockpit-empty-commander" className="py-1 text-[11px] text-text-faint">
            {t("agentRuntime.cockpitNoCommander")}
          </p>
        ) : (
          model.commanderRuns.map((run) => (
            <div key={run.row.runtimeSessionId} className="mb-2.5" data-testid="squad-commander-run">
              <CockpitLane row={run.row} role="commander" onOpenSession={onOpenSession} />
              <div className="mt-1.5 ml-6 border-l-2 border-border pl-3">
                <h4 className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.07em] text-text-faint">
                  {t("agentRuntime.cockpitWorkersOf", { name: run.row.agentName ?? run.row.agentId ?? "" })}
                </h4>
                {run.children.length === 0 ? (
                  <p data-testid="squad-cockpit-no-workers" className="text-[11px] text-text-faint">
                    {t("agentRuntime.cockpitNoWorkers")}
                  </p>
                ) : (
                  <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
                    {run.children.map((child) => (
                      <CockpitLane
                        key={child.runtimeSessionId}
                        row={child}
                        role="worker"
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {model.unboundWorkers.length > 0 && (
          <div className="mt-2 border-t border-border pt-2">
            <h4 className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.07em] text-text-faint">
              {t("agentRuntime.cockpitUnboundWorkers")}
              <Hint>{t("agentRuntime.cockpitUnboundWorkersHint")}</Hint>
            </h4>
            <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
              {model.unboundWorkers.map((row) => (
                <CockpitLane key={row.runtimeSessionId} row={row} role="worker" onOpenSession={onOpenSession} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function CockpitLane({
  row,
  role,
  onOpenSession,
}: {
  readonly row: SquadCockpitRow;
  readonly role: "commander" | "worker";
  readonly onOpenSession: (runtimeSessionId: string) => void;
}) {
  const delegation = role === "worker" && row.delegatedByAgentId ? `${row.delegatedByAgentId} → ${row.agentId}` : null;
  return (
    <button
      type="button"
      data-testid={`squad-lane-${row.runtimeSessionId}`}
      onClick={() => onOpenSession(row.runtimeSessionId)}
      className="flex w-full items-center gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-left
        hover:border-border-strong"
    >
      <LiveDot state={sessionStatusDot[row.status as SessionStatus] ?? "idle"} tip={row.status} />
      <Avatar id={row.agentId ?? row.instanceId} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">
          {row.agentName ?? row.instanceId}
          {role === "commander" ? (
            <span className="ml-1.5 font-mono text-[9.5px] text-accent">{t("agentRuntime.roleCommander")}</span>
          ) : null}
        </span>
        <span className="block truncate font-mono text-[10px] text-text-faint">
          {delegation ?? row.taskTitle ?? row.runtimeSessionId}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-[10px] text-text-faint">{row.status}</span>
        <span className="block font-mono text-[9.5px] text-text-faint">
          {formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
        </span>
      </span>
    </button>
  );
}
