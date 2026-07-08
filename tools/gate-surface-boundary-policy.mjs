export function boundaryAllowlistAuthorityFindings(gate, packageScripts) {
  const findings = [];
  if (gate.allowlistPolicy.allowed !== true) {
    return findings;
  }

  if (isBlank(gate.allowlistPolicy.location)) {
    findings.push(`${gate.id} allows an allowlist but does not declare allowlistPolicy.location.`);
  }
  if (gate.allowlistPolicy.adrOrDecisionRequired !== true) {
    findings.push(`${gate.id} allows an allowlist but does not require ADR/decision evidence.`);
  }

  const checkerPath = resolveGateCheckerPath(gate, packageScripts);
  const allowlistPath = normalizeManifestPath(gate.allowlistPolicy.location);
  if (checkerPath && allowlistPath === checkerPath) {
    findings.push(`${gate.id} allowlistPolicy.location must be outside the checker file ${checkerPath}.`);
  }

  return findings;
}

function resolveGateCheckerPath(gate, packageScripts) {
  const commandScriptNames = [];
  const npmRunMatch = /^npm run ([^&\s]+)$/.exec(gate.command);
  if (npmRunMatch) {
    commandScriptNames.push(npmRunMatch[1]);
  }
  const surfaceScript = gate.executionSurfaces?.packageJson?.script;
  if (surfaceScript) {
    commandScriptNames.push(surfaceScript);
  }

  for (const scriptName of new Set(commandScriptNames)) {
    const scriptCommand = packageScripts[scriptName];
    const scriptPath = parseNodeScriptPath(scriptCommand);
    if (scriptPath) {
      return scriptPath;
    }
  }

  return parseNodeScriptPath(gate.command);
}

function parseNodeScriptPath(command) {
  if (typeof command !== "string") {
    return null;
  }
  const match = /^node\s+([^\s]+\.mjs)(?:\s|$)/u.exec(command.trim());
  return match ? normalizeManifestPath(match[1]) : null;
}

function normalizeManifestPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.split("#")[0].replace(/\\/gu, "/");
}

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}
