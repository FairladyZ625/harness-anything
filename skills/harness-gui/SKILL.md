---
name: harness-gui
description: Develop or review Harness Anything GUI pages and shared components using its existing design system, entity navigation, motion preferences, and background Electron verification. Use for packages/gui work and GUI-specific agent missions.
---

# Harness GUI development

Start with the existing product, not a new visual system. Read the target page and adjacent consumers, then GUI package guidance at `packages/gui/README.md` (relative to the product repository root) and the actual shared component source under `packages/gui/src/renderer/components/primitives`. The runnable `packages/gui/component-catalog.html` imports production primitives and demonstrates their contract; inspect its source for real imports and supported states. Consult the project’s authored GUI design standard when the workspace supplies one. User-approved interaction changes take precedence over older examples.

## Choose the shared boundary

Before writing JSX, identify the existing component that owns the behavior. A page composes domain data and actions; shared primitives own sizing, overflow, focus and motion. Fix a repeated problem at that boundary and migrate real consumers in the same change. Do not retain a second implementation or turn a domain-specific card into a generic framework merely to reduce a file’s size.

- Addressable entities use `EntityRefLink` and the actual navigation callback. Keep the complete canonical reference available when the visible label is shortened. Do not infer entity kinds for arbitrary IDs.
- Non-addressable IDs use the shared ID display; records combine ID/state/prose/time/actions through the shared record layout. Check every supplied field, including non-null receipts and mixed-language long prose. Removing overlap is necessary but insufficient: give reading text enough width instead of squeezing it between metadata columns.
- Reuse status vocabulary, time formatting and interaction controls from the existing sources. Do not create page-local colors, raw timestamp formatting or duplicate button/switch implementations.
- Treat empty results as product information: explain absence and the next relevant action where needed. Do not fill dashboards with unrelated totals or decorative ratios. Each number needs a question, scope and actionable meaning.

## Bound long content

Every potentially long content surface—documents, logs, review prose, timelines and file previews—uses the shared bounded layout contract. Use `BoundedContent` and the shared `--long-content-cap` token, currently 55cqb of the sized `content-viewport`. Maximum height derives from the available container, not page-specific px/rem limits. Small content keeps its natural height; do not turn a maximum into a mandatory empty panel. Establish a finite parent height with shrinkable flex/grid children; keep titles, toolbars and primary actions outside the content scroll area. Overflow scrolls vertically inside that surface; wide tables/code scroll horizontally inside their own column without crossing adjacent text. Verify resizing, single/two-column layouts and nested wheel behavior. Reuse the shared document viewer rather than mounting independent Markdown renderers; declare unsupported formats truthfully and preserve actual binary bytes through the authorized daemon read path.

## Preserve interaction intent

Use a preview drawer when the user needs the surrounding list or canvas, and full detail when the task is processing that entity. Relationship graphs retain inline node reading and progressive exploration; explicit refocus changes the center. Opening full details and returning must preserve exploration state and viewport. Do not replace graph exploration with a universal drawer rule.

Use the existing motion configuration and reduced-motion preference. New shared interactions may extend the existing primitives; there is no frozen allowlist of animation files. Animate a defined interaction, keep text undistorted, and keep keyboard focus visible. A modal owns focus while open and returns it on close; a non-modal preview keeps its background reachable. Name icon-only controls and expose selected/disabled state semantically. Interactive targets must measure at least 40px in both axes under the actual font settings; rem-based classes alone do not establish this. Keep adjacent body/remove targets separate. Static chips may retain compact sizing.

## Verify the actual surface

Use focused behavior tests for the changed contract, then the repository’s applicable GUI checks. Prove the defect with the supported input that caused it; DOM class names alone do not prove layout. In Electron, measure the actual container and window size—minimum window constraints can invalidate a requested width. Include light/dark, narrow containers and keyboard paths when touched; exercise dynamic preference changes rather than module-load snapshots.

Electron verification is hidden by default, uses an independent profile and Playwright/CDP input, and never calls show/focus/bringToFront or controls the user’s keyboard. Waiting for a process does not mean foregrounding its window. Place the ephemeral Chromium profile/cache in a temporary directory outside task artifacts; publish only intended screenshots and evidence, never browser storage. Use the repository’s GUI capture/test tools, verify the selected project and final entity heading, wait for the intended content, and inspect the image. A loading screen or another entity is not acceptance. Wait for the relevant transition to settle before measuring or capturing; a wide-window drawer does not prove narrow-window detail behavior. Validate both the page and its opened detail at the actual narrow viewport. Copy tests must use an isolated clipboard or an explicit test boundary that captures the requested text; never save and restore the user’s system clipboard, which can overwrite content copied while the test runs. Label simulated clipboard checks honestly and never put existing clipboard contents in logs. Show a window only for an explicit user-requested demonstration.

Report the changed shared contract, real consumers migrated, old implementation removed, commands/results and material unverified behavior. A component catalog, passing structural check or worker self-report alone is not proof that the product page is usable.
