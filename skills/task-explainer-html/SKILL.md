---
name: task-explainer-html
description: 产出与增量维护任务包的活解释页 artifacts/explainer.html：单文件内联 HTML、零外网依赖、浅色适读；按 Coding/Research/Writing/Fleet-Ops 四场景选骨架，消费派工注入的 <task-context> 因果上下文。Use when a task-bound dispatch requires creating, updating, or freezing the task's living explainer page, or when parsing the injected <task-context> XML.
---

# 任务活解释页（task-explainer-html）

每个在账任务有一页**活的可视解释**：任务包 `artifacts/explainer.html`。它不是终局报告，而是随工作轮次增量生长、在 closeout 终态冻结的单文件 HTML——让不读代码的读者随时看到这个任务做了什么、验证了什么、还差什么。Daemon 在每次任务派工的 mission 里注入 `# Living Deliverable Protocol`，本技能是该协议的产出规范。

## 硬规则（先于一切风格）

1. **单文件、全内联、零外网依赖**：全部 CSS/JS/SVG 内联在一个 `.html` 文件里，禁止外链 CDN、字体、图片、脚本。离线打开即完整渲染。
2. **浅色适读**：背景 `#faf7f0` / `#f7f3ea`，正文深墨 `#3d3833`，辅助文字 `#7a7266`；强调色低饱和（成功 `#4a7c59`、警示 `#b0713c`、危险 `#a05252`、链接/主题 `#4a6b8a`）。禁纯白背景、高饱和荧光色、暗色主题。目标观感 = 纸质杂志 / 晨间读物。
3. **无 JS 也可读**：动效一律 JS-gated（`document.documentElement.classList.add('js')` 之后才允许 `opacity:0` 类隐藏），默认全部内容可见；静态快照 / 无脚本环境不许出现藏死的空白。
4. **贴近全宽布局**：`max-width: none`，仅保留页边 `padding: 24px clamp(16px, 2vw, 32px) 80px`；禁止 960/1200/1440 居中细条。架构图 / 对照表 / 网格吃满内容区宽度（SVG `width:100%`，viewBox ≥1200 逻辑宽）；纯文字长段落可用内层 `max-width: 72ch`。≥1100px 分幕内 2 列+，≤720px 叠单列，极宽表在容器内横滚。
5. **诚实优先**：第一句话就是结论；测到的与推出来的分开写；没修完的说没修完；每个数字标明实测还是估算。禁止箭头链（`A → B → C`）与只有作者自己懂的速记词；提到文件 / 命令 / PR，配一句白话说明它是干什么的。
6. **泄漏检查（交付前 grep）**：页面不得含本机绝对路径、邮箱、密钥 / token、内部主机名。PR 号 / decision id / task id 可以出现。

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
- **截断标记**：根元素带 `truncated="yes"` 时表示有整行被预算裁掉；`<refs>` 永远保留可回查的 canonical id，缺的细节用 `ha task read-set` / `ha task show` 补，不要凭空补写。
- **层级缺失**：`work` / `parent` / `decision` / `fact` / `goal` 任一行可以不存在（该任务没有那层关系）；空块不存在（无因果邻域的任务不注入）。

渲染约定：把解析结果画成页面顶部的**身份区**——一句话任务定位 + 一行徽章（Work 名 / 决策锚 / 关键 fact 数），refs 以可读标签呈现。身份区是页面唯一「框架注入」的内容，其余章节由作者按场景骨架撰写。

## 四场景骨架

按任务的 vertical 选一套骨架；跨场景任务以主交付物为准，允许副章节借用另一套。

### Coding（研发实现）

顶部一句话结论（做了什么 / 验证状态 / 还差什么）→ **任务对照表**（硬骨架：每个子目标一行——干了什么（技术直述）、状态、锚点（PR / commit / task id））→ 变更地图（模块分层 SVG：已有 = 绿调 `#4a7c59`、本次改动 = 橙调 `#b0713c`、核心接口 = 蓝调 `#4a6b8a`）→ 验证区（修前红 / 修后绿的命令与原始输出摘录、未验清单）→ 残留风险与下一步。

### Research（研究调查）

顶部一句话答案 → 证据链（每条结论挂着支撑 fact 与来源路径，标注置信度与反例）→ 方法与可复现命令（白话说明每条命令干什么）→ 与既有决策的对照（本结论支持 / 冲突哪些 decision）→ 建议的下一步裁决点。

### Writing（PRD / 文档撰写）

顶部一段文档定位（给谁看、替哪个决定服务）→ 读者与决策点地图（谁在读到哪节时要做什么决定）→ 章节地图（大纲 SVG，标注每节状态：成稿 / 草稿 / 待裁）→ 关键取舍记录（保留了什么表述、删了什么、为什么）→ 待泽宇裁决的开放问题清单。

### Fleet-Ops（舰队运维）

顶部一句话舰队健康结论 → 节点 / 中心状态表（每节点一行：身份、连接、最近同步、告警）→ 事件时间线（本窗口内关键事件，按时间排）→ 容量与配额水位 → 下一步运维动作（谁 / 什么命令 / 预期效果）。

## 活页生命周期（Living Deliverable Protocol）

1. **每轮增量更新**：工作轮次收尾时更新 `artifacts/explainer.html`——更新结论句、任务对照表状态、验证区证据，而不是推倒重写。页面 DOM 骨架保持稳定（章节 id 不变），只重写数据区，让逐轮 diff 可读。
2. **创建即物化**：非 lightweight profile 的任务在 `ha task create` 时就已物化这一页（preset 模板直接可增量填写）；lightweight profile 不物化本页、mission 也不注入本协议。首轮工作从填充骨架开始，不要另起新文件。
3. **closeout 冻结**：任务进入终态时，解释页随任务包一并提交并不再改动；冻结版必须与 closeout.md 的结论一致。
4. **不替代结构化汇报**：本页是给人看的解释层；closeout.md 四节、progress、fact 等台账义务不因本页存在而减免。

## 落点与工具

- 唯一落点：本任务包 `artifacts/explainer.html`。不用任何托管 Artifact / 外部画廊功能；产物随任务包版本管理与审计。
- 工具选择：内容已清晰（结构、数字、图型已定）就直接手写 HTML；图表繁重时才派外部 worker，且骨架里注明本页硬规则（单文件内联 / 浅色 / 全宽 / 无 JS 可读）。
- 交付前自检：泄漏 grep → 事实核对（页内数字对照来源报告）→ 无 JS 渲染验证 → 全宽留白自检（大屏打开左右只剩页边距量级空白）。
