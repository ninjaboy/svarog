import { insertIntent } from "../db/queries.js";
import type { ClassifiedIntent } from "../types/index.js";
import { ConciergSession } from "./session.js";
import type { ImageData } from "./session.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("concierg");

let session: ConciergSession | null = null;

// --- Session lifecycle ---

export async function startConciergSession(): Promise<void> {
  session = new ConciergSession();
  await session.start();
  log.info("Concierg session started");
}

export async function stopConciergSession(): Promise<void> {
  if (session) {
    await session.stop();
    session = null;
  }
}

export async function pingConciergSession(): Promise<boolean> {
  if (!session || !session.isAlive()) return false;
  return session.ping();
}

export function notifyConcierg(eventText: string): void {
  session?.notify(eventText);
}

// --- Main processMessage function ---
// All messages (text and image) go through the same session.
// Claude uses MCP tools to send messages and register intents.

export async function processMessage(
  message: string,
  telegramMessageId: number,
  telegramChatId: number,
  replyToMessageId: number | null,
  replyToText: string | null,
  image: ImageData | null = null,
  deps: {
    sendMessage: (chatId: number, text: string) => Promise<void>;
    sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<void>;
    handleIntent: (intent: ClassifiedIntent & { id: number }) => Promise<void>;
  },
): Promise<void> {
  // Ensure session is alive
  if (!session || !session.isAlive()) {
    log.warn("Concierg session not alive, restarting");
    session = new ConciergSession();
    await session.start();
  }

  const registeredIntents = await session.send(
    message,
    telegramMessageId,
    telegramChatId,
    replyToMessageId,
    replyToText,
    image,
    deps.sendMessage,
    deps.sendPhoto,
  );

  // Process each registered intent
  for (const ri of registeredIntents) {
    const intent: ClassifiedIntent = {
      type: ri.type,
      project: ri.project,
      prompt: ri.prompt,
      userSummary: ri.userSummary,
      workerId: ri.workerId,
      questionId: ri.questionId,
      emoji: ri.emoji,
      telegramMessageId,
      telegramChatId,
      replyToMessageId,
    };

    const row = insertIntent(intent);
    log.info({ type: row.type, project: row.project, intentId: row.id }, "Intent registered: %s", ri.type);

    await deps.handleIntent({ ...intent, id: row.id });
  }
}
