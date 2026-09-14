import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalDocReadResult, LocalDocWriteResult } from "../../../api/local-doc-contract.ts";
import type { AgentSkillRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { requestLocalDocument, saveLocalDocument } from "../../local-doc/local-doc-client.ts";
import { LocalDocError } from "../../local-doc/LocalDocLayer.tsx";
import { DocReader } from "../DocReader.tsx";
import { Badge, Btn, Modal, SegCtl } from "./parts.tsx";

/**
 * Skill 详情查看与编辑浮层(task_5dfe382f):点击 AgentCard 的技能药丸打开,解决
 * 「点药丸即删技能」的误触 —— 删除只走药丸上独立的 × 热区,这里只做查看与编辑。
 *
 * 预览态复用 DocReader(与详情页 Markdown 同一渲染面);编辑态是等宽源码编辑器,
 * 「保存」或 Cmd/Ctrl+S 把整体内容经 localDoc 写通道落回磁盘 SKILL.md。读写全部
 * typed:失败按 code 出页内错误态(复用 LocalDocError),不弹系统对话框、不白屏。
 */

export type ViewingSkill = { readonly id: string; readonly path: string; readonly source?: string };

const SKILL_MANIFEST_FILE = "SKILL.md";

/** 声明 path 通常指向技能目录(daemon 目录发现给的也是目录);已指向 SKILL.md 时原样使用。 */
function manifestPathOf(target: string): string {
  const trimmed = target.replace(/\/+$/u, "");
  return trimmed === SKILL_MANIFEST_FILE || trimmed.endsWith(`/${SKILL_MANIFEST_FILE}`)
    ? trimmed
    : `${trimmed}/${SKILL_MANIFEST_FILE}`;
}

/** 解析 SKILL.md 真身:相对声明优先对齐技能目录发现的绝对路径(精确 → 后缀 → id)。 */
export function resolveSkillManifestPath(skill: ViewingSkill, availableSkills: readonly AgentSkillRow[] = []): string {
  const declared = skill.path.trim();
  if (declared.length === 0) return declared;
  if (!declared.startsWith("/") && !declared.startsWith("~")) {
    const matched =
      availableSkills.find((row) => row.path === declared) ??
      availableSkills.find((row) => row.path.endsWith(`/${declared}`)) ??
      availableSkills.find((row) => row.id === skill.id);
    if (matched) return manifestPathOf(matched.path);
  }
  return manifestPathOf(declared);
}

export function SkillEditorModal({
  skill,
  availableSkills = [],
  onClose,
}: {
  readonly skill: ViewingSkill;
  readonly availableSkills?: readonly AgentSkillRow[];
  readonly onClose: () => void;
}) {
  const manifestPath = useMemo(() => resolveSkillManifestPath(skill, availableSkills), [skill, availableSkills]);
  const [read, setRead] = useState<LocalDocReadResult | null>(null),
    [draft, setDraft] = useState<string | null>(null),
    [view, setView] = useState<"preview" | "edit">("preview"),
    [saving, setSaving] = useState(false),
    [savedOnce, setSavedOnce] = useState(false),
    [writeFailure, setWriteFailure] = useState<Extract<LocalDocWriteResult, { readonly ok: false }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRead(null);
    setDraft(null);
    void requestLocalDocument(manifestPath).then((result) => {
      if (cancelled) return;
      setRead(result);
      setDraft(result.ok ? result.content : null);
    });
    return () => {
      cancelled = true;
    };
  }, [manifestPath]);

  const loadedContent = read?.ok === true ? read.content : null,
    dirty = draft !== null && loadedContent !== null && draft !== loadedContent;
  const save = useCallback(async () => {
    if (saving || !read?.ok || draft === null) return;
    setSaving(true);
    setWriteFailure(null);
    const result = await saveLocalDocument(read.path, draft);
    setSaving(false);
    if (result.ok) {
      // 保存成功后以写回结果对齐已加载基线:路径用主进程返回的真身,脏标记随之清零。
      setRead({ ok: true, path: result.path, content: draft, sizeBytes: result.sizeBytes });
      setSavedOnce(true);
    } else setWriteFailure(result);
  }, [saving, read, draft]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  const source = draft ?? "",
    displayPath = read?.ok === true ? read.path : manifestPath;
  return (
    <Modal
      title={t("agentRuntime.skillModal.title")}
      hint={skill.id}
      wide
      testId="skill-editor-modal"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {skill.source && <Badge>{skill.source}</Badge>}
          <span
            className="min-w-0 flex-1 truncate font-mono ui-micro text-text-faint"
            data-testid="skill-editor-path"
            title={displayPath}
          >
            {displayPath}
          </span>
          <span className="font-mono ui-micro text-text-faint">
            {t("agentRuntime.skillModal.editorStats", {
              lines: source.split("\n").length,
              chars: source.length,
            })}
          </span>
          {dirty ? (
            <span data-testid="skill-editor-unsaved" className="ui-micro text-stale">
              {t("agentRuntime.skillModal.unsavedChanges")}
            </span>
          ) : (
            savedOnce && (
              <span data-testid="skill-editor-saved" className="ui-micro text-text-faint">
                {t("agentRuntime.skillModal.saved")}
              </span>
            )
          )}
          <Btn variant="primary" testId="skill-editor-save" disabled={saving || !dirty} onClick={() => void save()}>
            {t(saving ? "agentRuntime.skillModal.saving" : "agentRuntime.skillModal.save")}
          </Btn>
        </div>
      }
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <SegCtl
          label={t("agentRuntime.skillModal.title")}
          value={view}
          onChange={setView}
          options={[
            { value: "preview" as const, label: t("agentRuntime.skillModal.previewTab") },
            { value: "edit" as const, label: t("agentRuntime.skillModal.editTab") },
          ]}
        />
      </div>
      {writeFailure !== null && (
        <div className="mb-2.5">
          <LocalDocError result={writeFailure} />
        </div>
      )}
      {read === null ? (
        <p data-testid="skill-editor-loading" className="ui-meta text-text-faint">
          {t("agentRuntime.loading")}
        </p>
      ) : !read.ok ? (
        <LocalDocError result={read} />
      ) : view === "preview" ? (
        <DocReader content={source} />
      ) : (
        <textarea
          aria-label={t("agentRuntime.skillModal.editTab")}
          data-testid="skill-editor-source"
          value={source}
          onChange={(event) => setDraft(event.target.value)}
          className="rt-instr"
        />
      )}
    </Modal>
  );
}
