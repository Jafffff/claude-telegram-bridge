#!/bin/bash
set -e

# Setup runs as root (Zeabur forces root), then we drop to 'node' user for Claude Code
NODE_HOME=/home/node
WORKSPACE="$NODE_HOME/data/workspace"

mkdir -p "$NODE_HOME/.claude" "$NODE_HOME/.claude/channels/telegram"

if [ -z "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  echo "CLAUDE_OAUTH_CREDENTIALS required"
  exit 1
fi

echo "$CLAUDE_OAUTH_CREDENTIALS" > "$NODE_HOME/.claude/.credentials.json"
chmod 600 "$NODE_HOME/.claude/.credentials.json"

# Write claude.json — skip onboarding + trust dialogs for headless operation
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

# Also write settings.json
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

# ── Persistent volume at /home/node/data ──
mkdir -p "$NODE_HOME/data/sessions" "$NODE_HOME/data/inbox" "$NODE_HOME/data/projects"
ln -sfn "$NODE_HOME/data/sessions" "$NODE_HOME/.claude/sessions"
ln -sfn "$NODE_HOME/data/inbox" "$NODE_HOME/.claude/channels/telegram/inbox"
ln -sfn "$NODE_HOME/data/projects" "$NODE_HOME/.claude/projects"

# ── Clone/update conquest-workspace repo ──
if [ -n "$GIT_TOKEN" ]; then
  if [ -d "$WORKSPACE/.git" ]; then
    echo "Pulling latest workspace..."
    git -C "$WORKSPACE" pull --ff-only 2>&1 || echo "Pull failed, using existing workspace"
  else
    echo "Cloning conquest-workspace..."
    git clone "https://$GIT_TOKEN@github.com/Jafffff/conquest-workspace.git" "$WORKSPACE" 2>&1
  fi
  # Configure git for commits from Clizzy
  git -C "$WORKSPACE" config user.name "Clizzy" 2>/dev/null || true
  git -C "$WORKSPACE" config user.email "clizzy@conquest.nyc" 2>/dev/null || true
fi

# ── Google OAuth tokens (gogcli) ──
# If tokens exist on persistent volume, symlink for gogcli
mkdir -p "$NODE_HOME/data/config/gogcli"
if [ -n "$GOOGLE_CLIENT_ID" ] && [ ! -f "$NODE_HOME/data/config/gogcli/credentials-conquest.json" ]; then
  cat > "$NODE_HOME/data/config/gogcli/credentials-conquest.json" <<GCRED
{
  "installed": {
    "client_id": "$GOOGLE_CLIENT_ID",
    "client_secret": "$GOOGLE_CLIENT_SECRET",
    "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"]
  }
}
GCRED
fi

# ── Cron: auto-save workspace to git every 15 min ──
cat > /etc/cron.d/workspace-autosave <<CRON
*/15 * * * * node cd $WORKSPACE && git add -A && git diff --cached --quiet || git commit -m "auto-save \$(date -u +\%Y-\%m-\%dT\%H:\%M:\%SZ)" && git push 2>&1 | logger -t workspace-autosave
CRON
chmod 644 /etc/cron.d/workspace-autosave
crontab -u node /etc/cron.d/workspace-autosave 2>/dev/null || true
service cron start 2>/dev/null || true

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
exec su -s /bin/bash node -c "export HOME=$NODE_HOME && exec script -qc 'claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions' /dev/null"
