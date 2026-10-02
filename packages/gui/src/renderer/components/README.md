# GUI 共享组件契约(内部组件库)

`renderer/components/` 的组件分层与默认责任。新页面只组合这里的原语,不在调用点自造形状;
规范正文(视觉语言)在私有治理面,本文件只写公开仓可消费的契约事实。

## 分层

| 层                 | 位置                                                                                                                    | 职责                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 原语层(唯一权威)   | `primitives/`                                                                                                           | 布局、密度、状态色、截断、焦点、命中区等规则住所;一处实现 |
| 共享契约件         | `EntityRefLink.tsx`、`IdText.tsx`、`badges.tsx`(STATUS_META 与领域徽章词表)、`../model/time.ts`、`../motion-config.tsx` | 各管一件语义:实体互链、长值展示、状态词、时间、动效偏好   |
| 领域组件           | `runtime/`、`sessions/`、`scheduleRun/`、`tokenUsage/`、`decisionReview/` 等目录                                        | 特定平面的组合件,只能向下用原语与契约件                   |
| 存量第二库(收敛中) | `runtime/parts.tsx`、`ui/widgets.tsx`                                                                                   | 见「第二库剩余职责」;新代码禁止从这里取材                 |

## 原语默认责任(调用方不背清单)

- **Button**:全仓唯一按钮。四档 `variant`(plain/primary/danger/ghost)× 两档 `size`(sm/md)，
  不接受页面 className 覆写。桌面采用共享 `--control-height-compact`（24px）和
  `--control-height`（28px）最小尺寸，允许随字体自然增高；不把小功能按钮统一撑到40px。
  粗指针由 `--control-height-touch` 提供至少40px的真实点击盒，不用遮挡邻居的透明伪元素。
  EntityRefLink 这类自带语义的交互外壳不由此承载。
- **Toggle / SegCtl**:使用同一 `ui-control` 桌面/粗指针密度。Toggle 的轨道保持紧凑；
  SegCtl 容器用 overflow-hidden 收圆角，段钮不再另行定义40px桌面高度。
- **StatusTag**:唯一的标签形状。状态词(`status`)、自定义 `tone`+`label`、`icon`/`count`/`mono`
  小档都在这一个组件内;调用点不写状态色数值、不自造标签形状。六类领域徽章(收口/决策/引擎/
  新鲜度/风险/紧急)的词表在 `badges.tsx`,渲染全部经 StatusTag。
- **Chip**:可交互贴片(点击插入/链接跳转/可删除)。与 StatusTag(静态状态标签)、FilterChips
  (筛选选择钮组)是三个不同语义,不并成万能组件。
- **Fields(FieldGrid/Field/KV/KVRow)**:只读「标签+值」两档密度(网格档/紧凑键值档),长值词内
  换行、收束值悬停原文。设置表单行(`ui/widgets` Row)与 runtime 配置行(CfgRow)是各自平面的
  布局行,不在此合并。
- **RecordRow**:记录行布局。元数据行(标识/状态左、时间/动作行尾)+ **全宽正文**——长正文占满
  记录容器宽度,不与标识/时间挤三列;长 ID 截断在标识格,窄容器不溢出。
- **BoundedContent**:日志、评审、时间线和文件预览的长内容边界。最大高度统一使用 `--long-content-cap:55cqb`，相对最近 `content-viewport` 的可用块轴尺寸；无此容器时CSS使用小视口参照,超出内容在自身区域滚动，标题和动作位留在边界外。

## Document format matrix

| Format                                    | In-app path                      | Boundary                                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown | `MarkdownDocument` / `DocReader` | GFM, math and Mermaid inside the bounded frame; strict Mermaid with explicit errors. |
| HTML | Existing `HtmlArtifactPreview` in ArtifactsView | Retains the existing isolated HTML artifact preview. Task/local text views do not execute HTML. |
| Text, JSON, CSV, source code | Existing text view / DocReader | Text content is readable; no spreadsheet editing or semantic CSV grid is claimed. |
| PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG | `BinaryDocumentPreview`          | Decoded from authorized base64 bytes; SVG is displayed as an image and never inserted as markup.                                                                                                                                       |
| PDF                                       | `BinaryDocumentPreview`          | PDF.js renders every authorized page to canvases inside the bounded frame; malformed bytes show a typed error and preserve the external-open action.                                                                                   |
| DOCX                                      | `BinaryDocumentPreview`          | `docx-preview` renders authorized bytes, including page breaks, headers, footers, footnotes, endnotes, tables, and images. The renderer is lazy-loaded.                                                                                |
| DOC                                       | `BinaryDocumentPreview`          | `word-extractor` supplies an explicitly labelled Unicode text preview (body, headers, footnotes); original bytes remain available, but original page layout/images are not claimed.                                                    |
| XLSX / XLSM / XLS / ODS                    | `BinaryDocumentPreview`          | `SpreadsheetPreview` parses authorized bytes in memory with the official SheetJS `xlsx` distribution and renders real cached cell values with sheet switching, merged cells, and two-axis scrolling inside the bounded frame. Formulas show cached values (or explicit formula text when the file carries none) and are never recalculated; macros never execute. Very large sheets are windowed with visible row/column ranges and paging, never silently truncated. XLSM is classified by its `macroEnabled` media type, never disguised as XLSX. |

- **Modal**:共享弹层使用原生dialog承担焦点限制、Escape关闭及返回原触发器；遮罩、标题/关闭、滚动正文和固定页脚由原语承担；领域表单只提供
  `children` 与 `footer`,不从 runtime 私有 parts 取弹层布局。
- **Section**:区块三档——默认文档区块、hero/warn 注意力左粗边、panel 设置面板档(吸收原
  ui/widgets Section)。runtime Card 的卡内分节(Sect)是 Card 的领域伴生物,住 runtime/parts。
- **Empty**:只承载「该有而无」(缺配置/坏了/该做事);集合为空且空是正常 → 调用方整块不渲染。
- **SegCtl / Tabs / FilterChips**:同一选择语义各只有一个名字;分段/页签/筛选不混用样式。
- **EntityRefLink**:`onNavigate` 必填;显示文本可收束,`title` 悬停永远保留完整引用。
- **IdText**:无导航落点的长值;组件内部承担 truncate、悬停完整值;复制动作放行/卡片动作位,不在文字上叠按钮。
- **DenseRow / Region / SummaryCard**:信息密度、区域滚动、文档区块、概况卡各由其原语管。

## 允许的 composition

- 原语之间自由组合;领域组件只向下依赖原语,不反向。
- 长值容器给 `min-w-0`;列宽用 `minmax(0,1fr)` 或自适应,不写死 rem(写死必须说明保护什么;
  侧栏轨道可以给固定宽但必须 `max-w-full` 封顶,如 EntityDetailView/FactInspector 的 26rem 侧栏)。
- 定位/间距(ml-auto、mt-2 等)放在原语外层的 wrapper 上,不塞进原语内部样式。

## 保留原生控件的地方

- `select`(SettingSelect 等表单下拉)保留原生,不造自定义下拉。
- 复选框(窄容器开关等)保留原生 input。
- 纯文本段落/标题直接用语义标签 + 排版类,不为它们建组件。

## 第二库剩余职责(收敛台账)

- `runtime/parts.tsx`:runtime 配置平面的领域件——Card/CardHead/CardTitle/CardBody、卡内分节
  Sect、CfgRow、AddChip/ChipZone、KindDot/LiveDot、Avatar(身份色 `--color-avatar-*` token)、
  CapDot、Crumbs、PlannedBox、Hint/Right。跨域语义(按钮/徽章/字段/chip/空态/
  文本输入)已全部迁 primitives 并在本库删除。
- `ui/widgets.tsx`:设置表单行 Row、Kbd、SettingSelect——设置平面的表单布局件。
- 已删除的旧路径:parts `Btn`、`Badge`、`RoleTag`、`Chip`、`Field/FieldGrid/KV/KVRow`、
  `Empty`、`Modal`;ui/widgets `Section`、`Segmented`、`Toggle`、`BTN`;decisionReview 的
  primary/secondaryButtonClass(改投 Button)。

## 动效

唯一动画库 `motion`;偏好三态(system/on/off)由 `motion-config.tsx` 的 AppMotionConfig 统一映射,
页面零 motion import、不读偏好。入场/布局动画只由 Region/EntryBoundary/FocusLayer/Drawer 承载。

## 展示目录

`catalog/ComponentCatalog.tsx` 是开发-only Vite 入口:真实组件 + 示例数据,覆盖主题、动效偏好、
窄容器、禁用/长值/空态、RecordRow 全宽正文、BoundedContent 内滚动、StatusTag 小档、Fields、Chip 与 Section 三档。
收敛新原语时在同目录补对应状态展示。

长内容布局：App主内容提供有确定尺寸的content-viewport；嵌入组件使用BoundedContent，保留pre/ol等原生语义的叶节点可使用同一bounded-content样式契约。CSS容器块轴单位在记录行自身高度不确定时仍有定义；不再使用min(百分比,视口)假装兜底。弹出层无尺寸容器时使用CSS规定的小视口参照。横纵均可滚动，滚动到边界可自然交还外层，避免每条记录锁住滚轮。

- **Notice**：警告/错误等长消息使用统一消息面（panel/strip），与简短StatusTag、图表色块分工。内部正文按同一比例高度约束，runtime私有WarnBar已删除，读取错误保留alert语义。
