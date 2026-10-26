import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentDeclarationV1 } from "@harness-anything/daemon/protocol";
import {
  agentEntityClient,
  type AgentDiffField,
  type AgentHistoryVersion,
  type AgentVersionRead,
} from "../../agent-entity-client.ts";
import { AnnotateDiffViewer, type DiffFile } from "../agent-ui/AnnotateDiffViewer.tsx";
import { Button } from "../primitives/Button.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { formatByteCount, formatTime } from "../../model/time.ts";
import { t } from "../../i18n/index.tsx";
import { Hint, Sect } from "./parts.tsx";

/**
 * Agent 详情的只读「版本」面(design §3.4)。
 *
 * 左列是声明版本(daemon 的 agent.history.read,与 CLI 同一个读面),右列是选中版本对
 * 当前声明的字段差异(agent.version.read)。回退不新增写路:按钮把选中版本的正文原样交回
 * `onSave` —— 与保存声明同一个 agent-install 入口,并带详情里的 revision 作栅栏。
 */
export function AgentVersionPanel({
  repoId,
  agentId,
  revision,
  retired,
  busy,
  onSave,
}: {
  readonly repoId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly retired: boolean;
  readonly busy: boolean;
  readonly onSave: (declaration: AgentDeclarationV1, expectedVersion: number) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const history = useQuery({
      queryKey: ["agent-history", repoId, agentId],
      queryFn: () => agentEntityClient.readAgentHistory(repoId, agentId),
      staleTime: 4_000,
    }),
    version = useQuery({
      queryKey: ["agent-version", repoId, agentId, selected],
      queryFn: () => agentEntityClient.readAgentVersion(repoId, agentId, selected ?? 0),
      enabled: selected !== null,
      staleTime: 4_000,
    });
  const versions = history.data?.versions ?? [],
    current = versions.find((row) => row.current) ?? versions[0],
    chosen = selected === null ? null : (versions.find((row) => row.revision === selected) ?? null);
  return (
    <Sect title={t("agentRuntime.versions")} desc={t("agentRuntime.versionsDesc")}>
      {history.isPending ? (
        <Empty>{t("agentRuntime.loading")}</Empty>
      ) : history.isError ? (
        <Hint>{t("agentRuntime.versionsUnavailable")}</Hint>
      ) : versions.length === 0 ? (
        <Empty>{t("agentRuntime.versionsEmpty")}</Empty>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row">
          <ol
            data-testid="agent-version-list"
            className="max-h-64 min-w-0 shrink-0 overflow-y-auto rounded border border-border lg:w-[42%]"
          >
            {versions.map((row) => (
              <li key={row.revision}>
                <button
                  type="button"
                  data-testid={`agent-version-row-${row.revision}`}
                  aria-current={row.revision === (chosen?.revision ?? current?.revision) ? "true" : undefined}
                  onClick={() => setSelected(row.revision)}
                  className={`flex w-full flex-col gap-0.5 border-b border-border px-2 py-1.5 text-left last:border-b-0 hover:bg-surface-raised ${
                    row.revision === (chosen?.revision ?? current?.revision) ? "bg-surface-raised" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5 ui-micro">
                    <b className="font-mono">r{row.revision}</b>
                    {row.current ? (
                      <span className="rounded-sm bg-accent px-1 text-accent-fg">
                        {t("agentRuntime.versionCurrent")}
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono text-text-faint">
                      {formatTime(row.occurredAt, { style: "time" }) ?? row.occurredAt}
                    </span>
                  </span>
                  <span className="truncate ui-micro text-text-faint">
                    {row.summary ?? t("agentRuntime.versionSummaryAbsent")} · {row.actor.personId}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="min-w-0 flex-1">
            {chosen === null ? (
              <Hint>{t("agentRuntime.versionPick")}</Hint>
            ) : version.isPending ? (
              <Empty>{t("agentRuntime.loading")}</Empty>
            ) : version.isError ? (
              <Hint>{t("agentRuntime.versionUnavailable")}</Hint>
            ) : version.data ? (
              <VersionDetail
                data={version.data}
                row={chosen}
                retired={retired}
                busy={busy}
                onRollback={() =>
                  onSave((version.data as AgentVersionRead).declaration as unknown as AgentDeclarationV1, revision)
                }
              />
            ) : (
              <Hint>{t("agentRuntime.versionPick")}</Hint>
            )}
          </div>
        </div>
      )}
    </Sect>
  );
}

function VersionDetail({
  data,
  row,
  retired,
  busy,
  onRollback,
}: {
  readonly data: AgentVersionRead;
  readonly row: AgentHistoryVersion;
  readonly retired: boolean;
  readonly busy: boolean;
  readonly onRollback: () => void;
}) {
  const files = diffFiles(data.fields),
    rollbackTo = data.version.revision,
    isCurrent = data.current.revision === rollbackTo;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="agent-version-detail">
      <div className="flex flex-wrap items-center gap-2 ui-micro text-text-faint">
        <span className="font-mono">r{row.revision}</span>
        <span className="font-mono">{row.sha256.slice(0, 12)}</span>
        <span>{`${formatByteCount(row.size)} B`}</span>
        <span>{row.actor.personId}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {data.truncated ? <span>{t("agentUi.diff.truncated", { count: 0 })}</span> : null}
          <Button
            size="sm"
            variant="primary"
            testId="agent-version-rollback"
            disabled={busy || retired || isCurrent}
            tip={
              retired
                ? t("agentRuntime.dispatchRetiredHint")
                : isCurrent
                  ? t("agentRuntime.versionIsCurrent")
                  : undefined
            }
            onClick={onRollback}
          >
            {t("agentRuntime.versionRollback")}
          </Button>
        </span>
      </div>
      {files.length === 0 ? (
        <Hint>{t("agentRuntime.versionNoFieldDiff")}</Hint>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <AnnotateDiffViewer files={files} testId="agent-version-diff" />
        </div>
      )}
    </div>
  );
}

/** The daemon's field differences in the viewer's own DiffFile shape: one synthetic file per
 *  declaration facet, with non-line-set facets stated as a one-row note. */
function diffFiles(fields: readonly AgentDiffField[]): readonly DiffFile[] {
  return fields.map((field) => ({
    filePath: field.field,
    lines:
      "lines" in field
        ? field.lines
        : "added" in field
          ? setLines(field.added, field.removed)
          : [
              {
                kind: "context" as const,
                newLineNo: 1,
                text: `${JSON.stringify(field.from) ?? "—"} → ${JSON.stringify(field.to) ?? "—"}`,
              },
            ],
  }));
}

function setLines(added: readonly unknown[], removed: readonly unknown[]): DiffFile["lines"] {
  const lines: { kind: "add" | "remove"; text: string }[] = [
    ...removed.map((entry) => ({ kind: "remove" as const, text: `- ${JSON.stringify(entry)}` })),
    ...added.map((entry) => ({ kind: "add" as const, text: `+ ${JSON.stringify(entry)}` })),
  ];
  return lines.length ? lines : [{ kind: "context" as const, text: "(unchanged)" }];
}
