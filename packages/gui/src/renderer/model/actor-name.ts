import { t, type MessageKey } from "../i18n/index.tsx";

/**
 * 身份串 → 可读名字(视觉基线 v2:机器编号不当主文字)。
 *
 * 台账里的 actor 是 `agent:claude-session:0e69…`、`person_zeyu` 这类没人能读的串;
 * 行的主文字要的是「谁」:Claude 会话、Codex 会话、运行时会话或人名。完整串不丢——
 * 调用方把它放进悬停(title)。纯字符串推导,不做任何会话/agent 目录读面:识别不了
 * 的身份如实回落短串,不猜语义。
 */

export interface ActorName {
  /** 可读名字,做行的主文字。 */
  readonly name: string;
  /** 原始身份串,悬停可达。 */
  readonly full: string;
}

/** `-session:` 前缀里已登记的种类;未登记的种类按「<种类> 会话」拼。 */
const SESSION_KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  "claude-session": "model.actorName.claudeSession",
  "codex-session": "model.actorName.codexSession",
  "runtime-session": "model.actorName.runtimeSession",
};

const SESSION_KIND_SUFFIX: MessageKey = "model.actorName.sessionKindSuffix";

/** 决策行 actor(`{kind, id}`)与已拼好的身份串走同一套推导。 */
export function actorDisplayName(actor: string | { readonly kind: string; readonly id: string }): ActorName {
  const full = typeof actor === "string" ? actor : `${actor.kind}:${actor.id}`;
  // `agent:`/`human:`/`system:` 前缀只说明载体种类,不参与可读名;剥掉后再看会话种类。
  const body = full.replace(/^(?:agent|human|system):/u, "");
  const session = /^([a-z0-9]+-session):.+$/u.exec(body);
  if (session !== null) {
    const kind = session[1]!;
    return { name: t(SESSION_KIND_KEYS[kind] ?? SESSION_KIND_SUFFIX, { kind }), full };
  }
  // 人:person id 的前缀是命名空间,不是名字本身。
  const name = body.replace(/^person\/|^person_/u, "");
  return { name: name === "" ? full : name, full };
}
