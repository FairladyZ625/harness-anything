/**
 * 动效 token(A5):GUI 动效时长与缓动的唯一来源(gui-visual-language-standard §6;
 * dec_AEE443D93D207C4AEB032E7881 CH2 的 Modal 动效同源迁入)。原各组件硬编码数值
 * 已全部收进这里,调整动效节奏只改本文件,不在组件里另写秒数或曲线。单位:秒(motion 库口径)。
 *
 * 曲线不用弹簧:CDS 参考预设全部带过冲(+1.8%~+19.4%),与现行规范「零过冲、不弹跳」冲突;
 * 控件与面板都用时长+缓出/减速曲线。
 */

/** 缓动曲线:进场与切换用缓出,退场收尾用缓入,大幅面板滑动用零过冲减速曲线。 */
export const MOTION_EASE = {
  out: "easeOut",
  in: "easeIn",
  panel: [0.2, 0.85, 0.25, 1],
} as const;

/** 时长档:布局类 300–550ms 缓出、切换档 140–180ms、减少动态效果 ≤120ms 纯淡入(§6)。 */
export const MOTION_DURATION = {
  /** Modal 进场上浮淡入;Drawer 压暗层同档。 */
  overlayRise: 0.3,
  /** Modal 退场下落淡出。 */
  overlayFall: 0.18,
  /** Drawer 面板滑入滑出。 */
  drawerSlide: 0.38,
  /** FocusLayer 压暗层。 */
  focusScrim: 0.35,
  /** FocusLayer 原位放大/收回。 */
  focusGrow: 0.42,
  /** 页面/页签切换的轻量上浮入场(业主体感 2026-10-17:0.16s 一闪而过,放慢到看得见不拖沓)。 */
  entryRise: 0.26,
  /** 切换入场区域依次错开(与 entryRise 同比例放慢)。 */
  entryStagger: 0.04,
  /** 切换入场错开封顶(与 entryRise 合计 ≤0.42s)。 */
  entryMaxDelay: 0.16,
  /** SegCtl 选中背景滑动指示(切换档上沿)。 */
  controlSlide: 0.18,
  /** 「减少动态效果」下保留的纯淡入,不位移。 */
  reducedFade: 0.1,
} as const;
