import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { getConfig } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { markdownToTelegramHtml, markdownToTelegramChunks, escapeHtml, stripHtmlTags } from "./format.js";
import type { ImageData } from "../svarog/session.js";
export type { ImageData };

const log = createChildLogger("telegram");

export type MessageHandler = (
  text: string,
  messageId: number,
  chatId: number,
  replyToMessageId: number | null,
  replyToText: string | null,
  images: ImageData[],
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
let botShouldRun = false;
let messageHandler: MessageHandler | null = null;
let editHandler: EditHandler | null = null;
let callbackQueryHandler: CallbackQueryHandler | null = null;
let restartHandler: (() => Promise<void>) | null = null;

// --- Photo download & save helpers ---

async function downloadTelegramFile(
  api: Api,
  fileId: string,
  retries = 1,
): Promise<{ buffer: Buffer; ext: string }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const file = await api.getFile(fileId);
      if (!file.file_path) {
        throw new Error("Telegram getFile returned no file_path");
      }
      const fileUrl = `https://api.telegram.org/file/bot${getConfig().TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const ext = file.file_path.split(".").pop()?.toLowerCase() ?? "jpg";
      return { buffer, ext };
    } catch (err) {
      if (attempt < retries) {
        log.warn({ err, fileId, attempt }, "Retrying photo download");
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

function saveImageToDisk(buffer: Buffer, ext: string, messageId: number): ImageData {
  const imagesDir = join(process.cwd(), "data", "images");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `${messageId}_${Date.now()}.${ext}`;
  const imagePath = join(imagesDir, filename);
  writeFileSync(imagePath, buffer);
  log.info({ imagePath, size: buffer.length }, "Photo saved to disk");
  const mediaType =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { base64: buffer.toString("base64"), mediaType, localPath: imagePath };
}

// --- Media group buffering ---

const mediaGroupBuffers = new Map<
  string,
  {
    photos: Array<{ fileId: string; messageId: number }>;
    caption: string;
    chatId: number;
    replyTo: number | null;
    replyToText: string | null;
    timer: ReturnType<typeof setTimeout>;
    api: Api;
  }
>();

async function processMediaGroup(mediaGroupId: string): Promise<void> {
  const group = mediaGroupBuffers.get(mediaGroupId);
  mediaGroupBuffers.delete(mediaGroupId);
  if (!group || !messageHandler) return;

  const images: ImageData[] = [];
  // Download all photos in parallel
  const results = await Promise.allSettled(
    group.photos.map(async ({ fileId, messageId }) => {
      const { buffer, ext } = await downloadTelegramFile(group.api, fileId);
      return saveImageToDisk(buffer, ext, messageId);
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      images.push(result.value);
    } else {
      log.error({ err: result.reason }, "Failed to download media group photo");
    }
  }

  if (images.length === 0) {
    try {
      await bot!.api.sendMessage(group.chatId, "Failed to download the photos. Please try again.");
    } catch { /* ignore send errors */ }
    return;
  }

  const text = group.caption || `[User sent ${images.length} photo${images.length > 1 ? "s" : ""} with no caption]`;
  const firstMessageId = group.photos[0].messageId;

  try {
    await messageHandler(text, firstMessageId, group.chatId, group.replyTo, group.replyToText, images);
  } catch (err) {
    log.error({ err }, "Error handling media group");
    try {
      await bot!.api.sendMessage(group.chatId, "Internal error processing your photos.");
    } catch { /* ignore send errors */ }
  }
}

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
      await messageHandler(text, messageId, chatId, replyTo, replyToText, []);
    } catch (err) {
      log.error({ err }, "Error handling message");
      await ctx.reply("Internal error processing your message.");
    }
  });

  // Photo messages — download image, save to disk, pass path in text
  // Supports single photos and media groups (multiple photos)
  bot.on("message:photo", async (ctx) => {
    if (!messageHandler) return;

    const caption = ctx.message.caption ?? "";
    const messageId = ctx.message.message_id;
    const chatId = ctx.chat.id;
    const replyTo = ctx.message.reply_to_message?.message_id ?? null;
    const replyToText = ctx.message.reply_to_message?.text ?? ctx.message.reply_to_message?.caption ?? null;
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    const mediaGroupId = (ctx.message as any).media_group_id as string | undefined;

    log.debug({ caption, messageId, chatId, replyTo, fileId: largest.file_id, mediaGroupId }, "Received photo");

    // --- Media group: buffer photos and process together ---
    if (mediaGroupId) {
      let group = mediaGroupBuffers.get(mediaGroupId);
      if (!group) {
        group = {
          photos: [],
          caption,
          chatId,
          replyTo,
          replyToText,
          timer: setTimeout(() => processMediaGroup(mediaGroupId), 500),
          api: ctx.api,
        };
        mediaGroupBuffers.set(mediaGroupId, group);
      } else {
        if (caption && !group.caption) group.caption = caption;
        clearTimeout(group.timer);
        group.timer = setTimeout(() => processMediaGroup(mediaGroupId), 500);
      }
      group.photos.push({ fileId: largest.file_id, messageId });
      return;
    }

    // --- Single photo: process immediately with retry ---
    let image: ImageData;
    try {
      const { buffer, ext } = await downloadTelegramFile(ctx.api, largest.file_id);
      image = saveImageToDisk(buffer, ext, messageId);
    } catch (err) {
      log.error({ err, fileId: largest.file_id }, "Failed to download/save photo");
      await ctx.reply("Failed to download the photo. Please try again.");
      return;
    }

    const text = caption || "[User sent a photo with no caption]";

    try {
      await messageHandler(text, messageId, chatId, replyTo, replyToText, [image]);
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
      "Svarog active. Send me tasks for your projects.\n" +
        'Try: "fix the login bug in myapp"'
    );
  });

  // /status command
  bot.command("status", async (ctx) => {
    if (messageHandler) {
      await messageHandler("status", ctx.message!.message_id, ctx.chat.id, null, null, []);
    }
  });

  // /restart command
  bot.command("restart", async (ctx) => {
    await ctx.reply("Restarting svarog...");
    log.info("Restart requested via /restart command");
    if (restartHandler) {
      await restartHandler();
    }
  });

  // Global error handler — prevent unhandled errors from crashing the process
  bot.catch((err) => {
    log.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Unhandled bot error");
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

export async function sendQuestionMessage(
  chatId: number,
  workerId: number,
  _questionId: number,
  question: string,
  emoji?: string,
  label?: string,
): Promise<number> {
  if (!bot) throw new Error("Bot not initialized");

  const displayLabel = label || `#${workerId}`;
  const escaped = escapeHtml(question);
  const emojiPrefix = emoji ? `${emoji} ` : '';
  const text =
    `${emojiPrefix}<b>${escapeHtml(displayLabel)} asks:</b>\n\n${escaped}\n\n` +
    `<i>Reply to this message with your answer.</i>`;

  try {
    const msg = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    return msg.message_id;
  } catch {
    const plainEmoji = emoji ? `${emoji} ` : '';
    const plain = `${plainEmoji}${displayLabel} asks:\n\n${question}\n\nReply to this message with your answer.`;
    const msg = await bot.api.sendMessage(chatId, plain);
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

function runPolling(): void {
  if (!bot || !botShouldRun) return;
  bot
    .start({ onStart: () => log.info("Telegram bot started polling") })
    .catch((err) => {
      if (!botShouldRun) return; // intentional stop — don't retry
      log.error({ err }, "Telegram polling stopped unexpectedly, reconnecting in 5s...");
      setTimeout(runPolling, 5000);
    });
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not initialized");
  botShouldRun = true;
  // Brief delay to let any previous poller drain (prevents 409 conflict)
  await new Promise((r) => setTimeout(r, 2000));
  runPolling();
}

export async function stopBot(): Promise<void> {
  botShouldRun = false;
  if (!bot) return;
  await bot.stop();
  log.info("Telegram bot stopped");
}

export function getBot(): Bot {
  if (!bot) throw new Error("Bot not initialized");
  return bot;
}
