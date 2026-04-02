const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");

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

    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIdx < TELEGRAM_MAX_LENGTH * 0.3) {
      // If newline is too early, try a space
      splitIdx = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    }
    if (splitIdx < TELEGRAM_MAX_LENGTH * 0.3) {
      // Hard split
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
      // Telegram rate-limit: retry after the specified time
      if (err.response && err.response.statusCode === 429) {
        const retryAfter = (err.response.body?.parameters?.retry_after || 5) * 1000;
        console.warn(`Rate limited. Retrying after ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
        i--; // retry this chunk
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
  }, 4000); // Telegram typing indicator lasts ~5s, refresh every 4s
  // Also fire one immediately
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Timeout
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Claude process timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        console.error(`[chat:${chatId}] Claude error (code ${code}):`, errMsg);
        reject(new Error(errMsg));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        // The JSON output format returns { type, session_id, result }
        // result contains the text response
        const sessionIdOut = parsed.session_id;
        if (sessionIdOut) {
          sessions.set(chatId, sessionIdOut);
          console.log(`[chat:${chatId}] Session: ${sessionIdOut}`);
        }

        // Extract the response text
        let responseText = "";
        if (typeof parsed.result === "string") {
          responseText = parsed.result;
        } else if (parsed.result && typeof parsed.result === "object") {
          // Could be structured; try to get the text
          responseText = parsed.result.text || parsed.result.content || JSON.stringify(parsed.result, null, 2);
        } else {
          // Fallback: just stringify the whole thing
          responseText = stdout.trim();
        }

        resolve(responseText);
      } catch (parseErr) {
        // If JSON parsing fails, return raw stdout
        console.warn(`[chat:${chatId}] Could not parse JSON, returning raw output`);
        resolve(stdout.trim() || "(empty response)");
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

  let statusText = `*Status*\n`;
  statusText += `Session: \`${sessionId}\`\n`;
  statusText += `Processing: ${isProcessing ? "yes" : "no"}\n`;

  // Quick claude version check
  try {
    const proc = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const version = await new Promise((resolve) => {
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", () => resolve(out.trim()));
      setTimeout(() => { proc.kill(); resolve("timeout"); }, 5000);
    });
    statusText += `Claude: ${version}\n`;
  } catch {
    statusText += `Claude: not found\n`;
  }

  await bot.sendMessage(chatId, statusText, { parse_mode: "Markdown" });
});

bot.onText(/^\/session$/, async (msg) => {
  if (!isAuthorized(msg)) return unauthorized(msg);

  const sessionId = sessions.get(msg.chat.id);
  if (sessionId) {
    await bot.sendMessage(msg.chat.id, `Current session: \`${sessionId}\``, { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(msg.chat.id, "No active session.");
  }
});

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

bot.on("message", async (msg) => {
  // Skip commands
  if (msg.text && msg.text.startsWith("/")) return;
  // Skip non-text messages
  if (!msg.text) return;
  if (!isAuthorized(msg)) return unauthorized(msg);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!text) return;

  // Prevent concurrent requests per chat
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

// Catch unhandled errors so the process doesn't crash
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
