import { useEffect, useReducer } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RepositoryReadFrame } from "@harness-anything/daemon/protocol";
import { repositoryReadFrame } from "../repository-read-frame.ts";
import { isRendererRecord } from "../result-validation.ts";
import { formatTime } from "../model/time.ts";
import { t } from "../i18n/index.tsx";
import { Notice } from "./primitives/Notice.tsx";
import { StatusTag } from "./primitives/StatusTag.tsx";

/** Reads stay in React Query; this surface observes the mounted repository queries, without a second cache. */
export function RepositoryReadNotice({ repoId }: { readonly repoId: string | null }) {
  const cache = useQueryClient().getQueryCache(),
    [, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(
    () =>
      cache.subscribe((event) => {
        if (["updated", "added", "removed", "observerAdded", "observerRemoved"].includes(event.type)) refresh();
      }),
    [cache],
  );
  if (repoId === null) return null;
  const queries = cache.getAll().filter((query) => query.getObserversCount() > 0 && query.queryKey.includes(repoId)),
    frames = queries.flatMap((query) => readFrames(query.state.data)),
    errors = queries.flatMap((query) => {
      const error = query.state.error;
      return error && "code" in error && (error.code === "replica_unavailable" || error.code === "authorization_denied")
        ? [error]
        : [];
    }),
    frame = [...frames].sort(
      (a, b) =>
        Number(b.freshness.state === "stale") - Number(a.freshness.state === "stale") ||
        a.cut.revision - b.cut.revision,
    )[0];
  if (!frame && errors.length === 0) return null;
  const state = errors.length > 0 ? "unavailable" : frame!.freshness.state,
    tone = state === "unavailable" ? "bad" : state === "stale" ? "wait" : "neutral";
  return (
    <Notice tone={tone} variant="strip" testId="repository-read-notice">
      <span data-testid="repository-read-state" data-state={state} className="flex flex-wrap items-center gap-2">
        <StatusTag tone={tone} label={state} />
        {frame && (
          <span>
            {t("components.repositoryRead.cut", {
              revision: frame.cut.revision,
              at:
                frame.freshness.confirmedAt === null
                  ? "—"
                  : (formatTime(frame.freshness.confirmedAt, { style: "date-time-seconds" }) ??
                    frame.freshness.confirmedAt),
            })}
          </span>
        )}
        <span>{t("components.repositoryRead.lastReported")}</span>
      </span>
      {frame?.warning && <p>{frame.warning}</p>}
      {errors.length > 0 && (
        <p>
          {t("components.repositoryRead.unavailable")}{" "}
          {Array.from(new Set(errors.map((error) => error.message))).join(" · ")}
        </p>
      )}
    </Notice>
  );
}

function readFrames(value: unknown): RepositoryReadFrame[] {
  const frame = repositoryReadFrame(value);
  if (frame.cut && frame.freshness && frame.warning !== undefined) return [frame as RepositoryReadFrame];
  return isRendererRecord(value) && Array.isArray(value.pages) ? value.pages.flatMap(readFrames) : [];
}
