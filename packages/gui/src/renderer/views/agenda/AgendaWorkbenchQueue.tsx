import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import { GROUP_LABEL, GROUP_TONE } from "../../model/agenda-rows.ts";
import { formatListTime } from "../../model/time.ts";
import { DenseRow } from "../../components/primitives/DenseRow.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { AgendaAttention } from "./AgendaAttention.tsx";
import { t } from "../../i18n/index.tsx";

export function AgendaItemStatus({ item }: { readonly item: AgendaWorkbenchItem }) {
  return item.bucket === "outbox" ? (
    item.task ? (
      <StatusTag status={item.task.coordinationStatus} />
    ) : (
      <StatusTag tone="wait" label={t("views.agenda.filterOutbox")} />
    )
  ) : (
    <StatusTag tone={GROUP_TONE[item.row.group]} label={t(GROUP_LABEL[item.row.group])} />
  );
}

export function AgendaWorkbenchQueue({
  items,
  selectedKey,
  onSelect,
  advisories,
}: {
  readonly items: readonly AgendaWorkbenchItem[];
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string) => void;
  readonly advisories: ReadonlyMap<string, unknown>;
}) {
  return items.map((item) => (
    <div key={item.key} data-testid={`agenda-row-${item.row.id}`}>
      <DenseRow
        relaxed
        selected={selectedKey === item.key}
        title={item.row.title}
        reason={item.row.hint}
        tag={
          <span className="flex flex-col items-start gap-1">
            <AgendaItemStatus item={item} />
            {item.taskId && advisories.has(item.taskId) && (
              <StatusTag testId="agenda-advisory-tag" tone="neutral" label={t("views.dispatch.advisory")} />
            )}
          </span>
        }
        time={
          item.row.since === null ? undefined : (
            <span className="hidden xl:inline">{formatListTime(item.row.since)}</span>
          )
        }
        onClick={() => onSelect(item.key)}
      />
      {item.attention && (
        <div className="px-3.5 pb-2">
          <AgendaAttention item={item} />
        </div>
      )}
    </div>
  ));
}
