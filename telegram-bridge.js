const TelegramBot = require("node-telegram-bot-api");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "6678076145", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || String(5 * 60 * 1000), 10); // 5 min
const TELEGRAM_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Ensure Claude auth credentials are in place
// ---------------------------------------------------------------------------
function setupCredentials() {
  // If CLAUDE_OAUTH_CREDENTIALS env var is set, write it to the credentials file
  const oauthCreds = process.env.CLAUDE_OAUTH_CREDENTIALS;
  if (oauthCreds) {
    const credsDir = path.join(process.env.HOME || "/root", ".claude");
    const credsFile = path.join(credsDir, "credentials.json");
    try {
      fs.mkdirSync(credsDir, { recursive: true });
      fs.writeFileSync(credsFile, oauthCreds, { mode: 0o600 });
      console.log("Wrote OAuth credentials to", credsFile);
    } catch (e) {
      console.error("Failed to write credentials:", e.message);
    }
  }

  // Ensure .claude.json config exists
  const configFile = path.join(process.env.HOME || "/root", ".claude.json");
  if (!fs.existsSync(configFile)) {
    try {
      fs.writeFileSync(configFile, JSON.stringify({
        permissions: {
          allow: ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"]
        },
        skipDangerousModePermissionPrompt: true
      }));
      console.log("Created .claude.json config");
    } catch (e) {
      console.error("Failed to create .claude.json:", e.message);
    }
  }
}

setupCredentials();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const sessions = new Map(); // chatId -> sessionId
const activeLocks = new Set(); // chatIds currently processing

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("Claude Telegram Bridge started. Waiting for messages...");

// ---------------------------------------------------------------------------
// Authorization guard
// ---------------------------------------------------------------------------
function isAuthorized(msg) {
  return msg.from && msg.from.id === AUTHORIZED_USER_ID;
}

function unauthorized(msg) {
  return bot.sendMessage(msg.chat.id, "Unauthorized.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split text into chunks that fit within Telegram's message limit. */
function splitMessage(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIdx < TELEGRAM_MAX_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    }
    if (splitIdx < TELEGRAM_MAX_LENGTH * 0.3) {
      splitIdx = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Send a (possibly long) reply, splitting as needed. */
async function sendReply(chatId, text, replyToMessageId) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const opts = {};
    if (i === 0 && replyToMessageId) opts.reply_to_message_id = replyToMessageId;
    try {
      await bot.sendMessage(chatId, chunks[i], opts);
    } catch (err) {
      if (err.response && err.response.statusCode === 429) {
        const retryAfter = (err.response.body?.parameters?.retry_after || 5) * 1000;
        console.warn(`Rate limited. Retrying after ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
        i--;
      } else {
        console.error("Failed to send message:", err.message);
      }
    }
  }
}

/** Keep sending "typing" indicator while a process is running. */
function startTypingLoop(chatId) {
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  bot.sendChatAction(chatId, "typing").catch(() => {});
  return interval;
}

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------

function runClaude(prompt, chatId) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
    ];

    const sessionId = sessions.get(chatId);
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(`[chat:${chatId}] Spawning claude with args:`, args.map((a, i) => i === 1 ? `"${a.slice(0, 80)}..."` : a).join(" "));

    const proc = spawn("claude", args, {
      env: {
        ...process.env,
        CLAUDE_CODE_HEADLESS: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      console.log(`[chat:${chatId}] stdout chunk:`, d.toString().slice(0, 200));
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      console.error(`[chat:${chatId}] stderr:`, d.toString().slice(0, 500));
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      console.log(`[chat:${chatId}] Claude exited code=${code} stdout=${stdout.length}b stderr=${stderr.length}b`);

      // If there's stderr content, include it in debug
      if (stderr.trim()) {
        console.error(`[chat:${chatId}] Full stderr:`, stderr.slice(0, 1000));
      }

      if (code !== 0) {
        const errMsg = stderr.trim() || stdout.trim() || `Process exited with code ${code}`;
        reject(new Error(errMsg.slice(0, 2000)));
        return;
      }

      // If stdout is empty, report it with any stderr context
      if (!stdout.trim()) {
        const debugInfo = stderr.trim() ? `Empty response. stderr: ${stderr.slice(0, 500)}` : "(empty response - no output from claude)";
        resolve(debugInfo);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const sessionIdOut = parsed.session_id;
        if (sessionIdOut) {
          sessions.set(chatId, sessionIdOut);
          console.log(`[chat:${chatId}] Session: ${sessionIdOut}`);
        }

        let responseText = "";
        if (typeof parsed.result === "string") {
          responseText = parsed.result;
        } else if (parsed.result && typeof parsed.result === "object") {
          responseText = parsed.result.text || parsed.result.content || JSON.stringify(parsed.result, null, 2);
        } else {
          responseText = JSON.stringify(parsed, null, 2);
        }

        resolve(responseText || "(claude returned empty result)");
      } catch (parseErr) {
        console.warn(`[chat:${chatId}] JSON parse failed, returning raw output`);
        resolve(stdout.trim());
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

bot.onText(/^\/new$/, async (msg) => {
  if (!isAuthorized(msg)) return unauthorized(msg);
  sessions.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "Session cleared. Next message starts a fresh conversation.");
});

bot.onText(/^\/status$/, async (msg) => {
  if (!isAuthorized(msg)) return unauthorized(msg);

  const chatId = msg.chat.id;
  const sessionId = sessions.get(chatId) || "(none)";
  const isProcessing = activeLocks.has(chatId);

  let statusText = `Status:\n`;
  statusText += `Session: ${sessionId}\n`;
  statusText += `Processing: ${isProcessing ? "yes" : "no"}\n`;

  // Claude version
  try {
    const version = execSync("claude --version 2>&1", { timeout: 10000 }).toString().trim();
    statusText += `Claude: ${version}\n`;
  } catch (e) {
    statusText += `Claude: error - ${e.message.slice(0, 100)}\n`;
  }

  // Auth check
  try {
    const credsFile = path.join(process.env.HOME || "/root", ".claude", "credentials.json");
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
      const sub = creds.claudeAiOauth?.subscriptionType || "unknown";
      const tier = creds.claudeAiOauth?.rateLimitTier || "unknown";
      const expires = creds.claudeAiOauth?.expiresAt;
      const expiresStr = expires ? new Date(expires).toISOString() : "unknown";
      statusText += `Auth: ${sub} (${tier})\n`;
      statusText += `Token expires: ${expiresStr}\n`;
    } else {
      statusText += `Auth: no credentials file found\n`;
    }
  } catch (e) {
    statusText += `Auth: error reading credentials\n`;
  }

  // ANTHROPIC_API_KEY check
  statusText += `API Key: ${process.env.ANTHROPIC_API_KEY ? "set (" + process.env.ANTHROPIC_API_KEY.slice(0, 12) + "...)" : "not set"}\n`;

  await bot.sendMessage(chatId, statusText);
});

bot.onText(/^\/debug$/, async (msg) => {
  if (!isAuthorized(msg)) return unauthorized(msg);

  // Run a simple claude test and return raw output
  try {
    const result = execSync('claude -p "Say hello" --output-format json 2>&1', {
      timeout: 30000,
      env: { ...process.env, CLAUDE_CODE_HEADLESS: "1", DISABLE_AUTOUPDATER: "1" }
    }).toString();
    await sendReply(msg.chat.id, `Debug output:\n${result.slice(0, 3000)}`, msg.message_id);
  } catch (e) {
    await sendReply(msg.chat.id, `Debug error:\n${e.message.slice(0, 1000)}\n\nstdout: ${e.stdout?.toString().slice(0, 1000) || "none"}\nstderr: ${e.stderr?.toString().slice(0, 1000) || "none"}`, msg.message_id);
  }
});

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  if (!msg.text) return;
  if (!isAuthorized(msg)) return unauthorized(msg);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!text) return;

  if (activeLocks.has(chatId)) {
    await bot.sendMessage(chatId, "Still processing your previous message. Please wait.", {
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  activeLocks.add(chatId);
  const typingInterval = startTypingLoop(chatId);

  try {
    const response = await runClaude(text, chatId);
    await sendReply(chatId, response, msg.message_id);
  } catch (err) {
    console.error(`[chat:${chatId}] Error:`, err.message);
    await sendReply(chatId, `Error: ${err.message}`, msg.message_id);
  } finally {
    clearInterval(typingInterval);
    activeLocks.delete(chatId);
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  bot.stopPolling();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
