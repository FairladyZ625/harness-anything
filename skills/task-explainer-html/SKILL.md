---
name: task-explainer-html
description: 产出与增量维护任务包中的活解释页 artifacts/explainer.html；按物化模板中的唯一权威注释编写，并消费派工注入的 task-context 因果上下文。Use when a task-bound dispatch requires creating, updating, or freezing the task's living explainer page, or when parsing the injected task-context XML.
---

# 任务活解释页（task-explainer-html）

每个非 lightweight 在账任务有一页**活的可视解释**：任务包 `artifacts/explainer.html`。它不是终局报告，而是任务**进行中**随工作轮次更新的单文件 HTML——业主不读 worker session，task_plan 只是开工时的静态计划，这页是业主在任务进行中了解进展的窗口；closeout 终态冻结。Daemon 的派工协议讲明这页给谁看、什么时候更新。

任务创建时物化的 `artifacts/explainer.html` 顶部 HTML 注释是章节、配色、布局、场景图型和质量要求的**唯一权威来源**。派工与本技能都不复制这些规则；打开页面后按注释逐轮填入真实任务内容。

## 页面编写

以物化页面的 HTML 注释为准。正文必须包含两个 id：`#now`「现在在发生什么」（每轮覆盖重写）与 `#timeline`「过程记录」（只追加、最新在上）；其余章节按任务需要自加，数量与标题不限。多用带真实名字和数字的图（结构、流程、时序、前后对比、数据）说明问题，画不出真实内容的图不要画。不要在本技能、mission 或其他副本维护第二套模板指引；模板规则变化时只改 preset 模板与它的测试。

## `<task-context>` 注入规约

任务派工的 mission 携带一段框架注入的因果上下文 XML（2048 字节预算，`packages/daemon/src/dispatch-causal-context.ts` 是唯一权威源）。语法：

```xml
<task-context>
<work ref="task/<id>">所属 Work 的标题</work>
<parent ref="task/<id>">父任务标题</parent>
<decision ref="decision/<id>" title="决策标题"/>
<chosen ref="decision/<id>" anchor="CH1">选定锚文本 — 理由</chosen>
<claims ref="decision/<id>">C1 载重断言; C2 断言</claims>
<fact ref="fact/<id>">事实陈述 (src:证据来源)</fact>
<goal ref="task/<id>">Work 目标一两句</goal>
<question ref="decision/<id>">决策待答问题</question>
<refs>task/… decision/… fact/…</refs>
</task-context>
```

解析规则（确定性保证）：

- **行导向**：除首尾 `<task-context>` / `</task-context>` 外，每个元素是完整的一行，独立出现或缺失都合法——预算裁剪按整行丢弃，任何行子集拼出的片段仍可逐行解析。
- **转义**：文本与属性值经 XML 转义（`&amp;` `&lt;` `&gt;` `&quot;`），解析时按标准实体还原。
- **归属**：`chosen` / `claims` / `question` 用 `ref` 属性绑定所属 decision，不靠嵌套缩进。
- **截断标记**：根元素带 `truncated="yes"` 时表示有整行被预算裁掉；`<refs>` 永远保留可回查的 canonical id，缺的细节只在派工授权范围内用本任务的 `ha task read-set` / `ha task show` 补；受限执行不得据此查询跨任务背景或全仓图。资料不足时报告具体缺项，由 owner 提供，不凭空补写。
- **层级缺失**：`work` / `parent` / `decision` / `fact` / `goal` 任一行可以不存在（该任务没有那层关系）；空块不存在（无因果邻域的任务不注入）。

解析规约只说明如何理解因果上下文；如何把它呈现到页面，遵循物化模板中的 HTML 注释，不在这里另设身份区或场景骨架。

## 活页生命周期（Living Deliverable Protocol）

1. **逐轮更新**：开工读完材料后先写第一版（你的理解与打算）；每有实质进展、发现、方向变化或红转绿，就重写 `#now` 并在 `#timeline` 顶部追加一条（时间 + 本轮做了什么/发现了什么/为什么改方向 + 证据锚点）。不要攒到收尾一次写。
2. **创建即物化**：非 lightweight profile 的任务在 `ha task create` 时就已物化这一页（preset 模板直接可增量填写）；lightweight profile 不物化本页、mission 也不注入本协议。首轮工作从填充骨架开始，不要另起新文件。
3. **closeout 冻结**：任务进入终态时，解释页随任务包一并提交并不再改动；冻结版必须与 closeout.md 的结论一致。
4. **不替代结构化汇报**：本页是给人看的解释层；closeout.md 四节、progress、fact 等台账义务不因本页存在而减免。

## 落点与工具

- 唯一落点：本任务包 `artifacts/explainer.html`。不用任何托管 Artifact / 外部画廊功能；产物随任务包版本管理与审计。
- 工具选择：内容已清晰（结构、数字、图型已定）就直接手写 HTML；图表繁重时才派外部 worker，且骨架里注明本页硬规则（单文件内联 / 浅色 / 全宽 / 无 JS 可读）。
- 交付前自检：泄漏 grep → 事实核对（页内数字对照来源报告）→ 无 JS 渲染验证 → 全宽留白自检（大屏打开左右只剩页边距量级空白）。
