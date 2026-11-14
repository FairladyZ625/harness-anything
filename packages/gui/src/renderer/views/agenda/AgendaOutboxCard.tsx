import { useState } from "react";
import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import { TASK_EXPLAINER_DOC, useTaskDeliveryDiffQuery, useTaskDocumentListQuery } from "../../task-data.ts";
import { WorkExplainerDocument } from "../workspace/WorkExplainer.tsx";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";
import { DenseRow } from "../../components/primitives/DenseRow.tsx";
import { SegCtl } from "../../components/primitives/SegCtl.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { t } from "../../i18n/index.tsx";

type DeliveryTab = "explainer" | "files" | "gates";

/** Mount exactly once, for the selected Outbox item. Hooks share task-detail query keys. */
export function AgendaOutboxCard({ repoId, item }: { readonly repoId: string; readonly item: AgendaWorkbenchItem }) {
  const diff = useTaskDeliveryDiffQuery(repoId, item.taskId);
  const documents = useTaskDocumentListQuery(repoId, item.taskId);
  const [tab, setTab] = useState<DeliveryTab | null>(null);
  const hasExplainer =
    documents.data?.status === "ready" && documents.data.documents.some(({ path }) => path === TASK_EXPLAINER_DOC);
  const currentTab = tab === "gates" ? "gates" : tab === "files" ? "files" : hasExplainer ? "explainer" : "files";
  const options = [
    ...(hasExplainer
      ? [{ value: "explainer" as const, label: t("views.agenda.tabExplainer"), testId: "agenda-tab-explainer" }]
      : []),
    { value: "files" as const, label: t("views.agenda.tabFiles"), testId: "agenda-tab-files" },
    { value: "gates" as const, label: t("views.agenda.tabGates"), testId: "agenda-tab-gates" },
  ];
  const gates = item.task?.gates;
  const files = diff.data?.files ?? [];
  let added = 0,
    deleted = 0;
  for (const file of files)
    for (const line of file.lines) {
      if (line.kind === "add") added += 1;
      if (line.kind === "remove") deleted += 1;
    }
  const ready = diff.data?.status === "ready";
  const frozen = diff.data?.commitSha !== null && diff.data?.baseline !== null;
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 ui-meta text-text" data-testid="agenda-delivery-summary">
        {diff.isError ? (
          <p role="alert" className="break-words text-danger">
            {diff.error.message}
          </p>
        ) : !ready ? (
          <span role="status">{t("views.agenda.diffPending")}</span>
        ) : !frozen ? (
          <span>{t("views.agenda.diffUnavailable")}</span>
        ) : (
          <>
            <span>{t("views.agenda.fileCount", { count: files.length })}</span>
            <span className="font-mono tabular-nums">
              +{added} / −{deleted}
            </span>
            {diff.data?.truncated && <StatusTag tone="wait" label={t("views.agenda.diffTruncated")} />}
          </>
        )}
        <span data-testid="agenda-gate-summary" className="font-mono tabular-nums">
          {gates
            ? t("views.agenda.gateSummary", {
                passed: gates.filter((gate) => gate.ok === true).length,
                total: gates.length,
              })
            : t("views.agenda.gatesUnavailable")}
        </span>
      </div>
      {documents.isError && (
        <p role="alert" className="break-words ui-meta text-danger">
          {documents.error.message}
        </p>
      )}
      {(documents.isPending || documents.data?.status === "pending") && (
        <span role="status" className="ui-meta text-text-muted">
          {t("views.agenda.documentsPending")}
        </span>
      )}
      <div data-testid="agenda-delivery-tabs">
        <SegCtl value={currentTab} options={options} onChange={setTab} label={t("views.agenda.deliveryTabs")} />
      </div>
      {currentTab === "explainer" && item.taskId ? (
        <BoundedContent className="flex h-[var(--long-content-cap)] flex-col">
          <WorkExplainerDocument repoId={repoId} taskId={item.taskId} />
        </BoundedContent>
      ) : currentTab === "gates" ? (
        <BoundedContent>
          <div data-testid="agenda-delivery-gates">
            {gates?.map((gate) => (
              <DenseRow
                key={gate.name}
                title={gate.name}
                reason={gate.detail}
                tag={
                  <StatusTag
                    tone={gate.ok === true ? "done" : gate.ok === false ? "bad" : "neutral"}
                    label={gate.status ?? t("views.agenda.gateUnknown")}
                  />
                }
              />
            ))}
            {gates?.length === 0 && <p className="ui-meta text-text-muted">{t("views.agenda.gatesEmpty")}</p>}
            {!gates && <p className="ui-meta text-text-muted">{t("views.agenda.gatesUnavailable")}</p>}
          </div>
        </BoundedContent>
      ) : (
        <BoundedContent>
          <div data-testid="agenda-delivery-files">
            {ready &&
              files.map((file) => (
                <DenseRow
                  key={file.filePath}
                  title={file.filePath}
                  hoverTitle={file.filePath}
                  time={`+${file.lines.filter((line) => line.kind === "add").length} / −${file.lines.filter((line) => line.kind === "remove").length}`}
                />
              ))}
            {ready && frozen && files.length === 0 && (
              <p className="ui-meta text-text-muted">{t("views.agenda.filesEmpty")}</p>
            )}
          </div>
        </BoundedContent>
      )}
    </div>
  );
}
