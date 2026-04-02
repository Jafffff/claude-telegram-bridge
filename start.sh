#!/bin/bash
set -e

echo "=== Claude Telegram Bridge Startup ==="

# Setup credentials from env var if provided
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  mkdir -p ~/.claude
  echo "$CLAUDE_OAUTH_CREDENTIALS" > ~/.claude/credentials.json
  chmod 600 ~/.claude/credentials.json
  echo "OAuth credentials written to ~/.claude/credentials.json"
fi

# Setup .claude.json config if not present
if [ ! -f ~/.claude.json ]; then
  cat > ~/.claude.json << 'CONFIGEOF'
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"
    ]
  },
  "skipDangerousModePermissionPrompt": true
}
CONFIGEOF
  echo "Created ~/.claude.json"
fi

# Setup Telegram channel config
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  mkdir -p ~/.claude/channels/telegram
  echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > ~/.claude/channels/telegram/.env
  chmod 600 ~/.claude/channels/telegram/.env
  echo "Telegram bot token configured"
fi

# Install the official Telegram plugin if not already installed
echo "Installing Telegram plugin..."
claude plugin install telegram@claude-plugins-official 2>/dev/null || true

echo "Starting Claude Code with channels..."
# Run with channels enabled
exec claude --channels
