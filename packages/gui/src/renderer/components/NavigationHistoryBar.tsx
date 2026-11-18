import { ArrowLeft, ArrowRight, Eye, X } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";
import type { MemberOption } from "../model/attribution.ts";
import { personShortName } from "../model/attribution.ts";

export interface GlobalScopeLensProps {
  readonly value: string | null;
  readonly currentPersonId: string;
  readonly members: readonly MemberOption[];
  readonly onChange: (personId: string | null) => void;
}

/**
 * AppShell 全局后退/前进栏(移植老 main 线同名组件;REQ-GUI-01 degraded 项)。
 *
 * 经典浏览器式 ← / → 按钮。状态机由 AppShell 持有(useViewHistory),
 * 本组件纯展示。Cmd+[ / Cmd+] 与鼠标侧键监听在 AppShell,不在这。
 * 右侧仅对管理员且仓库具备多成员/边缘节点时渲染只读全局成员视角透镜(CH2)。
 */
export function NavigationHistoryBar({
  canBack,
  canForward,
  onBack,
  onForward,
  scopeLens = null,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  scopeLens?: GlobalScopeLensProps | null;
}) {
  const otherMembers = scopeLens
    ? scopeLens.members.filter((member) => member.personId !== scopeLens.currentPersonId)
    : [];
  return (
    <div
      data-testid="nav-history-bar"
      className="titlebar-drag flex items-center gap-0.5 border-b border-border bg-surface/60 px-2 py-1"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        title={t("navHistory.back")}
        aria-label={t("navHistory.back")}
        className={`titlebar-no-drag grid size-6 place-items-center rounded ${
          canBack ? "text-text-muted hover:bg-surface-raised hover:text-text" : "text-text-faint opacity-40"
        }`}
      >
        <ArrowLeft weight="bold" className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        title={t("navHistory.forward")}
        aria-label={t("navHistory.forward")}
        className={`titlebar-no-drag grid size-6 place-items-center rounded ${
          canForward ? "text-text-muted hover:bg-surface-raised hover:text-text" : "text-text-faint opacity-40"
        }`}
      >
        <ArrowRight weight="bold" className="size-3.5" />
      </button>
      {scopeLens ? (
        <label className="titlebar-no-drag ml-auto flex items-center gap-1.5 ui-meta text-text-muted">
          <Eye weight="bold" className="size-3.5 text-text-faint" aria-hidden />
          <span>{t("components.scopeLens.label")}</span>
          <select
            data-testid="global-scope-select"
            aria-label={t("components.scopeLens.label")}
            value={scopeLens.value ?? ""}
            onChange={(event) => scopeLens.onChange(event.target.value === "" ? null : event.target.value)}
            className="rounded border border-border bg-surface-raised px-2 py-0.5 ui-meta text-text outline-none hover:border-border-strong focus:border-border-strong"
          >
            <option value="">{t("components.scopeLens.all")}</option>
            <option value={scopeLens.currentPersonId}>{t("components.scopeLens.me")}</option>
            {otherMembers.map((member) => (
              <option key={member.personId} value={member.personId}>
                {member.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/** 顶栏下方紧凑状态条:仅当管理员切换到指定成员/「我」视角时显示，支持一键退出。 */
export function GlobalScopeBanner({
  personId,
  currentPersonId,
  peopleById,
  onExit,
}: {
  readonly personId: string;
  readonly currentPersonId: string | null;
  readonly peopleById?: ReadonlyMap<string, string>;
  readonly onExit: () => void;
}) {
  const shortName = personShortName(personId, peopleById);
  const displayName =
    currentPersonId !== null && personId === currentPersonId
      ? t("components.taskFilterBar.me", { name: shortName })
      : shortName;
  return (
    <div
      data-testid="global-scope-banner"
      role="status"
      className="flex items-center justify-between gap-2 border-b border-accent/30 bg-accent/10 px-3 py-1 ui-meta text-text"
    >
      <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
        <Eye weight="bold" className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="truncate">{t("components.scopeLens.activeBanner", { name: displayName })}</span>
      </span>
      <button
        type="button"
        data-testid="global-scope-exit"
        onClick={onExit}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-border-strong bg-surface-raised px-2 py-0.5 ui-micro font-medium text-text hover:border-accent hover:text-accent"
      >
        <X weight="bold" className="size-3" aria-hidden />
        {t("components.scopeLens.exit")}
      </button>
    </div>
  );
}
