import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { getConfig } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { captureException } from "../utils/sentry.js";
import { markdownToTelegramHtml, markdownToTelegramChunks, escapeHtml, stripHtmlTags } from "./format.js";

const log = createChildLogger("telegram");

export interface ImageData {
  base64: string;
  mediaType: string;
}

export type MessageHandler = (
  text: string,
  messageId: number,
  chatId: number,
  replyToMessageId: number | null,
  replyToText: string | null,
  image: ImageData | null,
) => Promise<void>;

export type EditHandler = (
  text: string,
  messageId: number,
  chatId: number
) => Promise<void>;

export type CallbackQueryHandler = (
  data: string,
  messageId: number,
  chatId: number
) => Promise<void>;

let bot: Bot | null = null;
let messageHandler: MessageHandler | null = null;
let editHandler: EditHandler | null = null;
let callbackQueryHandler: CallbackQueryHandler | null = null;
let restartHandler: (() => Promise<void>) | null = null;

export function initTelegramBot(): Bot {
  const config = getConfig();
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  const allowedUsers = config.TELEGRAM_ALLOWED_USERS;

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUsers.includes(userId)) {
      log.warn({ userId }, "Unauthorized access attempt");
      if (userId) {
        await ctx.reply(
          `Unauthorized. Your user ID is: ${userId}\nAdd it to TELEGRAM_ALLOWED_USERS in .env`
        );
      }
      return;
    }
    await next();
  });

  // Text messages
  bot.on("message:text", async (ctx) => {
    if (!messageHandler) return;

    const text = ctx.message.text;
    const messageId = ctx.message.message_id;
    const chatId = ctx.chat.id;
    const replyTo = ctx.message.reply_to_message?.message_id ?? null;
    const replyToText = ctx.message.reply_to_message?.text ?? null;

    log.debug({ text, messageId, chatId, replyTo }, "Received message");

    try {
      await messageHandler(text, messageId, chatId, replyTo, replyToText, null);
    } catch (err) {
      log.error({ err }, "Error handling message");
      await ctx.reply("Internal error processing your message.");
    }
  });

  // Photo messages — download image, save to disk, pass path in text
  bot.on("message:photo", async (ctx) => {
    if (!messageHandler) return;

    const caption = ctx.message.caption ?? "";
    const messageId = ctx.message.message_id;
    const chatId = ctx.chat.id;
    const replyTo = ctx.message.reply_to_message?.message_id ?? null;
    const replyToText = ctx.message.reply_to_message?.text ?? ctx.message.reply_to_message?.caption ?? null;

    // Get the largest photo (last in array)
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    log.debug({ caption, messageId, chatId, replyTo, fileId: largest.file_id }, "Received photo");

    let image: ImageData | null = null;
    try {
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${getConfig().TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`Failed to download photo: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());

      // Save to data/images/ for reference
      const imagesDir = join(process.cwd(), "data", "images");
      if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
      const ext = file.file_path?.split(".").pop()?.toLowerCase() ?? "jpg";
      const filename = `${messageId}_${Date.now()}.${ext}`;
      const imagePath = join(imagesDir, filename);
      writeFileSync(imagePath, buffer);
      log.info({ imagePath, size: buffer.length }, "Photo saved to disk");

      // Pass image data with local path for Claude Code to read
      const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
      image = { base64: buffer.toString("base64"), mediaType, localPath: imagePath } as any;
    } catch (err) {
      log.error({ err }, "Failed to download/save photo");
      await ctx.reply("Failed to download the photo. Please try again.");
      return;
    }

    const text = caption || "[User sent a photo with no caption]";

    try {
      await messageHandler(text, messageId, chatId, replyTo, replyToText, image);
    } catch (err) {
      log.error({ err }, "Error handling photo message");
      await ctx.reply("Internal error processing your message.");
    }
  });

  // Message edits
  bot.on("edited_message:text", async (ctx) => {
    if (!editHandler || !ctx.editedMessage) return;

    const text = ctx.editedMessage.text!;
    const messageId = ctx.editedMessage.message_id;
    const chatId = ctx.chat.id;

    log.debug({ text, messageId, chatId }, "Received edited message");

    try {
      await editHandler(text, messageId, chatId);
    } catch (err) {
      log.error({ err }, "Error handling edit");
    }
  });

  // Inline keyboard callbacks
  bot.on("callback_query:data", async (ctx) => {
    if (!callbackQueryHandler) return;

    const data = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message?.message_id;
    const chatId = ctx.callbackQuery.message?.chat.id;

    if (!messageId || !chatId) return;

    await ctx.answerCallbackQuery();

    try {
      await callbackQueryHandler(data, messageId, chatId);
    } catch (err) {
      log.error({ err }, "Error handling callback query");
    }
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Conciergon active. Send me tasks for your projects.\n" +
        'Try: "fix the login bug in myapp"'
    );
  });

  // /status command
  bot.command("status", async (ctx) => {
    if (messageHandler) {
      await messageHandler("status", ctx.message!.message_id, ctx.chat.id, null, null, null);
    }
  });

  // /restart command
  bot.command("restart", async (ctx) => {
    await ctx.reply("Restarting conciergon...");
    log.info("Restart requested via /restart command");
    if (restartHandler) {
      await restartHandler();
    }
  });

  // Global error handler — prevent unhandled errors from crashing the process
  bot.catch((err) => {
    log.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Unhandled bot error");
    captureException(err.error);
  });

  log.info("Telegram bot initialized");
  return bot;
}

export function setMessageHandler(handler: MessageHandler) {
  messageHandler = handler;
}

export function setEditHandler(handler: EditHandler) {
  editHandler = handler;
}

export function setCallbackQueryHandler(handler: CallbackQueryHandler) {
  callbackQueryHandler = handler;
}

export function setRestartHandler(handler: () => Promise<void>) {
  restartHandler = handler;
}

const TELEGRAM_MAX_LENGTH = 4096;

export async function sendMessage(
  chatId: number,
  text: string,
  options?: { plain?: boolean; html?: boolean },
): Promise<number> {
  if (!bot) throw new Error("Bot not initialized");

  if (options?.plain) {
    try {
      const msg = await bot.api.sendMessage(chatId, text);
      return msg.message_id;
    } catch (err) {
      log.error({ err, chatId, text: text.slice(0, 100) }, "Failed to send plain message");
      throw err;
    }
  }

  // Convert markdown to HTML (or use as-is if already HTML)
  const htmlText = options?.html ? text : markdownToTelegramHtml(text);

  // 2-step fallback: HTML → plain text
  try {
    const msg = await bot.api.sendMessage(chatId, htmlText, { parse_mode: "HTML" });
    return msg.message_id;
  } catch {
    try {
      const plainText = stripHtmlTags(htmlText);
      const msg = await bot.api.sendMessage(chatId, plainText);
      return msg.message_id;
    } catch (err) {
      log.error({ err, chatId, text: text.slice(0, 100) }, "Failed to send message (all parse modes failed)");
      throw err;
    }
  }
}

/**
 * Send a long message, splitting via IR-level chunking if it exceeds Telegram's limit.
 */
export async function sendLongMessage(
  chatId: number,
  text: string,
  options?: { plain?: boolean },
): Promise<number[]> {
  if (options?.plain) {
    if (text.length <= TELEGRAM_MAX_LENGTH) {
      return [await sendMessage(chatId, text, { plain: true })];
    }
    // Basic split for plain text
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > TELEGRAM_MAX_LENGTH) {
      let idx = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_LENGTH);
      if (idx === -1 || idx < TELEGRAM_MAX_LENGTH / 2) idx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
      if (idx === -1 || idx < TELEGRAM_MAX_LENGTH / 2) idx = TELEGRAM_MAX_LENGTH;
      chunks.push(remaining.slice(0, idx));
      remaining = remaining.slice(idx).replace(/^\n+/, "");
    }
    if (remaining) chunks.push(remaining);

    const msgIds: number[] = [];
    for (const chunk of chunks) {
      msgIds.push(await sendMessage(chatId, chunk, { plain: true }));
    }
    return msgIds;
  }

  // Markdown → IR → HTML chunks
  const chunks = markdownToTelegramChunks(text, TELEGRAM_MAX_LENGTH);
  if (chunks.length === 0) return [];

  const msgIds: number[] = [];
  for (const chunk of chunks) {
    const msgId = await sendMessage(chatId, chunk.html, { html: true });
    msgIds.push(msgId);
  }
  return msgIds;
}

// In-memory cache: questionId → options for resolving callback button index → label
const questionOptionsCache = new Map<number, Array<{ label: string; description?: string }>>();

export function resolveOptionLabel(questionId: number, optIndex: number): string {
  const options = questionOptionsCache.get(questionId);
  if (options && optIndex >= 0 && optIndex < options.length) {
    return options[optIndex].label;
  }
  return `option ${optIndex + 1}`;
}

export function clearQuestionOptions(questionId: number): void {
  questionOptionsCache.delete(questionId);
}

export async function sendQuestionMessage(
  chatId: number,
  workerId: number,
  questionId: number,
  question: string,
  options?: Array<{ label: string; description?: string }>,
  multiSelect?: boolean,
  emoji?: string,
): Promise<number> {
  if (!bot) throw new Error("Bot not initialized");

  let keyboard: InlineKeyboard;

  if (options && options.length > 0) {
    // Cache options for callback resolution
    questionOptionsCache.set(questionId, options);

    // Dynamic buttons from structured options
    keyboard = new InlineKeyboard();
    for (let i = 0; i < options.length; i++) {
      keyboard.text(options[i].label, `answer:${questionId}:opt:${i}`);
      if (i < options.length - 1) keyboard.row();
    }
    keyboard.row().text("Skip", `answer:${questionId}:skip`);
  } else {
    // Default Yes/No/Skip for unstructured questions
    keyboard = new InlineKeyboard()
      .text("Yes", `answer:${questionId}:yes`)
      .text("No", `answer:${questionId}:no`)
      .row()
      .text("Skip", `answer:${questionId}:skip`);
  }

  const escaped = escapeHtml(question);
  const emojiPrefix = emoji ? `${emoji} ` : '';
  const text =
    `${emojiPrefix}<b>Worker #${workerId} asks:</b>\n\n${escaped}\n\n` +
    `<i>Reply to this message or tap a button.</i>`;

  try {
    const msg = await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return msg.message_id;
  } catch {
    // Fall back to plain text if HTML parsing fails
    const plainEmoji = emoji ? `${emoji} ` : '';
    const plain = `${plainEmoji}Worker #${workerId} asks:\n\n${question}\n\nReply to this message or tap a button.`;
    const msg = await bot.api.sendMessage(chatId, plain, {
      reply_markup: keyboard,
    });
    return msg.message_id;
  }
}

export async function sendPhoto(chatId: number, photoPath: string, caption?: string): Promise<number> {
  if (!bot) throw new Error("Bot not initialized");
  try {
    const msg = await bot.api.sendPhoto(chatId, new InputFile(photoPath), {
      ...(caption ? { caption } : {}),
    });
    return msg.message_id;
  } catch (err) {
    log.error({ err, chatId, photoPath }, "Failed to send photo");
    throw err;
  }
}

export async function sendTypingAction(chatId: number): Promise<void> {
  if (!bot) return;
  await bot.api.sendChatAction(chatId, "typing").catch(() => {});
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not initialized");
  // Brief delay to let any previous poller drain (prevents 409 conflict)
  await new Promise((r) => setTimeout(r, 2000));
  bot.start({
    onStart: () => log.info("Telegram bot started polling"),
  });
}

export async function stopBot(): Promise<void> {
  if (!bot) return;
  await bot.stop();
  log.info("Telegram bot stopped");
}

export function getBot(): Bot {
  if (!bot) throw new Error("Bot not initialized");
  return bot;
}
