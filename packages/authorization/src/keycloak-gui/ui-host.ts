import type { ReactNode, HTMLAttributes, ComponentType, JSX } from "react";
export type RepoMode = "local" | "remote-proxy" | "remote-center" | "remote-edge";
export type MessageKey = string;
export type StatusTone =
  | "done"
  | "active"
  | "wait"
  | "plan"
  | "cancel"
  | "bad"
  | "neutral"
  | "agent-question"
  | "agent-working";
type ModalSurfaceProps = {
  readonly title: string;
  readonly hint?: string;
  readonly wide?: boolean;
  readonly testId?: string;
  /** 未传时不渲染 footer 带;外壳 85dvh 限高,长内容在正文内滚动。 */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
};
/** The embedding application supplies its real shared controls and display preferences. */
export interface KeycloakUiHost {
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
  readonly formatTime: (
    value: string | number,
    options?: {
      readonly style?: "date" | "date-time" | "date-time-seconds" | "month-day-time" | "time" | "time-seconds";
    },
  ) => string | null;
  readonly Button: ComponentType<{
    readonly variant?: "plain" | "primary" | "danger" | "ghost";
    readonly size?: "sm" | "md";
    readonly type?: "button" | "submit";
    readonly tip?: string;
    readonly testId?: string;
    readonly ariaLabel?: string;
    readonly disabled?: boolean;
    /** Keep original children in place; CSS reveals feedback after 100ms. */
    readonly loading?: boolean;
    readonly onClick?: () => void;
    readonly children: ReactNode;
  }>;
  readonly DenseRow: ComponentType<{
    readonly index?: number | string;
    readonly tag?: ReactNode;
    readonly title: ReactNode;
    readonly reason?: ReactNode;
    readonly time?: ReactNode;
    readonly action?: ReactNode;
    readonly relaxed?: boolean;
    readonly selected?: boolean;
    /** 行悬停全文:主文字被收束(可读名、人话短语)时,原始机器串放这里(视觉基线 v2)。 */
    readonly hoverTitle?: string;
    readonly onClick?: () => void;
  }>;
  readonly StatusTag: ComponentType<{
    /** 状态词(标签默认取 STATUS_META,可被 label 覆盖)。 */

    /** 显式 tone:状态词表之外的标签必给;与 status 同给时以 tone 为准。 */
    readonly tone?: StatusTone;
    /** 自定义标签(状态词表之外,或对状态词换措辞)。 */
    readonly label?: ReactNode;
    /** 前置图标:随标签同色。 */
    readonly icon?: ReactNode;
    /** 尾部计数(等宽表格数字)。 */
    readonly count?: number | string;
    /** 等宽小档:机器词/ID 类标签。 */
    readonly mono?: boolean;
    readonly tip?: string;
    readonly testId?: string;
  }>;
  readonly BrowserView: ComponentType<{
    readonly initialUrl?: string | null;
    /**
     * Webview partition the main process authorized for this surface; absent is the ordinary
     * in-app browser session. A login token names no session — the main process swaps it for the
     * sign-in's isolated partition when the webview attaches.
     */
    readonly partition?: string;
    /** Notified on every load state change: the failing description, or null once a load starts or settles. */
    readonly onLoadError?: (error: string | null) => void;
  }>;
  readonly Region: ComponentType<{
    readonly title: ReactNode;
    readonly tag?: ReactNode;
    readonly big?: number | string;
    readonly bigTone?: StatusTone;
    readonly edge?: StatusTone;
    readonly footer?: ReactNode;
    readonly focusId?: string;
    readonly focusOpen?: boolean;
    readonly onOpen?: () => void;
    readonly padded?: boolean;
    readonly children: ReactNode;
  }>;
  readonly BoardColumn: ComponentType<Pick<HTMLAttributes<HTMLDivElement>, "children">>;
  readonly BoardMain: ComponentType<HTMLAttributes<HTMLDivElement>>;
  readonly BoardRegion: ComponentType<
    HTMLAttributes<HTMLDivElement> & { readonly region: string; readonly fill?: boolean }
  >;
  readonly BoardSide: ComponentType<HTMLAttributes<HTMLDivElement> & { readonly region: string }>;
  readonly RegionBoard: ComponentType<
    HTMLAttributes<HTMLDivElement> & {
      readonly side?: "aside" | "primary";
    }
  >;
  readonly currentLocale: () => string;
  readonly BoundedContent: ComponentType<{
    readonly children: ReactNode;
    readonly className?: string;
  }>;
  readonly IdText: ComponentType<{
    /** 完整原值;显示与 title 都基于它,调用方不做预截断。 */
    readonly value: string;
    /** 悬停前缀(人话说明等);完整值始终拼在后面,不因它丢失。 */
    readonly title?: string;
    className?: string;
  }>;
  readonly Modal: ComponentType<ModalSurfaceProps & { readonly open: boolean }>;
  readonly RecordRow: ComponentType<{
    /** 标识域(长 ID):传展示叶 IdText/EntityRefLink,截断由叶与列收缩共同承担。 */
    readonly id: ReactNode;
    /** 标识域下方的状态词行(verdict/result 等),可选。 */
    readonly state?: ReactNode;
    /** 长正文域:独占全宽,词内换行。 */
    readonly summary: ReactNode;
    /** 时间域(元数据行行尾),可选。 */
    readonly time?: ReactNode;
    /** 行尾动作位(完整值复制等出口,标准 §4.1:不在截断文字上叠按钮),可选。 */
    readonly action?: ReactNode;
    /** 时间线聚焦态。 */
    readonly focused?: boolean;
    /** 滚动锚点(时间线聚焦 scrollIntoView 的目标)。 */
    readonly domId?: string;
    readonly testId?: string;
  }>;
  readonly SegCtl: <T extends string>(props: {
    readonly value: T | null;
    readonly options: readonly {
      readonly value: T;
      readonly label: string;
      readonly tip?: string;
      readonly testId?: string;
    }[];
    readonly onChange: (value: T) => void;
    readonly label?: string;
    readonly disabled?: boolean;
  }) => JSX.Element;
}
