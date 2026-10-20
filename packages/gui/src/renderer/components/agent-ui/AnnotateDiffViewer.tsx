import { useRef, useState, type ReactNode } from "react";
import { ChatText, Trash, UploadSimple } from "@phosphor-icons/react";
import { Button } from "../primitives/Button.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { BoundedContent } from "../primitives/BoundedContent.tsx";

/**
 * agent-ui 批量差异批注器(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Orca「Annotate AI Diff」契约):
 * Unified/Split 行级 Diff,行号槽点 + 或聚焦行按 c 添加行级 Markdown 批注;
 * 批注只进暂存列表,点「打包回送 Agent」才经 formatBatchReviewPrompt 聚合为
 * 单轮修订 Prompt(文件路径 + 行锚点 + 代码片段 + 批注正文)一次性回调。
 * 纯 UI 层 Prompt 编排,产物仍走标准 dispatch/runtime 通道,不越权改台账。
 */

export type DiffLineKind = "context" | "add" | "remove";
export type DiffViewMode = "unified" | "split";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** 旧行号;context/remove 行有。 */
  readonly oldLineNo?: number;
  /** 新行号;context/add 行有。 */
  readonly newLineNo?: number;
  readonly text: string;
}

export interface DiffFile {
  readonly filePath: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffAnnotation {
  readonly id: string;
  readonly filePath: string;
  /** 行锚点起止(行级批注两者相等;保留区间形状供未来整块批注)。 */
  readonly lineStart: number;
  readonly lineEnd: number;
  /** 锚点行原文(进 Prompt 的代码片段)。 */
  readonly snippet: string;
  /** 用户批注正文(Markdown,原样回传)。 */
  readonly body: string;
}

/** 行锚点:删除行锚旧行号,其余锚新行号。 */
function anchorLineNo(line: DiffLine): number {
  return line.kind === "remove" ? (line.oldLineNo ?? 0) : (line.newLineNo ?? line.oldLineNo ?? 0);
}

function lineKey(line: DiffLine): string {
  return `${line.kind === "remove" ? "old" : "new"}-${anchorLineNo(line)}`;
}

/**
 * 聚合全部待发批注为单轮修订 Prompt。
 * 排序确定性:按文件路径字典序,再按行号升序;同一行多条批注按录入顺序。
 */
export function formatBatchReviewPrompt(annotations: readonly DiffAnnotation[]): string {
  const ordered = [...annotations].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return a.lineStart - b.lineStart;
  });
  const blocks = ordered.map((annotation) => {
    const snippet = annotation.snippet.length > 0 ? `  ${annotation.lineStart} | ${annotation.snippet}` : "";
    return [
      `### ${annotation.filePath}:${annotation.lineStart}-${annotation.lineEnd}`,
      snippet,
      `批注:`,
      annotation.body,
    ].join("\n");
  });
  return [
    `请按以下 ${ordered.length} 条批注一次性完成修订(同一轮内全部处理,不要逐条回复):`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

interface SplitRow {
  readonly old: DiffLine | undefined;
  readonly new: DiffLine | undefined;
}

/** Split 配对:context 两栏同现;连续 remove 块与紧随 add 块逐行并排,多出的一侧留空。 */
function pairSplitRows(lines: readonly DiffLine[]): readonly SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind === "context") {
      rows.push({ old: lines[index], new: lines[index] });
      index += 1;
      continue;
    }
    const removes: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "remove") removes.push(lines[index++]);
    const adds: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "add") adds.push(lines[index++]);
    for (let pair = 0; pair < Math.max(removes.length, adds.length); pair += 1) {
      rows.push({ old: removes[pair], new: adds[pair] });
    }
  }
  return rows;
}

const KIND_MARKER: Record<DiffLineKind, string> = { context: " ", add: "+", remove: "-" };
const KIND_ROW_CLASS: Record<DiffLineKind, string> = {
  context: "",
  add: "bg-success/8",
  remove: "bg-danger/8",
};

function AddAnnotationTrigger({
  filePath,
  line,
  onAdd,
}: {
  readonly filePath: string;
  readonly line: DiffLine;
  readonly onAdd: (filePath: string, line: DiffLine) => void;
}): ReactNode {
  const no = anchorLineNo(line);
  return (
    <button
      type="button"
      data-testid={`annotate-add-${lineKey(line)}`}
      aria-label={`在第 ${no} 行添加批注`}
      title={`第 ${no} 行添加批注(或聚焦该行按 c)`}
      onClick={() => onAdd(filePath, line)}
      className="grid size-4 shrink-0 place-items-center rounded-sm border border-border text-text-faint transition-colors hover:border-accent hover:text-accent"
    >
      +
    </button>
  );
}

function UnifiedRow({
  filePath,
  line,
  onAdd,
}: {
  readonly filePath: string;
  readonly line: DiffLine;
  readonly onAdd: (filePath: string, line: DiffLine) => void;
}): ReactNode {
  return (
    <div
      data-diff-line={lineKey(line)}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "c") {
          event.preventDefault();
          onAdd(filePath, line);
        }
      }}
      className={`flex min-w-0 items-center gap-1.5 px-1 py-px ${KIND_ROW_CLASS[line.kind]}`}
    >
      <span className="w-9 shrink-0 text-right font-mono ui-micro tabular-nums text-text-faint">
        {line.oldLineNo ?? ""}
      </span>
      <span className="w-9 shrink-0 text-right font-mono ui-micro tabular-nums text-text-faint">
        {line.newLineNo ?? ""}
      </span>
      <AddAnnotationTrigger filePath={filePath} line={line} onAdd={onAdd} />
      <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
        {KIND_MARKER[line.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono ui-micro text-text">{line.text}</span>
    </div>
  );
}

function SplitCell({
  filePath,
  line,
  onAdd,
  side,
}: {
  readonly filePath: string;
  readonly line: DiffLine | undefined;
  readonly onAdd: (filePath: string, line: DiffLine) => void;
  readonly side: "old" | "new";
}): ReactNode {
  if (line === undefined) return <div className="min-w-0 flex-1 bg-surface/40 px-1 py-px" aria-hidden />;
  return (
    <div
      data-diff-line={lineKey(line)}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "c") {
          event.preventDefault();
          onAdd(filePath, line);
        }
      }}
      className={`flex min-w-0 flex-1 items-center gap-1.5 px-1 py-px ${KIND_ROW_CLASS[line.kind]}`}
    >
      <span className="w-9 shrink-0 text-right font-mono ui-micro tabular-nums text-text-faint">
        {side === "old" ? (line.oldLineNo ?? "") : (line.newLineNo ?? "")}
      </span>
      <AddAnnotationTrigger filePath={filePath} line={line} onAdd={onAdd} />
      <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
        {KIND_MARKER[line.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono ui-micro text-text">{line.text}</span>
    </div>
  );
}

function Composer({
  target,
  onSave,
  onCancel,
}: {
  readonly target: { readonly filePath: string; readonly line: DiffLine };
  readonly onSave: (body: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [body, setBody] = useState("");
  const no = anchorLineNo(target.line);
  const save = () => {
    if (body.trim().length === 0) return;
    onSave(body);
  };
  return (
    <div
      data-testid="annotate-composer"
      data-target={`${target.filePath}:${no}`}
      className="mt-2 rounded-lg border border-agent-question-border bg-agent-question-surface px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 font-mono ui-micro text-agent-question">
        <ChatText weight="bold" aria-hidden />
        批注目标 {target.filePath}:{no}
      </div>
      <textarea
        autoFocus
        data-testid="annotate-composer-text"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
        rows={3}
        placeholder="行级批注(Markdown)· Cmd/Ctrl+Enter 暂存,Esc 取消"
        className="mt-1.5 w-full rounded-md border border-border bg-surface p-2 font-normal leading-relaxed ui-meta text-text outline-none transition-colors focus:border-accent"
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" testId="annotate-composer-cancel" onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          testId="annotate-composer-save"
          disabled={body.trim().length === 0}
          onClick={save}
        >
          暂存批注
        </Button>
      </div>
    </div>
  );
}

function DraftList({
  annotations,
  onDelete,
}: {
  readonly annotations: readonly DiffAnnotation[];
  readonly onDelete: (id: string) => void;
}): ReactNode {
  if (annotations.length === 0) return <Empty>还没有批注;点行号槽的 + 或聚焦行按 c 开始</Empty>;
  return (
    <ul data-testid="annotate-drafts" className="flex flex-col gap-1.5">
      {annotations.map((annotation) => (
        <li
          key={annotation.id}
          data-testid={`annotate-draft-${annotation.id}`}
          className="flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <span className="shrink-0 font-mono ui-micro text-agent-question">
            {annotation.filePath}:{annotation.lineStart}-{annotation.lineEnd}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words ui-micro leading-relaxed text-text">
            {annotation.body}
          </span>
          <button
            type="button"
            data-testid={`annotate-draft-${annotation.id}-delete`}
            aria-label={`删除 ${annotation.filePath}:${annotation.lineStart} 的批注`}
            onClick={() => onDelete(annotation.id)}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-text-faint transition-colors hover:bg-surface hover:text-danger"
          >
            <Trash weight="bold" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ActionBar({
  count,
  onSend,
  onClear,
  testId,
}: {
  readonly count: number;
  readonly onSend: () => void;
  readonly onClear: () => void;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised/50 px-3 py-2"
    >
      <span className="ui-meta text-text-muted">
        待发批注
        <b data-testid="annotate-pending-count" className="ml-1.5 font-mono tabular-nums text-agent-question">
          {count}
        </b>
        <span className="ml-2 ui-micro text-text-faint">打包为单轮修订 Prompt 回送 Agent</span>
      </span>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" testId="annotate-clear" disabled={count === 0} onClick={onClear}>
          清空
        </Button>
        <Button variant="primary" size="sm" testId="annotate-send" disabled={count === 0} onClick={onSend}>
          <UploadSimple weight="bold" /> 打包回送 Agent
        </Button>
      </div>
    </div>
  );
}

export function AnnotateDiffViewer({
  files,
  mode = "unified",
  onModeChange,
  onBatchSend,
  testId = "annotate-diff",
}: {
  readonly files: readonly DiffFile[];
  readonly mode?: DiffViewMode;
  readonly onModeChange?: (mode: DiffViewMode) => void;
  /** 唯一的对外回调:点「打包回送」时一次触发,收到聚合 Prompt 与结构化批注。 */
  readonly onBatchSend?: (prompt: string, annotations: readonly DiffAnnotation[]) => void;
  readonly testId?: string;
}) {
  const [activeMode, setActiveMode] = useState(mode);
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [composer, setComposer] = useState<{ filePath: string; line: DiffLine } | null>(null);
  const nextIdRef = useRef(0);
  const viewMode = onModeChange === undefined ? activeMode : mode;

  const openComposer = (filePath: string, line: DiffLine) => setComposer({ filePath, line });

  const send = () => {
    if (annotations.length === 0 || onBatchSend === undefined) return;
    onBatchSend(formatBatchReviewPrompt(annotations), annotations);
    setAnnotations([]);
    setComposer(null);
  };

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold ui-heading text-text">差异批注</span>
        <SegCtl
          value={viewMode}
          label="Diff 视图"
          onChange={(next) => {
            setActiveMode(next);
            onModeChange?.(next);
          }}
          options={[
            { value: "unified", label: "Unified", testId: "annotate-mode-unified" },
            { value: "split", label: "Split", testId: "annotate-mode-split" },
          ]}
        />
      </div>
      <ActionBar
        testId="annotate-actionbar-top"
        count={annotations.length}
        onSend={send}
        onClear={() => setAnnotations([])}
      />
      {files.length === 0 && <Empty>没有待批注的差异</Empty>}
      {files.map((file, fileIndex) => {
        const fileCount = annotations.filter((annotation) => annotation.filePath === file.filePath).length;
        return (
          <section
            key={file.filePath}
            data-testid={`annotate-file-${fileIndex}`}
            aria-label={file.filePath}
            className="min-w-0 rounded-xl border border-border bg-surface/40 p-2.5"
          >
            <header className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono ui-meta text-text">{file.filePath}</span>
              {fileCount > 0 && (
                <span className="shrink-0 font-mono ui-micro tabular-nums text-agent-question">批注 {fileCount}</span>
              )}
            </header>
            <BoundedContent className="mt-2">
              {viewMode === "unified" ? (
                <div role="region" aria-label={`${file.filePath} 统一视图差异`}>
                  {file.lines.map((line, index) => (
                    <UnifiedRow key={index} filePath={file.filePath} line={line} onAdd={openComposer} />
                  ))}
                </div>
              ) : (
                <div role="region" aria-label={`${file.filePath} 分栏视图差异`}>
                  {pairSplitRows(file.lines).map((row, index) => (
                    <div key={index} className="flex min-w-0 gap-1">
                      <SplitCell filePath={file.filePath} line={row.old} side="old" onAdd={openComposer} />
                      <div aria-hidden className="w-px shrink-0 bg-border" />
                      <SplitCell filePath={file.filePath} line={row.new} side="new" onAdd={openComposer} />
                    </div>
                  ))}
                </div>
              )}
            </BoundedContent>
            {composer !== null && composer.filePath === file.filePath && (
              <Composer
                key={`${lineKey(composer.line)}-${annotations.length}`}
                target={composer}
                onSave={(body) => {
                  const no = anchorLineNo(composer.line);
                  setAnnotations((prev) => [
                    ...prev,
                    {
                      id: `ann-${nextIdRef.current++}`,
                      filePath: composer.filePath,
                      lineStart: no,
                      lineEnd: no,
                      snippet: composer.line.text,
                      body,
                    },
                  ]);
                  setComposer(null);
                }}
                onCancel={() => setComposer(null)}
              />
            )}
          </section>
        );
      })}
      <div className="flex flex-col gap-2">
        <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">待发批注</span>
        <DraftList
          annotations={annotations}
          onDelete={(id) => setAnnotations((prev) => prev.filter((annotation) => annotation.id !== id))}
        />
      </div>
      <ActionBar
        testId="annotate-actionbar-bottom"
        count={annotations.length}
        onSend={send}
        onClear={() => setAnnotations([])}
      />
    </div>
  );
}
