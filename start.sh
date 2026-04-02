#!/bin/bash
set -e

# Write OAuth credentials so Claude Code can auth without interactive login
mkdir -p ~/.claude
printf '%s' "$CLAUDE_OAUTH_CREDENTIALS" > ~/.claude/credentials.json
chmod 600 ~/.claude/credentials.json

# Allow all tools without permission prompts
cat > ~/.claude.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
  }
}
EOF

echo "Credentials written, starting Telegram bridge..."
exec node /app/telegram-bridge.js
