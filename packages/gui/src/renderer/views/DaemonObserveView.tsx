import { useEffect, useRef, useState } from "react";
import { ArrowLineDown, CaretLeft, Pause, Play } from "@phosphor-icons/react";
import { harnessClient, type SystemRepoRow } from "../api-client.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import type { ObserveTailRead } from "../../api/renderer-dto.ts";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import {
  applyObserveTailError,
  applyObserveTailPage,
  filterObserveRows,
  initialObserveTail,
  observeTailRequest,
  OBSERVE_ROW_LIMIT,
  type ObserveRow,
  type ObserveTailCursor,
  type ObserveTailKind,
  type ObserveTailMode,
  type ObserveTailSnapshot,
} from "../daemon-observe-model.ts";

/** 日志栏的两个可切 kind(repo-log 每仓 · daemon-log 全局)。 */
type ObserveLogKind = Extract<ObserveTailKind, "repo-log" | "daemon-log">;

/**
 * G6-B daemon 观察详情页:System→system 里点开某个 attached 仓库后的两栏实况。
 * 左栏 canonical 事件流,右栏日志流(每仓 repo-log ↔ 全局 daemon-log 可切);
 * 全部数据走 `observe.tail` RPC,GUI 不读文件。自动尾随滚动、可暂停、关键字过滤,
 * 事件行内的 task/decision/fact/session/provider/agent 引用可点跳转;
 * `unavailable` / `gap` 按契约原因显式呈现,不以空列表冒充。
 */

const TAIL_FOLLOW_MS = 1_000,
  TAIL_CATCHUP_MS = 0,
  TAIL_PENDING_MS = 500,
  TAIL_UNAVAILABLE_MS = 2_500,
  TAIL_ERROR_MS = 1_500;

const MODE_LABEL: Record<ObserveTailMode, () => string> = {
  local: () => t("views.daemonObserve.modeLocal"),
  "remote-center": () => t("views.daemonObserve.modeCenter"),
  "remote-edge": () => t("views.daemonObserve.modeEdge"),
};

// G36:长 Tailwind 串按段拼装,单行不超过 120 列;两处共用的工具按钮类只留一份。
const PANE_TOOL_BUTTON = [
  "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px]",
  "text-text-muted hover:border-border-strong hover:text-text",
].join(" ");
const PANE_STATUS_STRIP = [
  "flex items-center justify-between border-b border-border px-3 py-1",
  "font-mono text-[10px] text-text-faint",
].join(" ");
const PANE_FILTER_INPUT = [
  "w-36 rounded border border-border-strong bg-surface px-2 py-1 font-mono text-[11px]",
  "text-text outline-none focus-visible:border-accent",
].join(" ");
const PANE_JUMP_BUTTON = [
  "inline-flex items-center justify-center gap-1 border-t border-border px-2 py-1",
  "text-[11px] text-accent hover:bg-surface-raised",
].join(" ");
const kindOptionClass = (selected: boolean) =>
  [
    "px-2.5 py-0.5 text-[11px]",
    selected ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface",
  ].join(" ");

/** 行类型列的成败色:失败红、成功绿、事件行(无成败位)用强调色。 */
function rowTone(ok: boolean | null): string {
  if (ok === false) return "text-status-blocked";
  if (ok === true) return "text-status-done";
  return "text-accent";
}

export function DaemonObserveView({
  repoId,
  repos,
  onBack,
  onNavigateEntity,
}: {
  readonly repoId: string | null;
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly onBack: () => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [logKind, setLogKind] = useState<ObserveLogKind>("repo-log"),
    repo = repos.find((row) => row.repoId === repoId) ?? null,
    label = repo?.displayName?.trim() || repoId || "",
    navigate = (ref: string) => onNavigateEntity(repoId === null ? ref : `repo/${repoId}/${ref}`);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} data-testid="daemon-observe-back" className={PANE_TOOL_BUTTON}>
          <CaretLeft />
          {t("views.daemonObserve.backToSystem")}
        </button>
        <h1 className="ui-title font-semibold">{t("shell.nav.daemonObserve")}</h1>
        {repoId ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-[12px] text-text" title={repoId}>
              {label}
            </span>
            {repo?.canonicalRoot ? (
              <span className="truncate font-mono text-[10px] text-text-faint" title={repo.canonicalRoot}>
                {repo.canonicalRoot}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="font-mono text-[12px] text-status-blocked">{t("views.daemonObserve.repoMissing")}</span>
        )}
      </header>
      {repoId === null ? null : (
        <div
          data-testid="daemon-observe-content"
          className="grid w-full min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-2"
        >
          <DaemonTailPane repoId={repoId} kind="events" onNavigateEntity={navigate} />
          <DaemonTailPane
            key={logKind}
            repoId={repoId}
            kind={logKind}
            kindOptions={[
              { value: "repo-log", label: t("views.daemonObserve.kindRepoLog") },
              {
                value: "daemon-log",
                label: t("views.daemonObserve.kindDaemonLog"),
                tip: t("views.daemonObserve.kindDaemonLogTip"),
              },
            ]}
            onKindChange={setLogKind}
            onNavigateEntity={navigate}
          />
        </div>
      )}
    </div>
  );
}

function DaemonTailPane({
  repoId,
  kind,
  kindOptions,
  onKindChange,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly kind: ObserveTailKind;
  readonly kindOptions?: readonly { readonly value: ObserveLogKind; readonly label: string; readonly tip?: string }[];
  readonly onKindChange?: (kind: ObserveLogKind) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [paused, setPaused] = useState(false),
    [query, setQuery] = useState(""),
    [following, setFollowing] = useState(true),
    bodyRef = useRef<HTMLDivElement>(null),
    selfScroll = useRef(false),
    snapshot = useObserveTail(repoId, kind, paused),
    rows = filterObserveRows(snapshot.rows, query),
    isLogPane = kind !== "events",
    // 尾随的触发键是「最后一行」而不是行数:行流触顶 OBSERVE_ROW_LIMIT 后行数恒定,
    // 新行仍在到达(最老行被挤掉),此时尾随必须继续贴底。
    lastKey = rows.length > 0 ? rows[rows.length - 1]!.key : null;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !following) return;
    // 自己写入的 scrollTop 派生的 scroll 事件不算用户上滚:贴底那一跳的 scroll
    // 事件派发前,下一批行可能已经落进 DOM,dist 会瞬时读出 >48 而误停尾随。
    // 同帧内(scroll 事件先于 rAF 回调)用标志位盖掉,帧末清除。
    selfScroll.current = true;
    body.scrollTop = body.scrollHeight;
    requestAnimationFrame(() => {
      selfScroll.current = false;
    });
  }, [lastKey, following]);
  const pause = () => {
    // 继续即恢复贴底跟随;暂停只冻结轮询与滚动,已到行保持可读。
    if (paused) setFollowing(true);
    setPaused((value) => !value);
  };
  return (
    <section
      data-testid={`observe-pane-${kind}`}
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold">
          {isLogPane ? t("views.daemonObserve.logTitle") : t("views.daemonObserve.eventsTitle")}
        </h2>
        {kindOptions && onKindChange ? (
          <span role="group" className="inline-flex overflow-hidden rounded border border-border-strong">
            {kindOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                data-tip={option.tip}
                data-testid={`observe-kind-${option.value}`}
                aria-pressed={option.value === kind}
                onClick={() => onKindChange(option.value)}
                className={kindOptionClass(option.value === kind)}
              >
                {option.label}
              </button>
            ))}
          </span>
        ) : null}
        {snapshot.mode === null ? null : (
          <span className="font-mono text-[10px] text-text-faint" title={snapshot.mode}>
            {MODE_LABEL[snapshot.mode]()}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <input
            type="text"
            aria-label={t("views.daemonObserve.filterLabel")}
            data-testid={`observe-filter-${kind}`}
            value={query}
            placeholder={t("views.daemonObserve.filterPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            className={PANE_FILTER_INPUT}
          />
          <button
            type="button"
            data-testid={`observe-pause-${kind}`}
            aria-pressed={paused}
            onClick={pause}
            title={paused ? t("views.daemonObserve.resume") : t("views.daemonObserve.pause")}
            className={PANE_TOOL_BUTTON}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? t("views.daemonObserve.resume") : t("views.daemonObserve.pause")}
          </button>
        </span>
      </header>
      <div className={PANE_STATUS_STRIP}>
        <span data-testid={`observe-status-${kind}`}>
          {snapshot.status === "idle"
            ? t("views.daemonObserve.loading")
            : snapshot.caughtUp
              ? t("views.daemonObserve.caughtUp")
              : t("views.daemonObserve.replaying")}
        </span>
        <span
          title={t("views.daemonObserve.retainedNote", { max: String(OBSERVE_ROW_LIMIT) })}
          data-testid={`observe-count-${kind}`}
        >
          {t("views.daemonObserve.rowCount", { shown: String(rows.length), total: String(snapshot.rows.length) })}
        </span>
      </div>
      {snapshot.status === "unavailable" ? (
        <p
          data-testid={`observe-unavailable-${kind}`}
          className="border-b border-border bg-status-blocked/5 px-3 py-2 text-[12px] text-status-blocked"
        >
          {t("views.daemonObserve.unavailableTitle")} {unavailableText(snapshot)}
        </p>
      ) : null}
      {snapshot.status === "gap" ? (
        <p
          data-testid={`observe-gap-${kind}`}
          className="border-b border-border bg-stale/10 px-3 py-2 text-[12px] text-stale"
        >
          {t("views.daemonObserve.gapTitle")} {gapText(snapshot)}
        </p>
      ) : null}
      {snapshot.status === "error" ? (
        <p
          data-testid={`observe-error-${kind}`}
          className="border-b border-border bg-status-blocked/5 px-3 py-2 text-[12px] text-status-blocked"
        >
          {t("views.daemonObserve.errorTitle")} {snapshot.error}
        </p>
      ) : null}
      <div
        ref={bodyRef}
        data-testid={`observe-body-${kind}`}
        onScroll={(event) => {
          if (selfScroll.current) return;
          const el = event.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
        }}
        // 行流触顶后每次到达都会挤掉最老一行;浏览器的 scroll anchoring 会为被删内容
        // 反向补偿 scrollTop,与尾随贴底互相拉扯(把 following 打成 false 后停随)。
        // 尾随视图要的是「删头不扰动视口」,因此关掉本容器的锚定。
        className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[11px] leading-relaxed [overflow-anchor:none]"
      >
        {rows.length === 0 ? (
          snapshot.status === "live" || snapshot.status === "idle" ? (
            <p data-testid={`observe-empty-${kind}`} className="px-3 py-2 text-text-faint">
              {snapshot.status === "idle" || !snapshot.caughtUp
                ? t("views.daemonObserve.loading")
                : snapshot.rows.length > 0
                  ? t("views.daemonObserve.noMatch")
                  : t("views.daemonObserve.waitingNew")}
            </p>
          ) : null
        ) : (
          <ol>
            {rows.map((row) => (
              <ObserveRowView key={row.key} row={row} onNavigateEntity={onNavigateEntity} />
            ))}
          </ol>
        )}
      </div>
      {!following ? (
        <button
          type="button"
          data-testid={`observe-jump-${kind}`}
          onClick={() => setFollowing(true)}
          className={PANE_JUMP_BUTTON}
        >
          <ArrowLineDown />
          {t("views.daemonObserve.jumpLatest")}
        </button>
      ) : null}
    </section>
  );
}

function ObserveRowView({
  row,
  onNavigateEntity,
}: {
  readonly row: ObserveRow;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  if (row.gapMarker !== null)
    return (
      <li
        data-testid="observe-gap-marker"
        className="my-1 border-y border-dashed border-stale/50 bg-stale/5 px-2 py-1 text-[10px] text-stale"
      >
        {t("views.daemonObserve.gapMarker", { fileId: row.gapMarker.requestedFileId })}
      </li>
    );
  const time = row.at === null ? "—" : (formatTime(row.at, { style: "time-seconds" }) ?? row.at);
  return (
    <li
      data-testid="observe-row"
      title={row.detail}
      className="flex items-baseline gap-2 px-2 py-px hover:bg-surface-raised/60"
    >
      <span className="shrink-0 text-text-faint">{time}</span>
      {row.revision === null ? null : <span className="shrink-0 text-text-faint">#{row.revision}</span>}
      <span className={`shrink-0 ${rowTone(row.ok)}`}>{row.type}</span>
      <span className="min-w-0 flex-1 truncate text-text-muted">{row.text}</span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        {row.refs.map((chip) => (
          <EntityRefLink
            key={chip.ref}
            entityRef={chip.ref}
            onNavigate={onNavigateEntity}
            title={chip.ref}
            className="inline-flex items-baseline gap-0.5 font-mono text-[10.5px] text-accent hover:underline"
          >
            <span className="text-text-faint">{chip.kind}</span>
            <span className="max-w-[16ch] truncate">{chip.label}</span>
          </EntityRefLink>
        ))}
      </span>
    </li>
  );
}

function unavailableText(snapshot: ObserveTailSnapshot): string {
  const detail = snapshot.unavailable;
  if (detail === null) return "";
  if (detail.reason === "center-request-log-not-wired") return t("views.daemonObserve.unavailableCenterLog");
  const revision =
    detail.centerRevision === null
      ? ""
      : ` ${t("views.daemonObserve.centerRevision", { revision: String(detail.centerRevision) })}`;
  return `${t("views.daemonObserve.unavailableEdge")}${revision}`;
}

function gapText(snapshot: ObserveTailSnapshot): string {
  const detail = snapshot.gap;
  if (detail === null) return "";
  const reason =
    detail.reason === "cursor-offset-out-of-range"
      ? t("views.daemonObserve.gapOutOfRange")
      : t("views.daemonObserve.gapNotRetained");
  return `${reason} fileId=${detail.requestedFileId} · ${t("views.daemonObserve.gapResync")}`;
}

/** 轮询循环:cursor 客户端持有,暂停即停发;gap 后从保留集头重同步。 */
function useObserveTail(repoId: string, kind: ObserveTailKind, paused: boolean): ObserveTailSnapshot {
  const [snapshot, setSnapshot] = useState<ObserveTailSnapshot>(initialObserveTail),
    cursorRef = useRef<ObserveTailCursor>(null);
  useEffect(() => {
    if (paused) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      while (!cancelled) {
        let delay = TAIL_FOLLOW_MS;
        try {
          const page: ObserveTailRead = await harnessClient.tailObservability(
            observeTailRequest(repoId, kind, cursorRef.current),
          );
          if (cancelled) return;
          cursorRef.current = page.cursor;
          setSnapshot((previous) => applyObserveTailPage(previous, page));
          delay =
            page.status === "unavailable"
              ? TAIL_UNAVAILABLE_MS
              : page.done
                ? TAIL_FOLLOW_MS
                : page.status === "pending"
                  ? TAIL_PENDING_MS
                  : TAIL_CATCHUP_MS;
        } catch (error) {
          // 失败被投影为可读横幅(applyObserveTailError),不是吞掉;显式标记以满足门。
          consumeKnownError(error);
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          setSnapshot((previous) => applyObserveTailError(previous, message));
          delay = TAIL_ERROR_MS;
        }
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [repoId, kind, paused]);
  return snapshot;
}
