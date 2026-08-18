export const daemonRepoModes = Object.freeze(["local", "remote-center", "remote-edge"] as const);
export type DaemonRepoMode = (typeof daemonRepoModes)[number];
