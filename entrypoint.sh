#!/bin/bash
set -e

# Write OAuth credentials
mkdir -p /root/.claude /root/.claude/channels/telegram

if [ -z "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  echo "CLAUDE_OAUTH_CREDENTIALS required"
  exit 1
fi

echo "$CLAUDE_OAUTH_CREDENTIALS" > /root/.claude/.credentials.json
chmod 600 /root/.claude/.credentials.json

# Write claude settings (auto-accept tools)
cat > /root/.claude.json <<SETTINGS
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  }
}
SETTINGS

# Configure Telegram bot token
echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > /root/.claude/channels/telegram/.env

# Pre-configure access (skip pairing, user already allowlisted)
cat > /root/.claude/channels/telegram/access.json <<ACCESS
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

# Install plugin marketplace + telegram plugin if not already installed
if [ ! -f /root/.claude/plugins/installed_plugins.json ]; then
  echo "Installing Telegram plugin..."
  claude plugin marketplace add https://github.com/anthropics/claude-plugins-official 2>&1 || true
  claude plugin install telegram@claude-plugins-official 2>&1 || true
fi

# CRITICAL: Unset OpenRouter vars that hijack Claude Code API calls
# These are set for OpenClaw but break Claude Code CLI auth
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_API_KEY
unset NODE_OPTIONS

echo "Starting Claude Code with Telegram channel..."
exec claude --channels plugin:telegram@claude-plugins-official
