import { t } from "../../i18n/index.tsx";
import type { AgendaAwaitingRow } from "../../../api/renderer-dto.ts";
import type { AttestationPoolLanes } from "../../model/attestation-pool.ts";

/**
 * 注意力堵点直达:集中呈现需要人类处理的事项——待裁 decision(repo.agenda.read)、
 * 待 owner 裁决的 submitted execution、人工门禁签发与特批放行(deriveAttestationLanes
 * 的 gates/breakGlass lane)、待签署 Consent(consents lane)。跳转复用实体导航与
 * 待办签发总池,本卡片零写操作。
 */

interface BlockerGroup {
  readonly key: "decisions" | "executions" | "gates" | "breakGlass" | "consents";
  readonly title: () => string;
  readonly items: readonly BlockerItem[];
}

interface BlockerItem {
  readonly id: string;
  readonly label: string;
  readonly meta: string | null;
  readonly navigateRef: string;
}

export function AttentionBlockers({
  awaiting,
  lanes,
  onNavigateEntity,
  onOpenPool,
}: {
  /** repo.agenda.read 的 awaitingDecision 分组;null = 议程未读完或未挂载。 */
  readonly awaiting: readonly AgendaAwaitingRow[] | null;
  readonly lanes: AttestationPoolLanes;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenPool: () => void;
}) {
  const groups: readonly BlockerGroup[] = [
      {
        key: "decisions",
        title: () => t("views.cadence.blockersDecisions"),
        items: (awaiting ?? [])
          .filter((row): row is Extract<AgendaAwaitingRow, { readonly kind: "decision" }> => row.kind === "decision")
          .map((row) => ({
            id: row.decisionId,
            label: row.title,
            meta: `${row.riskTier} · ${row.urgency}`,
            navigateRef: `decision/${row.decisionId}`,
          })),
      },
      {
        key: "executions",
        title: () => t("views.cadence.blockersExecutions"),
        items: (awaiting ?? [])
          .filter((row): row is Extract<AgendaAwaitingRow, { readonly kind: "execution" }> => row.kind === "execution")
          .map((row) => ({ id: row.taskId, label: row.title, meta: null, navigateRef: `task/${row.taskId}` })),
      },
      {
        key: "gates",
        title: () => t("views.cadence.blockersGates"),
        items: lanes.gates.map((gate) => ({
          id: `${gate.taskId}:${gate.gateId}`,
          label: `${gate.taskTitle} · ${gate.gateId}`,
          meta: gate.gateStatus,
          navigateRef: `task/${gate.taskId}`,
        })),
      },
      {
        key: "breakGlass",
        title: () => t("views.cadence.blockersBreakGlass"),
        items: lanes.breakGlass.map((gate) => ({
          id: `${gate.taskId}:${gate.gateId}`,
          label: `${gate.taskTitle} · ${gate.gateId}`,
          meta: gate.gateStatus,
          navigateRef: `task/${gate.taskId}`,
        })),
      },
      {
        key: "consents",
        title: () => t("views.cadence.blockersConsents"),
        items: lanes.consents.map((consent) => ({
          id: consent.taskId,
          label: consent.taskTitle,
          meta: null,
          navigateRef: `task/${consent.taskId}`,
        })),
      },
    ],
    visibleGroups = groups.filter((group) => group.items.length > 0),
    total = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section
      data-testid="cadence-blockers"
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="ui-body font-semibold">{t("views.cadence.blockersTitle")}</h2>
        <button type="button" className="font-mono ui-micro text-accent hover:underline" onClick={onOpenPool}>
          {t("views.cadence.blockersPool")}
        </button>
      </header>
      {awaiting === null ? (
        <p data-testid="cadence-blockers-pending" className="px-3 py-3 ui-meta text-text-faint">
          {t("views.cadence.blockersPending")}
        </p>
      ) : total === 0 ? (
        <p data-testid="cadence-blockers-empty" className="px-3 py-3 ui-meta text-text-faint">
          {t("views.cadence.blockersEmpty")}
        </p>
      ) : (
        <div data-testid="cadence-blockers-groups" className="flex max-h-48 flex-col overflow-y-auto">
          {visibleGroups.map((group, index) => (
            <div key={group.key} className={index === 0 ? "" : "border-t border-border"}>
              <p className="px-3 pt-2 font-mono ui-micro uppercase tracking-wide text-text-faint">
                {`${group.title()} ${group.items.length}`}
              </p>
              <ul>
                {group.items.slice(0, 5).map((item) => (
                  <li key={item.id} className="flex items-baseline gap-2 px-3 py-1">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left ui-meta text-text hover:text-accent"
                      title={item.label}
                      onClick={() => onNavigateEntity(item.navigateRef)}
                    >
                      {item.label}
                    </button>
                    {item.meta === null ? null : (
                      <span className="shrink-0 font-mono ui-micro text-text-faint">{item.meta}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
