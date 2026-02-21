import { spawn } from "node:child_process";
import { loadConfig } from "./config/index.js";
import { initDb, closeDb } from "./db/index.js";
import { scanAndRegisterProjects } from "./utils/project-registry.js";
import {
  processMessage,
  startConciergSession,
  stopConciergSession,
  pingConciergSession,
} from "./concierg/index.js";
import { setWorkerDetailsProvider } from "./concierg/mcp-tools.js";
import { Dispatcher } from "./dispatcher/index.js";
import { Watchdog } from "./watchdog/index.js";
import {
  initTelegramBot,
  setMessageHandler,
  setEditHandler,
  setRestartHandler,
  sendMessage,
  sendPhoto,
  sendTypingAction,
  startBot,
  stopBot,
  getBot,
} from "./telegram/index.js";
import { HealthMonitor } from "./health/index.js";
import { startTokenRefreshLoop, stopTokenRefreshLoop } from "./utils/token-refresh.js";
import { createChildLogger } from "./utils/logger.js";
import { initSentry } from "./utils/sentry.js";

const log = createChildLogger("main");

async function main() {
  log.info("Conciergon starting...");

  // 0. Init Sentry (before anything else)
  initSentry();

  // 1. Load config
  const config = loadConfig();
  log.info("Config loaded");

  // 2. Init DB
  initDb();

  // 3. Scan and register projects
  scanAndRegisterProjects();

  // 4. Init Telegram bot
  initTelegramBot();

  // 5. Init Dispatcher
  const dispatcher = new Dispatcher();

  // Wire worker details provider for concierg MCP tools
  setWorkerDetailsProvider((workerId) => {
    const output = dispatcher.getWorkerOutput(workerId);
    if (!output) return null;
    const session = dispatcher.getPool().get(workerId);
    return {
      state: output.state,
      stdout: output.stdout,
      stderr: output.stderr,
      events: output.events,
      totalCostUsd: session?.totalCostUsd ?? 0,
      hasManagerLLM: dispatcher.hasManagerLLM(workerId),
    };
  });

  // 6. Start token refresh loop (keeps OAuth token fresh)
  startTokenRefreshLoop();

  // 7. Start Concierg session (Claude Code SDK)
  await startConciergSession();

  // 7. Init Health Monitor
  const health = new HealthMonitor({
    getBot,
    stopBot,
    startBot,
    pingSession: pingConciergSession,
    restartSession: async () => {
      await stopConciergSession();
      await startConciergSession();
    },
    alertChatId: config.TELEGRAM_ALLOWED_USERS[0],
  });

  // Shared sendMessage wrapper for MCP tools (plain text)
  const sendPlainMessage = async (chatId: number, text: string) => {
    await sendMessage(chatId, text, { plain: true });
  };

  // Shared sendPhoto wrapper for MCP tools
  const sendPhotoWrapper = async (chatId: number, photoPath: string, caption?: string) => {
    await sendPhoto(chatId, photoPath, caption);
  };

  // 8. Wire Telegram -> Concierg -> MCP tools dispatch intents
  setMessageHandler(async (text, messageId, chatId, replyToMessageId, replyToText, image) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, replyToMessageId, replyToText, image, {
        sendMessage: sendPlainMessage,
        sendPhoto: sendPhotoWrapper,
        handleIntent: (intent) => dispatcher.handleIntent(intent),
      });
      health.trackClassify();
    } catch (err) {
      log.error({ err, text, messageId, chatId }, "Error in message handler");
      throw err;
    } finally {
      health.trackMessageEnd(messageId);
      clearInterval(typingInterval);
    }
  });

  setEditHandler(async (text, messageId, chatId) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, null, null, null, {
        sendMessage: sendPlainMessage,
        sendPhoto: sendPhotoWrapper,
        handleIntent: (intent) => dispatcher.handleIntent(intent),
      });
      health.trackClassify();
    } catch (err) {
      log.error({ err, text, messageId, chatId }, "Error in edit handler");
      throw err;
    } finally {
      health.trackMessageEnd(messageId);
      clearInterval(typingInterval);
    }
  });

  // Wire /restart command handler
  setRestartHandler(async () => {
    log.info("Performing graceful restart...");

    health.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

    // Spawn a new instance before exiting
    const child = spawn("node", ["--env-file=.env", "--import", "tsx", "src/index.ts"], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });
    child.unref();

    log.info("New process spawned, exiting current process.");
    process.exit(0);
  });

  // 9. Cold-register recent workers from DB (no SDK sessions started)
  await dispatcher.coldResumeWorkersFromDb();

  // 10. Start Watchdog (only monitors idle workers now)
  const watchdog = new Watchdog(dispatcher);
  watchdog.start();

  // 11. Start Telegram bot
  await startBot();

  // 12. Start health monitor (after bot is polling)
  health.start();

  log.info("Conciergon is running!");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutting down (%s)...", signal);

    health.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
