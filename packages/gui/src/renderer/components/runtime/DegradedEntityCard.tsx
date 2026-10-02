import type { CSSProperties } from "react";
import type { AgentEntityRow, SquadEntityAvailableRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { Button } from "../primitives/Button.tsx";
import { Card, Crumbs, CrumbSep, Sect } from "./parts.tsx";
import { Chip } from "../primitives/Chip.tsx";
import { Empty } from "../primitives/Empty.tsx";

export type DegradedEntityRow = Extract<AgentEntityRow, { readonly state: "invalid" | "missing" }>;
/** 设置里引用该实体 id 的角色键(如 roles.defaultReviewer)。 */
export type SettingsRoleRef = { readonly key: string; readonly role: "worker" | "reviewer" | "commander" };

/**
 * 降级声明(无效/缺失)的详情:结论先行(标准 §2.2/§2.5)——为什么无效直接取目录行
 * 带回的声明校验结果(error.hint),再列「谁在用它」(设置角色键 + 引用它的 Squad,
 * 失效声明的波及面),最后给修复入口:同 id 重新声明一份有效声明替换掉坏的。
 */
export function DegradedEntityCard({
  kind,
  row,
  settingsRefs,
  referencingSquads,
  onRedeclare,
  onSelectSquad,
}: {
  readonly kind: "agent" | "squad";
  readonly row: DegradedEntityRow;
  readonly settingsRefs: readonly SettingsRoleRef[];
  readonly referencingSquads: readonly SquadEntityAvailableRow[];
  readonly onRedeclare: () => void;
  readonly onSelectSquad: (squadId: string) => void;
}) {
  return (
    <div data-testid={`degraded-${kind}-${row.id}`}>
      <Crumbs>
        <span>{t(kind === "agent" ? "agentRuntime.segAgents" : "agentRuntime.segSquads")}</span>
        <CrumbSep />
        <b className="font-mono font-semibold text-text-muted">{row.id}</b>
      </Crumbs>
      <Card>
        <div
          data-testid={`degraded-${kind}-${row.id}-conclusion`}
          className="status-edge relative px-3.5 py-3"
          style={{ "--status-edge": "var(--color-status-blocked)" } as CSSProperties}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusTag
              tone="bad"
              label={t(row.state === "missing" ? "agentRuntime.catalogMissing" : "agentRuntime.catalogInvalid")}
            />
            <span className="font-mono ui-micro text-text-faint">{row.error.code}</span>
          </div>
          {/* 声明校验结果原文:daemon 投影带回什么就显示什么,不转写不截断。 */}
          <p className="mt-1.5 ui-prose text-text">{row.error.hint}</p>
        </div>
        <Sect title={t("agentRuntime.degradedRefsTitle")} desc={t("agentRuntime.degradedRefsDesc")}>
          {settingsRefs.length === 0 && referencingSquads.length === 0 ? (
            <Empty>{t("agentRuntime.notReferenced")}</Empty>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {settingsRefs.map((ref) => (
                <Chip key={ref.key} tone="mono" tip={t("agentRuntime.refsSettingsTip")}>
                  roles.{ref.key}
                </Chip>
              ))}
              {referencingSquads.map((squad) => (
                <Chip key={squad.id} tone="link" onClick={() => onSelectSquad(squad.id)}>
                  {squad.name}
                </Chip>
              ))}
            </div>
          )}
        </Sect>
        <Sect title={t("agentRuntime.actions")}>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" testId={`redeclare-${kind}-${row.id}`} onClick={onRedeclare}>
              {t("agentRuntime.redeclare")}
            </Button>
            <span className="ui-micro text-text-faint">{t("agentRuntime.redeclareHint")}</span>
          </div>
        </Sect>
      </Card>
    </div>
  );
}
