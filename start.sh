#!/bin/bash
set -e

echo "=== Claude Telegram Bridge Startup ==="

# Install claude-code to persistent volume if not already installed
CLAUDE_BIN_DIR="${DATA_DIR:-/data}/npm-global/bin"
if [ ! -f "$CLAUDE_BIN_DIR/claude" ]; then
  echo "Installing @anthropic-ai/claude-code to persistent volume (one-time)..."
  npm install -g @anthropic-ai/claude-code \
    --prefix "${DATA_DIR:-/data}/npm-global" \
    --no-audit --no-fund
  echo "Installation complete."
else
  echo "claude-code already installed, skipping."
fi
export PATH="$CLAUDE_BIN_DIR:$PATH"

# Use persistent volume for .claude dir so session survives restarts
CLAUDE_DATA_DIR="${DATA_DIR:-/data}/.claude"
mkdir -p "$CLAUDE_DATA_DIR"

# Symlink ~/.claude to persistent volume
rm -rf "$HOME/.claude"
ln -s "$CLAUDE_DATA_DIR" "$HOME/.claude"

# Write fresh OAuth credentials (always refresh from env on startup)
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  printf '%s' "$CLAUDE_OAUTH_CREDENTIALS" > "$HOME/.claude/credentials.json"
  chmod 600 "$HOME/.claude/credentials.json"
  echo "OAuth credentials written."
else
  echo "ERROR: CLAUDE_OAUTH_CREDENTIALS not set"
  exit 1
fi

# Allow all tools without interactive prompts
cat > "$HOME/.claude.json" << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  }
}
EOF

# Configure Telegram channel
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  mkdir -p "$HOME/.claude/channels/telegram"
  echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > "$HOME/.claude/channels/telegram/.env"
  echo "Telegram channel configured."
fi

echo "Starting Claude with channels..."
exec claude --channels plugin:telegram@claude-plugins-official
