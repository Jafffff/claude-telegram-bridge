#!/bin/bash
set -e

# Setup runs as root (Zeabur forces root), then we drop to 'node' user for Claude Code
NODE_HOME=/home/node

mkdir -p "$NODE_HOME/.claude" "$NODE_HOME/.claude/channels/telegram"

if [ -z "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  echo "CLAUDE_OAUTH_CREDENTIALS required"
  exit 1
fi

echo "$CLAUDE_OAUTH_CREDENTIALS" > "$NODE_HOME/.claude/.credentials.json"
chmod 600 "$NODE_HOME/.claude/.credentials.json"

# Write claude settings (auto-accept tools)
cat > "$NODE_HOME/.claude.json" <<SETTINGS
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  }
}
SETTINGS

# Configure Telegram bot token
echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > "$NODE_HOME/.claude/channels/telegram/.env"

# Pre-configure access (skip pairing, user already allowlisted)
cat > "$NODE_HOME/.claude/channels/telegram/access.json" <<ACCESS
{
  "dmPolicy": "allowlist",
  "allowFrom": ["$AUTHORIZED_USER_ID"],
  "groups": {},
  "ackReaction": "👀",
  "replyToMode": "first",
  "textChunkLimit": 4096,
  "chunkMode": "newline"
}
ACCESS

# Fix ownership for node user
chown -R node:node "$NODE_HOME"

# Install plugin marketplace + telegram plugin as node user
if [ ! -f "$NODE_HOME/.claude/plugins/installed_plugins.json" ]; then
  echo "Installing Telegram plugin..."
  su -s /bin/bash node -c "HOME=$NODE_HOME claude plugin marketplace add https://github.com/anthropics/claude-plugins-official 2>&1" || true
  su -s /bin/bash node -c "HOME=$NODE_HOME claude plugin install telegram@claude-plugins-official 2>&1" || true
fi

# CRITICAL: Unset OpenRouter vars that hijack Claude Code API calls
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_API_KEY
unset NODE_OPTIONS

# Debug: verify environment before launching
echo "=== DEBUG: Pre-launch environment ==="
echo "HOME=$NODE_HOME"
echo "TELEGRAM_BOT_TOKEN set: $([ -n "$TELEGRAM_BOT_TOKEN" ] && echo 'yes' || echo 'NO')"
echo "ANTHROPIC_BASE_URL set: $([ -n "$ANTHROPIC_BASE_URL" ] && echo 'YES (BAD)' || echo 'unset (good)')"
echo "bun location: $(which bun 2>/dev/null || echo 'NOT FOUND')"
echo "claude location: $(which claude 2>/dev/null || echo 'NOT FOUND')"
echo ".env contents: $(cat $NODE_HOME/.claude/channels/telegram/.env 2>/dev/null)"
echo "access.json exists: $([ -f $NODE_HOME/.claude/channels/telegram/access.json ] && echo 'yes' || echo 'no')"
echo "credentials.json exists: $([ -f $NODE_HOME/.claude/.credentials.json ] && echo 'yes' || echo 'no')"
echo "installed_plugins.json exists: $([ -f $NODE_HOME/.claude/plugins/installed_plugins.json ] && echo 'yes' || echo 'no')"
ls -la "$NODE_HOME/.claude/plugins/" 2>/dev/null || echo "No plugins dir"
echo "=== END DEBUG ==="

echo "Starting Claude Code with Telegram channel..."
# Drop to node user + allocate pseudo-TTY via 'script'
# --dangerously-skip-permissions requires non-root
# Pass --debug to see channel/MCP server startup details
exec su -s /bin/bash node -c "export HOME=$NODE_HOME && exec script -qc 'claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --debug' /dev/null"
