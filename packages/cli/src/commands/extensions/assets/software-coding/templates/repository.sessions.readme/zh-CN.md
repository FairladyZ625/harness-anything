# Sessions

## 用途

这个文件夹是**会话溯源（provenance）存档**：每个 `*.md` 是一次 agent/human 会话的导出快照（`provenance-session/v1`），记录 runtime、来源、时间戳与会话正文。它让"某个决策/改动是在哪次会话里产生的"可追溯。

## 怎么用

- 这里的文件由 harness 的会话导出机制生成，**不要手写会话文件**。
- 决策/任务通过 frontmatter 里的 `provenance`（`runtime` + `sessionId` + `boundAt`）指回这里的会话，形成溯源链。
- 需要复盘"这个选择当时是怎么想的"时，顺着实体的 `provenance.sessionId` 找到对应 `<sessionId>.md`。

## 放什么 / 不放什么

- ✅ 放：会话导出快照（由命令生成）。
- ❌ 不放：手写笔记、决策正文、任务进展。它只是溯源账，不承载语义决策。
- ❌ 不放：需要长期检索的知识（那属于 fact / decision / context）。

## 相关命令

会话由导出流程生成（如 `ha session export ...` / 运行时自动导出）；实体侧用 `provenance` 字段绑定，不在此目录手工维护。
