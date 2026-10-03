# {{title}} — GUI Worker Flow

## Dispatch Goal

Deliver the GUI outcome specified in task_plan.md through shared components and real consumers. Read skills/harness-gui/SKILL.md from the product repository before implementation.

## Scope Boundaries

Follow this task's ownership and approved product behavior. Pages compose domain data; shared components own layout, overflow, focus and interaction. Remove replaced production paths in the same change.

## Inputs and Dependencies

Read packages/gui/README.md, the relevant production primitives and component catalog, adjacent consumers, and the task's governing design decisions. The skill and actual component source are the shared contract; do not copy them into another rule set.

## Acceptance Criteria

Show the changed behavior through actual consumers, including long content, narrow containers and keyboard interaction when touched. Use the shared proportional height boundary and internal scrolling. Verify real target sizes under font settings. Preserve entity navigation and reduced motion. Record meaningful tests and evidence, including limits not verified.

## Stop Conditions

Resolve uncertainty using the task's authorized scope; report actual ownership conflicts or product decisions requiring the owner. Continue independent authorized work. Do not weaken gates or substitute a mockup for an implemented feature.

## Commit and Handoff

Use hidden Electron with an isolated temporary profile and CDP input; never steal desktop focus. Keep screenshots and reports, not browser cache. Follow the task's review and commit workflow. Report migrated consumers, deleted duplicates, evidence and residual gaps.
