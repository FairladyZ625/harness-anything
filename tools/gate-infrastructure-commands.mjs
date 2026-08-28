/**
 * Workflow setup commands that do not correspond to manifest gates.
 *
 * Both gate-manifest checkers use this set to distinguish runner setup from
 * unmanifested gate commands in rewrite-ci.yml.
 */
export const INFRASTRUCTURE_COMMANDS = new Set([
  "npm ci",
  // Node 26 lanes build node-pty from setup-node's local headers instead of downloading them
  // (dec_047D7AD197D9D096837A0BB36B); the export is workspace setup, not a gate.
  'echo "npm_package_config_node_gyp_nodedir=$(dirname "$(dirname "$(command -v node)")")" >> "$GITHUB_ENV"',
  "git diff --check",
  "mkdir -p artifacts/gui-e2e",
  "sudo apt-get update && sudo apt-get install -y xvfb",
  // Building the packaged bin and configuring the checkout are properties of the runner, not
  // gates: no manifest gate can declare them because they run before any gate does.
  "npm run build -w @harness-anything/cli",
  "git config --global core.autocrlf true",
]);
