import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { t } from "../../i18n/index.tsx";

export function AgendaAttention({ item }: { readonly item: AgendaWorkbenchItem }) {
  if (!item.attention) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="agenda-attention">
      <StatusTag tone="neutral" label={t("views.agenda.attention")} count={item.attention.score} />
      {item.attention.reasons.map((reason, index) => (
        <span key={index} data-contribution={reason.contribution}>
          <StatusTag tone="neutral" label={reason.label} count={`+${reason.contribution}`} />
        </span>
      ))}
    </span>
  );
}
