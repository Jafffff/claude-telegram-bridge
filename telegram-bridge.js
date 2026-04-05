const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ---------------------------------------------------------------------------
// Write OAuth credentials so claude CLI can auth without interactive login
// ---------------------------------------------------------------------------
if (!process.env.CLAUDE_OAUTH_CREDENTIALS) {
  console.error("CLAUDE_OAUTH_CREDENTIALS required");
  process.exit(1);
}
const claudeDir = path.join(os.homedir(), ".claude");
fs.mkdirSync(claudeDir, { recursive: true });
// Note: Claude Code on Linux expects ".credentials.json" (leading dot)
fs.writeFileSync(path.join(claudeDir, ".credentials.json"), process.env.CLAUDE_OAUTH_CREDENTIALS, { mode: 0o600 });
fs.writeFileSync(path.join(os.homedir(), ".claude.json"), JSON.stringify({
  skipDangerousModePermissionPrompt: true,
  permissions: { allow: ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"] }
}));
console.log("OAuth credentials written.");

// Path to claude CLI installed as local npm dep
const CLAUDE_BIN = path.join(__dirname, "node_modules", ".bin", "claude");

// ---------------------------------------------------------------------------
// OAuth token auto-refresh (Claude Code CLI doesn't refresh in -p mode)
// ---------------------------------------------------------------------------
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
let currentCredentials = JSON.parse(process.env.CLAUDE_OAUTH_CREDENTIALS);

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function ensureFreshToken() {
  const creds = currentCredentials.claudeAiOauth;
  if (creds.expiresAt > Date.now() + 5 * 60 * 1000) {
    return creds.accessToken;
  }

  console.log("OAuth token expired or expiring soon, refreshing...");

  const res = await httpsPost(OAUTH_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  if (res.status !== 200) {
    throw new Error(`Token refresh failed (${res.status}): ${res.body}`);
  }

  const tok = JSON.parse(res.body);
  creds.accessToken = tok.access_token;
  creds.refreshToken = tok.refresh_token;
  creds.expiresAt = Date.now() + (tok.expires_in * 1000);

  // Rewrite .credentials.json so the CLI picks up fresh creds
  const credJson = JSON.stringify(currentCredentials);
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), credJson, { mode: 0o600 });
  console.log("OAuth token refreshed. New expiry:", new Date(creds.expiresAt).toISOString());

  // Persist to Zeabur env var so restarts use fresh creds
  const zbToken = process.env.ZEABUR_API_TOKEN;
  const zbSvc = process.env.ZEABUR_SERVICE_ID;
  const zbEnv = process.env.ZEABUR_ENVIRONMENT_ID;
  if (zbToken && zbSvc && zbEnv) {
    const gql = JSON.stringify({ query: `mutation { updateSingleEnvironmentVariable(serviceID: "${zbSvc}", environmentID: "${zbEnv}", oldKey: "CLAUDE_OAUTH_CREDENTIALS", newKey: "CLAUDE_OAUTH_CREDENTIALS", value: ${JSON.stringify(credJson)}) { key } }` });
    httpsPost("https://api.zeabur.com/graphql", gql, { Authorization: `Bearer ${zbToken}` })
      .then(r => console.log("Zeabur env var updated:", r.status))
      .catch(e => console.error("Zeabur env var update failed:", e.message));
  }

  return creds.accessToken;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }

const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "6678076145", 10);
const TELEGRAM_MAX_LENGTH = 4096;

console.log("Starting Claude Telegram Bridge (Claude Code CLI)");

// ---------------------------------------------------------------------------
// Call claude CLI
// ---------------------------------------------------------------------------
async function callClaude(messages) {
  // Build prompt: include conversation history so Claude has context
  let prompt;
  if (messages.length === 1) {
    prompt = messages[0].content;
  } else {
    const history = messages.slice(0, -1)
      .map(m => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const last = messages[messages.length - 1].content;
    prompt = `${history}\n\nHuman: ${last}\n\nRespond to the Human's latest message, taking the conversation history into account.`;
  }

  // Get a fresh access token (auto-refreshes if expired)
  const oauthToken = await ensureFreshToken();
  const args = ["-p", prompt];
  const model = process.env.CLAUDE_MODEL;
  if (model) args.push("--model", model);
  const child = spawn(CLAUDE_BIN, args, {
    env: { ...process.env, HOME: "/root", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
  });

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out after 2 minutes"));
    }, 120000);

    child.on("close", code => {
      clearTimeout(timer);
      const text = out.trim();
      if (text) resolve(text);
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });

    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const conversations = new Map();

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log("Bot polling started.");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAuthorized(msg) {
  return msg.from && msg.from.id === AUTHORIZED_USER_ID;
}

function splitMessage(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (idx < TELEGRAM_MAX_LENGTH * 0.3) idx = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    if (idx < TELEGRAM_MAX_LENGTH * 0.3) idx = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}

async function sendReply(chatId, text, replyToMessageId) {
  const chunks = splitMessage(text || "(empty response)");
  for (let i = 0; i < chunks.length; i++) {
    const opts = {};
    if (i === 0 && replyToMessageId) opts.reply_to_message_id = replyToMessageId;
    try {
      await bot.sendMessage(chatId, chunks[i], opts);
    } catch (err) {
      if (err.response?.statusCode === 429) {
        const wait = (err.response.body?.parameters?.retry_after || 5) * 1000;
        await new Promise(r => setTimeout(r, wait));
        i--;
      } else {
        console.error("Send error:", err.message);
      }
    }
  }
}

function startTypingLoop(chatId) {
  bot.sendChatAction(chatId, "typing").catch(() => {});
  return setInterval(() => bot.sendChatAction(chatId, "typing").catch(() => {}), 4000);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.onText(/^\/new$/, async (msg) => {
  if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");
  conversations.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "Conversation cleared.");
});

bot.onText(/^\/status$/, async (msg) => {
  if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");
  const msgs = conversations.get(msg.chat.id) || [];
  await bot.sendMessage(msg.chat.id, `Backend: Claude Code CLI (Max plan)\nConversation: ${msgs.length} messages`);
});

bot.onText(/^\/debug$/, async (msg) => {
  if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");
  const typingInterval = startTypingLoop(msg.chat.id);
  try {
    const text = await callClaude([{ role: "user", content: "Say exactly: HELLO WORKING" }]);
    await sendReply(msg.chat.id, `Debug OK: ${text}`, msg.message_id);
  } catch (err) {
    await sendReply(msg.chat.id, `Debug error: ${err.message}`, msg.message_id);
  } finally {
    clearInterval(typingInterval);
  }
});

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------
const activeLocks = new Set();

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;
  if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");

  const chatId = msg.chat.id;
  if (activeLocks.has(chatId)) {
    return bot.sendMessage(chatId, "Still processing, please wait.", { reply_to_message_id: msg.message_id });
  }

  activeLocks.add(chatId);
  const typingInterval = startTypingLoop(chatId);

  try {
    const history = conversations.get(chatId) || [];
    history.push({ role: "user", content: msg.text });

    const responseText = await callClaude(history);
    history.push({ role: "assistant", content: responseText });

    if (history.length > 20) history.splice(0, history.length - 20);
    conversations.set(chatId, history);

    console.log(`[chat:${chatId}] ${msg.text.slice(0, 50)} → ${responseText.slice(0, 80)}`);
    await sendReply(chatId, responseText, msg.message_id);
  } catch (err) {
    console.error(`[chat:${chatId}] Error:`, err.message);
    await sendReply(chatId, `Error: ${err.message}`, msg.message_id);
  } finally {
    clearInterval(typingInterval);
    activeLocks.delete(chatId);
  }
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
process.on("SIGINT", () => { bot.stopPolling(); process.exit(0); });
process.on("SIGTERM", () => { bot.stopPolling(); process.exit(0); });
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));
