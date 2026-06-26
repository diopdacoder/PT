#!/usr/bin/env bash
# Wrapper script run by launchd. Finds node, sets PATH, runs the morning brief,
# and appends output to logs/morning-brief.log. Safe to run by hand for testing.
set -e

# cd to project root regardless of where launchd invoked us from.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_DIR"

# Path setup. launchd starts with a minimal PATH; cover the common Node install spots.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.volta/bin:$HOME/.fnm/aliases/default/bin:$PATH"

# nvm: if it's installed, source the latest version.
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)"
  if [ -n "$LATEST_NVM_NODE" ]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NVM_NODE/bin:$PATH"
  fi
fi

# Resolve node, with explicit fallbacks.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for p in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" \
    "$HOME/.volta/bin/node"
  do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "$(date): error: node binary not found" >&2
  exit 1
fi

mkdir -p logs

echo "$(date '+%Y-%m-%d %H:%M:%S') --- morning brief starting (node=$NODE_BIN) ---" >> logs/morning-brief.log
exec "$NODE_BIN" cron/morning-brief.js >> logs/morning-brief.log 2>&1
