#!/usr/bin/env bash
# One-shot installer. Copies the plist to ~/Library/LaunchAgents and loads it.
# Re-running is safe: it unloads any existing copy first.
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

PLIST_NAME="com.diop.pt.morning-brief.plist"
SRC="$SCRIPT_DIR/$PLIST_NAME"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Make wrapper executable.
chmod +x "$SCRIPT_DIR/morning-brief.sh"

# Make sure logs dir exists so launchd's StandardOutPath works.
mkdir -p "$PROJECT_DIR/logs"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DST"

# Reload (unload first if already loaded).
launchctl unload "$DST" 2>/dev/null || true
launchctl load "$DST"

echo "Installed: $DST"
echo
echo "Verify it's scheduled:"
echo "  launchctl list | grep com.diop.pt.morning-brief"
echo
echo "Run it on demand once to confirm wiring:"
echo "  launchctl start com.diop.pt.morning-brief"
echo "  tail -f $PROJECT_DIR/logs/morning-brief.log"
echo
echo "To uninstall later:"
echo "  launchctl unload $DST && rm $DST"
