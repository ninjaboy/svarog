import { insertIntent } from "../db/queries.js";
import type { ClassifiedIntent } from "../types/index.js";
import type { TelegramButton } from "../telegram/index.js";
import { SvarogSession } from "./session.js";
import type { ImageData } from "./session.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("svarog");

let session: SvarogSession | null = null;

// --- Session lifecycle ---

export async function startSvarogSession(): Promise<void> {
  session = new SvarogSession();
  await session.start();
  log.info("Svarog session started");
}

export async function stopSvarogSession(): Promise<void> {
  if (session) {
    await session.stop();
    session = null;
  }
}

export async function pingSvarogSession(): Promise<boolean> {
  if (!session || !session.isAlive()) return false;
  return session.ping();
}

export function notifySvarog(eventText: string): void {
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
  images: ImageData[] = [],
  deps: {
    sendMessage: (chatId: number, text: string) => Promise<void>;
    sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<void>;
    sendDocument: (chatId: number, filePath: string, caption?: string) => Promise<void>;
    sendMessageWithButtons?: (chatId: number, text: string, buttons: TelegramButton[][], options?: { html?: boolean }) => Promise<number>;
    handleIntent: (intent: ClassifiedIntent & { id: number }) => Promise<void>;
  },
): Promise<void> {
  // Ensure session is alive
  if (!session || !session.isAlive()) {
    log.warn("Svarog session not alive, restarting");
    session = new SvarogSession();
    await session.start();
  }

  const registeredIntents = await session.send(
    message,
    telegramMessageId,
    telegramChatId,
    replyToMessageId,
    replyToText,
    images,
    deps.sendMessage,
    deps.sendPhoto,
    deps.sendDocument,
    deps.sendMessageWithButtons,
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
      planMode: ri.planMode,
      telegramMessageId,
      telegramChatId,
      replyToMessageId,
    };

    const row = insertIntent(intent);
    log.info({ type: row.type, project: row.project, intentId: row.id }, "Intent registered: %s", ri.type);

    await deps.handleIntent({ ...intent, id: row.id });
  }
}
