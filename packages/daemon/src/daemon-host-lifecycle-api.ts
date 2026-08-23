import type { DaemonHost } from "./daemon-host.ts";

export function createDaemonHostLifecycleApi(
  context: any,
): Pick<DaemonHost, "status" | "startAttachments" | "attachmentsSettled" | "close"> {
  return {
    status: () => {
      const observedBuild = context.buildObserver.status(),
        build = {
          ...observedBuild,
          version: process.env.npm_package_version ?? "0.0.0",
        },
        base = [
          "daemon status: pid=",
          `${process.pid}`,
          " repos=",
          `${context.cells.size + context.warming.size + context.unavailable.size}`,
          "",
        ].join(""),
        summary = observedBuild.drifted
          ? [
              "",
              `${base}`,
              " \u2014 build drift: daemon loaded dist build ",
              `${observedBuild.loadedBuildId ?? "missing"}`,
              " while disk has ",
              `${observedBuild.diskBuildId ?? "missing"}`,
              "; it will keep serving the loaded build. Run `ha daemon stop`; the next ",
              "command will autostart the disk build.",
            ].join("")
          : base;
      return {
        daemonId: context.input.daemonId,
        pid: process.pid,
        startedAt: context.startedAt,
        build,
        repos: [
          ...[...context.cells.values()].map((cell) => cell.status()),
          ...context.warming.values(),
          ...context.unavailable.values(),
        ].sort((a, b) => a.repoId.localeCompare(b.repoId)),
        summary,
      };
    },
    startAttachments: () => {
      void context.startInitialAttachments();
    },
    attachmentsSettled: context.startInitialAttachments,
    close: async () => {
      context.closing = true;
      if (context.initialAttachments) await context.initialAttachments;
      for (const repoId of [...context.warming.keys()]) context.settleWarming(repoId);
      if (context.fleetCenter) await context.fleetCenter.close();
      for (const runtime of context.fleetEdgeRuntimes.values()) runtime.close();
      context.fleetEdgeRuntimes.clear();
      await Promise.all([...context.cells.values()].map((cell) => cell.close()));
    },
  };
}
