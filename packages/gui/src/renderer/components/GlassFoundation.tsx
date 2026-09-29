/**
 * S2 视觉基础的 DOM 挂点(dec_B3D40712A6B050D83F1C2EF78D CH3):环境光层与
 * #liquid 位移滤镜 def。两者都是全局装饰面,App 根部各挂一次;玻璃面本身用
 * styles.css 的 .glass/.glass-scrim/.glass-liquid,不在组件里重复。
 */

/** 环境光:玻璃可见性前提,色值与漂移节奏取自业主认可的样张(overview-prototype.html v4 .aurora)。 */
export function AuroraBackdrop() {
  return (
    <div aria-hidden="true" className="aurora">
      <i />
      <i />
      <i />
    </div>
  );
}

/** 供放大层(.glass-liquid 的 backdrop-filter)引用的液态折射滤镜 def;零尺寸 svg 不参与布局。 */
export function LiquidFilterDef() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
      <filter id="liquid" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves={2} seed={7} result="n" />
        <feGaussianBlur in="n" stdDeviation={2} result="nb" />
        <feDisplacementMap in="SourceGraphic" in2="nb" scale={38} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
