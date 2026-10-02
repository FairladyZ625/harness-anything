# {{title}} — GUI Worker Flow

## Dispatch Goal

通过共享组件与真实消费者交付 task_plan.md 的 GUI 目标。实现前从产品仓读取 skills/harness-gui/SKILL.md。

## Scope Boundaries

遵守任务所有权与已批准的交互目标。页面组合领域数据，共享组件负责布局、溢出、焦点和交互；同次变更删除被替代的生产路径。

## Inputs and Dependencies

读取 packages/gui/README.md、相关真实 primitives 与组件目录、相邻消费者及本任务设计裁决。Skill 与组件源码是共享契约，不另抄一套规范。

## Acceptance Criteria

通过真实页面证明行为。触碰长内容、窄容器、键盘时均实测；复用统一比例高度与内部滚动，按实际字体测点击区域，保留实体跳转与减少动效偏好。记录有判别力的测试、证据和未验证边界。

## Stop Conditions

在既定授权内自主处理；真正的所有权冲突或新增产品裁决回报业主，其余工作继续。不削门，不用样稿替代已实现的功能。

## Commit and Handoff

隐藏 Electron、独立临时 profile、CDP 输入，不抢桌面焦点。只保存截图与报告，不提交浏览器缓存。按本任务评审和提交规则交付，报告迁移消费者、删除旧实现、验证及剩余缺口。
