# GUI 共享组件契约(内部组件库)

`renderer/components/` 的组件分层与默认责任。新页面只组合这里的原语,不在调用点自造形状;
规范正文(视觉语言)在私有治理面,本文件只写公开仓可消费的契约事实。

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 原语层(唯一权威) | `primitives/` | 布局、密度、状态色、截断、焦点等规则住所;一处实现 |
| 共享契约件 | `EntityRefLink.tsx`、`IdText.tsx`、`badges.tsx`(STATUS_META)、`../model/time.ts`、`../motion-config.tsx` | 各管一件语义:实体互链、长值展示、状态词、时间、动效偏好 |
| 领域组件 | `runtime/`、`sessions/`、`scheduleRun/`、`tokenUsage/`、`decisionDetail/` 等目录 | 特定平面的组合件,只能向下用原语与契约件 |
| 平行库(迁移中) | `runtime/parts.tsx`、`ui/widgets.tsx` | 存量第二库,按逐语义替代表迁空后删除;新代码禁止取材 |

## 原语默认责任(调用方不背清单)

- **Button**:全仓唯一按钮。四档 `variant`(plain/primary/danger/ghost)× 两档 `size`(sm/md),
  不搞变体矩阵、不接受 className 覆写。`tip` 走全局 tooltip(`data-tip`),`testId` 映射 `data-testid`。
  纯交互外壳(EntityRefLink 这类自带语义的 button)不由此承载。
- **Empty**:只承载「该有而无」(缺配置/坏了/该做事);集合为空且空是正常 → 调用方整块不渲染。
- **SegCtl / Toggle / Tabs / FilterChips**:同一选择语义各只有一个名字;分段/开关/页签/筛选不混用样式。
- **StatusTag**:状态色唯一出口(tone → token 映射在组件内);调用点不写状态色数值、不自造标签形状。
- **EntityRefLink**:`onNavigate` 必填;显示文本可收束,`title` 悬停永远保留完整引用。
- **IdText**:无导航落点的长值;组件内部承担 truncate、悬停完整值;复制动作放行/卡片动作位,不在文字上叠按钮。
- **DenseRow / Region / Section / SummaryCard**:信息密度、区域滚动、文档区块、概况卡各由其原语管。

## 允许的 composition

- 原语之间自由组合;领域组件只向下依赖原语,不反向。
- 长值容器给 `min-w-0`;列宽用 `minmax(0,1fr)` 或自适应,不写死 rem(写死必须说明保护什么)。
- 定位/间距(ml-auto、mt-2 等)放在原语外层的 wrapper 上,不塞进原语内部样式。

## 保留原生控件的地方

- `select`(SettingSelect 等表单下拉)保留原生,不造自定义下拉。
- 复选框(窄容器开关等)保留原生 input。
- 纯文本段落/标题直接用语义标签 + 排版类,不为它们建组件。

## 动效

唯一动画库 `motion`;偏好三态(system/on/off)由 `motion-config.tsx` 的 AppMotionConfig 统一映射,
页面零 motion import、不读偏好。入场/布局动画只由 Region/EntryBoundary/FocusLayer/Drawer 承载。

## 展示目录

`catalog/ComponentCatalog.tsx` 是开发-only Vite 入口:真实组件 + 示例数据,覆盖主题、动效偏好、
窄容器、禁用/长值/空态。收敛新原语时在同目录补对应状态展示。
