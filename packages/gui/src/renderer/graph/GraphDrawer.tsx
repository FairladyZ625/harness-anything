import { X, GitBranch } from "@phosphor-icons/react";
import type { RelationEdge } from "../model/types";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { StatusTag } from "../components/primitives/StatusTag";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { endpointToNodeId } from "./endpoint";
import { KIND_LABEL } from "./constants";
import { t } from "../i18n/index.tsx";

/**
 * 关系边抽屉(图场景 2026-10-02 恢复节点原位展开后收窄):节点正文回到节点卡片
 * (entityCardBodies),抽屉只承载**边**的信息 —— 种类、端点、provenance 与两端跳转。
 * 节点与边的正文各在一处,互不重复。复用共享 Drawer 原语的右侧覆盖式抽屉,
 * 非模态:点画布那一次点击直接生效;关闭走 Esc / 点背景 / 关闭钮(Drawer 壳层)。
 */

interface Props {
  focusEdge: RelationEdge;
  onClose: () => void;
  onFocus: (id: string | null) => void;
  /** 活链接:在详情侧打开该实体。 */
  onNavigateEntity?: (ref: string) => void;
}

export function GraphDrawer({ focusEdge, onClose, onFocus, onNavigateEntity }: Props) {
  return (
    <Drawer open onClose={onClose} modal={false} ariaLabel={t("graph.graphDrawer.ariaLabel")}>
      <div data-testid="graph-detail-drawer" className="flex flex-col">
        <div className="mb-3 flex items-center gap-2 border-b border-border pb-2.5">
          <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
          <span className="font-mono text-xs text-text-muted">{t("graph.graphDrawer.edgeRelation")}</span>
          <StatusTag tone="neutral" label={focusEdge.kind} />
          <button
            onClick={onClose}
            title={t("graph.graphDrawer.exitFocusEsc")}
            className="ml-auto grid size-6 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <p className="ui-body leading-snug text-text">
            {t("graph.graphDrawer.edgeKindMessage", { kind: KIND_LABEL[focusEdge.kind] ?? focusEdge.kind })}
          </p>
          <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-2 ui-micro text-text-muted">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="font-bold text-text">{t("graph.graphDrawer.from")}</span>{" "}
              <EntityRefLink
                entityRef={focusEdge.from}
                onNavigate={onNavigateEntity ?? (() => onFocus(endpointToNodeId(focusEdge.from)))}
                title={focusEdge.from}
                className="break-all font-mono ui-micro text-accent hover:underline"
              />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="font-bold text-text">{t("graph.graphDrawer.to")}</span>{" "}
              <EntityRefLink
                entityRef={focusEdge.to}
                onNavigate={onNavigateEntity ?? (() => onFocus(endpointToNodeId(focusEdge.to)))}
                title={focusEdge.to}
                className="break-all font-mono ui-micro text-accent hover:underline"
              />
            </div>
          </div>
          {focusEdge.provenance && (
            <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
              <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
                {t("graph.graphDrawer.provenance")}
              </span>
              <div className="font-mono ui-micro text-text-muted">{focusEdge.provenance}</div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onFocus(endpointToNodeId(focusEdge.from))}
              className="flex-1 rounded-xs border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
            >
              {t("graph.graphDrawer.jumpSourceNode")}
            </button>
            <button
              onClick={() => onFocus(endpointToNodeId(focusEdge.to))}
              className="flex-1 rounded-xs border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
            >
              {t("graph.graphDrawer.jumpTargetNode")}
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
