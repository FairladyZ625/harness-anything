export const daemonRepoModes = Object.freeze(["local", "remote-proxy", "remote-center", "remote-edge"] as const);
export type DaemonRepoMode = (typeof daemonRepoModes)[number];
