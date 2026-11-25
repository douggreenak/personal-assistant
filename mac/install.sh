#!/bin/bash
# Installs the agent as a launchd job that runs every 60 seconds.
#   ./install.sh http://your-server.tailnet-name.ts.net:8090 <ASSISTANT_TOKEN>
set -eu
URL="${1:?usage: install.sh <assistant-url> <token>}"; TOKEN="${2:?usage: install.sh <assistant-url> <token>}"
DIR="$HOME/.assistant-agent"; mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/agent.sh" "$DIR/agent.sh"; chmod 755 "$DIR/agent.sh"
umask 077; printf 'ASSISTANT_URL=%s\nASSISTANT_TOKEN=%s\n' "$URL" "$TOKEN" > "$HOME/.assistant-agent.conf"
PLIST="$HOME/Library/LaunchAgents/com.assistant.agent.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.assistant.agent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/agent.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed. IMPORTANT: System Settings → Privacy & Security → Full Disk Access → add /bin/bash"
echo "(needed to read ~/Library/Messages/chat.db). Check $DIR/agent.log if nothing arrives."
