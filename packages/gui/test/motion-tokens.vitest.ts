// harness-test-tier: fast
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { MOTION_DURATION, MOTION_EASE } from "../src/renderer/motion-tokens.ts";

/**
 * A5 动效 token 守卫(gui-visual-language-standard §6;W0 调研 A5):motion-tokens.ts
 * 是动效时长/缓动的唯一来源。两层断言:
 * 1) 当前档位钉死——调整节奏只改 motion-tokens.ts 并同步这里,「收敛/调整」不许顺手
 *    改别处(entry 三档 2026-10-17 按业主体感放慢,见 token 注释);
 * 2) 源扫描阴性对照——动效组件里再出现时长数字字面量即红,旧常量回潮会被拦住
 *    (删掉 token 消费、内联秒数,本文件变红)。
 */

/** 收敛后仍持有动效参数的原语;新动效进原语时同步加到这里。 */
const ANIMATED_PRIMITIVES = ["Modal.tsx", "Drawer.tsx", "FocusLayer.tsx", "EntryBoundary.tsx", "SegCtl.tsx"] as const;

it("pins the current per-tier values", () => {
  expect(MOTION_DURATION).toEqual({
    overlayRise: 0.3,
    overlayFall: 0.18,
    drawerSlide: 0.38,
    focusScrim: 0.35,
    focusGrow: 0.42,
    entryRise: 0.26,
    entryStagger: 0.04,
    entryMaxDelay: 0.16,
    controlSlide: 0.18,
    reducedFade: 0.1,
  });
  expect(MOTION_EASE).toEqual({ out: "easeOut", in: "easeIn", panel: [0.2, 0.85, 0.25, 1] });
  // 入场放慢(业主体感 2026-10-17)后的两条界:入场落在目标区间 0.24–0.30s;
  // 整段入场(含错开封顶)不超过 0.45s——「不拖沓」的上界,越界即视为回潮或误调。
  expect(MOTION_DURATION.entryRise).toBeGreaterThanOrEqual(0.24);
  expect(MOTION_DURATION.entryRise).toBeLessThanOrEqual(0.3);
  expect(MOTION_DURATION.entryRise + MOTION_DURATION.entryMaxDelay).toBeLessThanOrEqual(0.45);
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
