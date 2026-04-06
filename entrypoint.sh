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

# Write claude.json — MUST include hasCompletedOnboarding to skip interactive onboarding
# and hasTrustDialogAccepted for the working directory to skip trust prompt
cat > "$NODE_HOME/.claude.json" <<SETTINGS
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.92",
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  },
  "projects": {
    "/home/node": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
SETTINGS

# Also write settings.json for belt-and-suspenders
mkdir -p "$NODE_HOME/.claude"
cat > "$NODE_HOME/.claude/settings.json" <<SETTINGS2
{
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS2

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

# Persistent volume at /home/node/data — survives restarts
# Symlink session history and inbox so they persist
mkdir -p "$NODE_HOME/data/sessions" "$NODE_HOME/data/inbox" "$NODE_HOME/data/projects"
ln -sfn "$NODE_HOME/data/sessions" "$NODE_HOME/.claude/sessions"
ln -sfn "$NODE_HOME/data/inbox" "$NODE_HOME/.claude/channels/telegram/inbox"
ln -sfn "$NODE_HOME/data/projects" "$NODE_HOME/.claude/projects"

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

echo "Starting Claude Code with Telegram channel..."
# Drop to node user + allocate pseudo-TTY via 'script'
# --dangerously-skip-permissions requires non-root
exec su -s /bin/bash node -c "export HOME=$NODE_HOME && exec script -qc 'claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions' /dev/null"
