// harness-test-tier: fast
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { MOTION_DURATION, MOTION_EASE } from "../src/renderer/motion-tokens.ts";

/**
 * A5 动效 token 守卫(gui-visual-language-standard §6;W0 调研 A5):motion-tokens.ts
 * 是动效时长/缓动的唯一来源。两层断言:
 * 1) 迁移数值钉死——token 与各组件收敛前的硬编码逐一相等,「收敛」不许顺手改节奏;
 * 2) 源扫描阴性对照——动效组件里再出现时长数字字面量即红,旧常量回潮会被拦住
 *    (删掉 token 消费、内联秒数,本文件变红)。
 */

/** 收敛后仍持有动效参数的原语;新动效进原语时同步加到这里。 */
const ANIMATED_PRIMITIVES = ["Modal.tsx", "Drawer.tsx", "FocusLayer.tsx", "EntryBoundary.tsx", "SegCtl.tsx"] as const;

it("preserves the audited per-component values from before the token migration", () => {
  expect(MOTION_DURATION).toEqual({
    overlayRise: 0.3,
    overlayFall: 0.18,
    drawerSlide: 0.38,
    focusScrim: 0.35,
    focusGrow: 0.42,
    entryRise: 0.16,
    entryStagger: 0.025,
    entryMaxDelay: 0.1,
    controlSlide: 0.18,
    reducedFade: 0.1,
  });
  expect(MOTION_EASE).toEqual({ out: "easeOut", in: "easeIn", panel: [0.2, 0.85, 0.25, 1] });
});

it("keeps every animated primitive on the token module with no local duration literals", () => {
  for (const file of ANIMATED_PRIMITIVES) {
    const source = readFileSync(
      fileURLToPath(new URL(`../src/renderer/components/primitives/${file}`, import.meta.url)),
      "utf8",
    );
    expect(source, `${file} must consume the motion tokens`).toContain('from "../../motion-tokens.ts"');
    // 大小写不敏感以覆盖 enterDuration 一类驼峰键;token 引用(duration: MOTION_DURATION.x)不带数字,不命中。
    expect(source.match(/duration:\s*[0-9]/giu) ?? [], `${file} must not hardcode durations`).toEqual([]);
  }
});
