#!/usr/bin/env bash
# Publish step of .github/workflows/release-botmancers.yml (run from
# packages/mcp-server). It picks exactly one authentication mode:
#
#   bootstrap token  BOOTSTRAP_NPM_TOKEN is non-empty (the npm-publish
#                    environment's NPM_TOKEN secret is present). Only for the
#                    first publish, or as the documented rollback while the
#                    trusted publisher is still unproven (see RELEASING.md).
#   trusted (OIDC)   BOOTSTRAP_NPM_TOKEN is empty or unset. NODE_AUTH_TOKEN is
#                    unset (not empty) and setup-node's generated
#                    `_authToken=${NODE_AUTH_TOKEN}` npmrc entry is removed, so
#                    npm performs the OIDC token exchange instead of trying an
#                    empty or placeholder legacy token.
set -euo pipefail

registry_host='//registry.npmjs.org/'

if [ -n "${BOOTSTRAP_NPM_TOKEN:-}" ]; then
  echo "::warning::botmancers publish auth: bootstrap NPM_TOKEN (token mode). Remove the npm-publish NPM_TOKEN secret once trusted publishing is proven."
  export NODE_AUTH_TOKEN="$BOOTSTRAP_NPM_TOKEN"
else
  echo "botmancers publish auth: trusted publishing (OIDC); NODE_AUTH_TOKEN unset"
  # setup-node exports a placeholder NODE_AUTH_TOKEN for the whole job.
  unset NODE_AUTH_TOKEN
  for npmrc in "${NPM_CONFIG_USERCONFIG:-}" "$HOME/.npmrc" "$PWD/.npmrc"; do
    if [ -n "$npmrc" ] && [ -f "$npmrc" ]; then
      grep -v -F "${registry_host}:_authToken" "$npmrc" > "$npmrc.oidc" || true
      mv "$npmrc.oidc" "$npmrc"
    fi
  done
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
    echo "::error::No GitHub OIDC token is available (id-token: write missing?) and no bootstrap NPM_TOKEN is set; refusing to publish."
    exit 1
  fi
fi
unset BOOTSTRAP_NPM_TOKEN

npm publish --provenance --access public --tag canary
