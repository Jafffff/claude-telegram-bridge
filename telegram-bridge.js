const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }

// Prefer CLAUDE_ACCESS_TOKEN (OAuth), fall back to ANTHROPIC_API_KEY
const API_KEY = process.env.CLAUDE_ACCESS_TOKEN || process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("CLAUDE_ACCESS_TOKEN or ANTHROPIC_API_KEY required"); process.exit(1); }
console.log(`Auth: ${API_KEY.slice(0, 25)}...`);

const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "6678076145", 10);
const TELEGRAM_MAX_LENGTH = 4096;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

const client = new Anthropic({ apiKey: API_KEY });

console.log(`Starting Claude Telegram Bridge`);
console.log(`Model: ${MODEL}`);
console.log(`API Key: ${API_KEY.slice(0, 20)}...`);

// ---------------------------------------------------------------------------
// State — per-user conversation history
// ---------------------------------------------------------------------------
const conversations = new Map(); // chatId -> messages[]

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
  await bot.sendMessage(msg.chat.id,
    `Model: ${MODEL}\nAPI Key: ${API_KEY.slice(0, 20)}...\nConversation: ${msgs.length} messages`
  );
});

bot.onText(/^\/debug$/, async (msg) => {
  if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");
  const typingInterval = startTypingLoop(msg.chat.id);
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 50,
      messages: [{ role: "user", content: "Say exactly: HELLO WORKING" }]
    });
    await sendReply(msg.chat.id, `Debug OK: ${res.content[0]?.text}`, msg.message_id);
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

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: "You are a helpful AI assistant. You have access to all the user's API credentials and tools via environment variables.",
      messages: history
    });

    const responseText = res.content[0]?.text || "(no response)";
    history.push({ role: "assistant", content: responseText });

    // Keep last 20 messages to avoid token overflow
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
