import { useEffect, useMemo, useState } from "react";
import type { AgendaSuccess } from "../api-client.ts";
import { useAgendaAdvisories } from "../agenda-advisories.ts";
import { t } from "../i18n/index.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { SegBar } from "../components/primitives/SegBar.tsx";
import { BoundedContent } from "../components/primitives/BoundedContent.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { AnswerForm } from "../components/AwaitsAnswerPanel.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { agendaRowsOf } from "../model/agenda-rows.ts";
import { agendaWorkbenchOf, type AgendaWorkbenchFilter } from "../model/agenda-workbench.ts";
import { workIndexOf } from "../model/work-collections.ts";
import { formatRelative } from "../model/time.ts";
import { adaptProjectionRows } from "../task-adapter.ts";
import { useTasksQuery, useWorkIndexQuery } from "../task-data.ts";
import { WorkGraphTab } from "./workspace/WorkGraphTab.tsx";
import { AgendaAttention } from "./agenda/AgendaAttention.tsx";
import { AgendaOutboxCard } from "./agenda/AgendaOutboxCard.tsx";
import { AgendaItemStatus, AgendaWorkbenchQueue } from "./agenda/AgendaWorkbenchQueue.tsx";

interface AgendaViewProps {
  readonly repoId: string;
  readonly agenda: AgendaSuccess | undefined;
  readonly agendaError: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}

/** CH1: one route, native Inbox actions, selected-only Outbox reads and quiet receipts. */
export function AgendaView(props: AgendaViewProps) {
  return <AgendaWorkbench key={props.repoId} {...props} />;
}

function AgendaWorkbench({ repoId, agenda, agendaError, onNavigateEntity }: AgendaViewProps) {
  const [filter, setFilter] = useState<AgendaWorkbenchFilter>("inbox");
  const [mode, setMode] = useState<"split" | "focus">("split");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [quietOpen, setQuietOpen] = useState(false);
  const taskRead = useTasksQuery(repoId);
  const workRead = useWorkIndexQuery(repoId);
  const works = useMemo(() => workIndexOf(workRead.data), [workRead.data]);
  const tasks = useMemo(
    () => adaptProjectionRows(taskRead.data?.rows ?? [], repoId, taskRead.data?.status, works),
    [taskRead.data, repoId, works],
  );
  const allRows = useMemo(() => (agenda ? agendaRowsOf(agenda) : []), [agenda]);
  const advisoryRead = useAgendaAdvisories(repoId, allRows);
  const now = Date.now();
  const items = useMemo(
    () => (agenda ? agendaWorkbenchOf(agenda, taskRead.data, tasks, Date.now()) : []),
    [agenda, taskRead.data, tasks],
  );
  const query = search.trim().toLocaleLowerCase();
  const { visible, queue, quiet, navigable } = useMemo(() => {
    const visible = items.filter((item) =>
      query
        ? `${item.row.title} ${item.row.hint} ${item.attention?.reasons.map(({ label }) => label).join(" ") ?? ""}`
            .toLocaleLowerCase()
            .includes(query)
        : filter === "all" || item.bucket === filter,
    );
    const queue = visible.filter((item) => !item.quiet);
    const quiet = visible.filter((item) => item.quiet);
    return { visible, queue, quiet, navigable: quietOpen ? [...queue, ...quiet] : queue };
  }, [items, query, filter, quietOpen]);
  const selected = navigable.find((item) => item.key === selectedKey) ?? navigable[0];
  const index = selected ? navigable.indexOf(selected) : -1;
  const step = (delta: number) => {
    const next = navigable[Math.max(0, Math.min(navigable.length - 1, index + delta))];
    if (next) setSelectedKey(next.key);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      if (navigable.length === 0) return;
      event.preventDefault();
      const next = navigable[Math.max(0, Math.min(navigable.length - 1, index + (key === "j" ? 1 : -1)))];
      if (next) setSelectedKey(next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigable, index]);
  const chips = (
    [
      ["inbox", t("views.agenda.filterInbox")],
      ["outbox", t("views.agenda.filterOutbox")],
      ["follow", t("views.agenda.filterReceipts")],
      ["all", t("views.agenda.filterAll")],
    ] as const
  ).map(([key, label]) => ({ key, label, count: items.filter((item) => key === "all" || item.bucket === key).length }));
  return (
    <div
      className="content-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="agenda-view"
      data-agenda-read={agenda?.status}
      data-task-read={taskRead.data?.status ?? taskRead.status}
      data-work-read={workRead.data?.status ?? workRead.status}
    >
      <PageHeader
        title={t("views.agenda.title")}
        meta={
          <span data-testid="agenda-count">
            {visible.length}/{items.length}
          </span>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3">
        <span data-testid="agenda-filter-chips">
          <FilterChips chips={chips} value={filter} onChange={setFilter} />
        </span>
        <input
          type="search"
          aria-label={t("views.agenda.searchPlaceholder")}
          placeholder={t("views.agenda.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="agenda-search"
          className="min-w-0 basis-40 flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 ui-meta text-text outline-none placeholder:text-text-faint focus:border-border-strong"
        />
        <span data-testid="agenda-layout-mode" className="ml-auto">
          <SegCtl
            value={mode}
            onChange={setMode}
            label={t("views.agenda.layoutMode")}
            options={[
              { value: "split", label: t("views.agenda.modeSplit"), testId: "agenda-mode-split" },
              { value: "focus", label: t("views.agenda.modeFocus"), testId: "agenda-mode-focus" },
            ]}
          />
        </span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-5 pb-4">
        {agendaError ? (
          <p role="alert" className="ui-meta text-danger">
            {t("views.agenda.error", { message: agendaError })}
          </p>
        ) : !agenda ? (
          <p role="status" className="ui-meta text-text-muted">
            {t("views.agenda.loading")}
          </p>
        ) : (
          <>
            {advisoryRead.error && (
              <p role="alert" className="ui-meta text-danger">
                {t("views.agenda.advisoryReadError", { error: String(advisoryRead.error) })}
              </p>
            )}
            {taskRead.error && (
              <p role="alert" className="ui-meta text-danger">
                {t("views.agenda.tasksFailed", { error: taskRead.error.message })}
              </p>
            )}
            {workRead.error && (
              <p role="alert" className="ui-meta text-danger">
                {t("views.agenda.workFailed", { error: workRead.error.message })}
              </p>
            )}
            {agenda.status === "pending" && (
              <p role="status" className="font-mono ui-micro text-text-faint">
                {t("views.overviewView.decisionTilesCatchingUp", { revision: String(agenda.sourceRevision) })}
              </p>
            )}
            {queue.length === 0 && (
              <div className="flex flex-wrap items-center gap-2 ui-meta text-text-muted">
                <span>
                  {t(filter === "outbox" && taskRead.isPending ? "views.agenda.tasksPending" : "views.agenda.empty")}
                </span>
                {filter === "inbox" && !query && items.some((item) => item.bucket === "outbox") && (
                  <Button size="sm" onClick={() => setFilter("outbox")}>
                    {t("views.agenda.openOutbox")}
                  </Button>
                )}
              </div>
            )}
            {selected && (
              <div
                className={
                  mode === "split"
                    ? "grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.7fr)]"
                    : "mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col"
                }
                data-testid="agenda-workbench"
                data-mode={mode}
              >
                {mode === "split" && (
                  <nav
                    aria-label={t("views.agenda.queue")}
                    data-testid="agenda-queue"
                    className="min-h-0 min-w-0 overflow-y-auto border border-border max-lg:max-h-[35cqb]"
                  >
                    <AgendaWorkbenchQueue
                      items={queue}
                      selectedKey={selected.key}
                      onSelect={setSelectedKey}
                      advisories={advisoryRead.advisories}
                    />
                  </nav>
                )}
                <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    <span
                      data-testid="agenda-progress"
                      aria-live="polite"
                      className="font-mono ui-meta text-text-muted"
                    >
                      {index + 1} / {navigable.length}
                    </span>
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        ariaLabel={t("views.agenda.previous")}
                        tip="K"
                        testId="agenda-previous"
                        disabled={index <= 0}
                        onClick={() => step(-1)}
                      >
                        {t("views.agenda.previous")}
                      </Button>
                      <Button
                        size="sm"
                        ariaLabel={t("views.agenda.next")}
                        tip="J"
                        testId="agenda-next"
                        disabled={index >= navigable.length - 1}
                        onClick={() => step(1)}
                      >
                        {t("views.agenda.next")}
                      </Button>
                    </span>
                  </div>
                  <article
                    key={selected.key}
                    data-testid="agenda-current-card"
                    data-item-id={selected.row.id}
                    className="flex min-w-0 shrink-0 flex-col gap-3 border border-border p-3"
                  >
                    <header className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <AgendaItemStatus item={selected} />
                        <h2 className="mt-2 break-words ui-title text-text">
                          <TitleText title={selected.row.title} />
                        </h2>
                      </div>
                      {selected.row.target && (
                        <Button
                          size="sm"
                          testId="agenda-card-open"
                          onClick={() => onNavigateEntity(selected.row.target!)}
                        >
                          {t("views.agenda.openDetail")}
                        </Button>
                      )}
                    </header>
                    <AgendaAttention item={selected} />
                    {selected.row.target && (
                      <EntityRefLink entityRef={selected.row.target} onNavigate={onNavigateEntity} />
                    )}
                    {selected.row.since && (
                      <p className="font-mono ui-micro text-text-faint">
                        {t(selected.bucket === "outbox" ? "views.agenda.deliverySince" : "views.agenda.waitingSince", {
                          age: formatRelative(selected.row.since, { now }),
                        })}
                      </p>
                    )}
                    {selected.bucket === "outbox" ? (
                      <AgendaOutboxCard repoId={repoId} item={selected} />
                    ) : (
                      <>
                        {selected.asks.length === 0 && (
                          <BoundedContent>
                            <p className="whitespace-pre-wrap break-words ui-meta text-text-muted">
                              {selected.row.hint}
                            </p>
                          </BoundedContent>
                        )}
                        {selected.asks.map((ask) => (
                          <AnswerForm key={`${ask.relationId}:${ask.relationRevision}`} repoId={repoId} row={ask} />
                        ))}
                      </>
                    )}
                    {!selected.workRootId && selected.task && (
                      <SegBar counts={{ [selected.task.coordinationStatus]: 1 }} />
                    )}
                  </article>
                  {selected.workRootId && (
                    <div
                      key={selected.workRootId}
                      className="flex h-[var(--long-content-cap)] shrink-0 flex-col"
                      data-testid="agenda-work-topology"
                    >
                      <WorkGraphTab
                        repoId={repoId}
                        workRootTaskId={selected.workRootId}
                        tasks={tasks}
                        onNavigateEntity={onNavigateEntity}
                        active
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
            {quiet.length > 0 && (
              <details
                data-testid="agenda-quiet-fyi"
                open={quietOpen}
                onToggle={(event) => setQuietOpen(event.currentTarget.open)}
                className="shrink-0 border-t border-border"
              >
                <summary className="cursor-pointer py-2 ui-meta text-text-muted">
                  {t("views.agenda.quietFyi", { count: quiet.length })}
                </summary>
                <BoundedContent>
                  <AgendaWorkbenchQueue
                    items={quiet}
                    selectedKey={selected?.key}
                    onSelect={setSelectedKey}
                    advisories={advisoryRead.advisories}
                  />
                </BoundedContent>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
