declare module "@deepseek-ai/cordis" {
  export interface Context {
    get(name: "profileContext"): { readonly name: string } | undefined;
    readonly subprocess: import("../../src/broker.ts").BrokerSubprocessRuntime;
    readonly webServer: {
      getOrigin(): string;
      register(route: {
        readonly kind: "exact" | "prefix";
        readonly path: string;
        readonly handler: (
          request: import("node:http").IncomingMessage,
          response: import("node:http").ServerResponse,
        ) => void | Promise<void>;
      }): () => void;
    };
    readonly workspaceRegistry: {
      list(): readonly { readonly path: string }[];
    };
    readonly effect: (factory: () => void | (() => void | Promise<void>), label?: string) => unknown;
    readonly logger: {
      info(message: string, ...args: readonly unknown[]): void;
      warn(message: string, ...args: readonly unknown[]): void;
    };
    readonly locale: {
      register(namespace: string, messages: Record<string, Record<string, string>>): () => void;
      bind(namespace: string): (key: string) => string;
    };
    readonly slots: {
      inject(name: string, factory: () => () => void): () => void;
      register(options: Record<string, unknown>, component: (props: never) => unknown): () => void;
    };
    readonly effect: (factory: () => void | (() => void), label?: string) => unknown;
    readonly sidebarRight: {
      openTab(kind: string, options: { readonly params: { readonly url: string } }): void;
    };
  }
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  export type PropsRuntime<Name extends string> = Name extends "sidebar.panellist"
    ? { readonly size: number; readonly active: boolean }
    : Record<string, never>;
}

declare module "@deepseek-ai/dsh-client-ui-sidebar/client" {
  export interface SidebarPanelIconOwnerProps {
    readonly size: number;
    readonly active: boolean;
  }
}
