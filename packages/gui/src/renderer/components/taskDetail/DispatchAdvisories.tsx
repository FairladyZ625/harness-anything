import type { TaskDispatchProjectionRow } from "../../../api/renderer-dto.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { StatusTag } from "../primitives/StatusTag.tsx";

export function DispatchAdvisories({ advisories }: { readonly advisories: TaskDispatchProjectionRow["advisories"] }) {
  if (!advisories?.length) return null;
  return (
    <div className="mt-3 min-w-0 border-t border-border pt-3" data-testid="dispatch-advisories">
      <StatusTag tone="neutral" label={t("views.dispatch.advisory")} />
      {advisories.map((advisory) => (
        <div key={`${advisory.pointId}:${advisory.evaluatedAt}`} className="mt-2 ui-meta">
          <p className="break-words font-semibold text-text">
            {advisory.options.find((option) => option.id === advisory.selected)?.text ?? advisory.selected}
          </p>
          <p className="break-all text-text-muted">
            {advisory.pointId} · {advisory.provider.providerId} · {advisory.provider.resolvedModel}
          </p>
          <time dateTime={advisory.evaluatedAt} className="text-text-faint">
            {formatTime(advisory.evaluatedAt, { style: "date-time-seconds" })}
          </time>
          <ul aria-label={t("views.dispatch.distribution")} className="mt-1 text-text-muted">
            {Object.entries(advisory.distribution).map(([id, probability]) => (
              <li key={id} className="break-words">
                {advisory.options.find((option) => option.id === id)?.text ?? id} · {(probability * 100).toFixed(1)}%
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
