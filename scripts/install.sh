#!/usr/bin/env bash
# Managed install of Botmancers (UI, core engine, and MCP bridge):
#
#   curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash
#
# Installs the npm `latest` botmancers into ~/.botmancers/versions/<version>,
# points ~/.botmancers/current at it, and writes the ~/.local/bin/botmancers
# launcher. Existing data, configuration, logs, and workdirs in ~/.botmancers
# are kept as they are. Pin a version with BOTMANCERS_VERSION=x.y.z; extra
# arguments go to `botmancers install` (e.g. --migrate-cli, --purge-global).
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Node.js 20.9+ (22+ recommended) with npm is required. Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi

spec="botmancers@${BOTMANCERS_VERSION:-latest}"
set -- ${BOTMANCERS_VERSION:+--to "$BOTMANCERS_VERSION"} "$@"

echo "Installing ${spec} into ${BOTMANCERS_HOME:-$HOME/.botmancers} (existing data kept) ..."
npx --yes "$spec" install "$@"

echo ""
echo "Make sure ~/.local/bin is on your PATH, then:"
echo "  botmancers doctor"
echo "  botmancers setup"
echo "  botmancers start --daemon --open"
