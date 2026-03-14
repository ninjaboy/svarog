import { spawn } from "node:child_process";
import { loadConfig } from "./config/index.js";
import { initDb, closeDb } from "./db/index.js";
import { scanAndRegisterProjects } from "./utils/project-registry.js";
import {
  processMessage,
  startSvarogSession,
  stopSvarogSession,
  pingSvarogSession,
} from "./svarog/index.js";
import { Dispatcher, getWorkerIdByTelegramMessage } from "./dispatcher/index.js";
import { setPoolInfoGetter, setSchedulerRef } from "./svarog/mcp-tools.js";
import { Scheduler } from "./scheduler/index.js";
import { Watchdog } from "./watchdog/index.js";
import {
  initTelegramBot,
  setMessageHandler,
  setEditHandler,
  setRestartHandler,
  sendMessage,
  sendLongMessage,
  sendQuestionMessage,
  sendPhoto,
  sendTypingAction,
  startBot,
  stopBot,
  getBot,
} from "./telegram/index.js";
import { HealthMonitor } from "./health/index.js";
import { startTokenRefreshLoop, stopTokenRefreshLoop } from "./utils/token-refresh.js";
import { createChildLogger } from "./utils/logger.js";
const log = createChildLogger("main");

async function main() {
  log.info("Svarog starting...");

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

  // Wire pool info getter so svarog's get_system_state shows pool/phase info
  setPoolInfoGetter((workerId) => {
    const session = dispatcher.getPool().get(workerId);
    if (!session) return null;
    return {
      poolStatus: session.isCold() ? 'cold' : 'warm',
      phase: session.phase,
      hasPendingPlan: session.hasPendingPlan(),
    };
  });

  // Wire Telegram functions into dispatcher (for workers to send messages directly)
  dispatcher.setTelegramFunctions({
    sendMessage: async (chatId, text) => {
      const ids = await sendLongMessage(chatId, text, { plain: true });
      return ids[0] ?? 0;
    },
    sendLongMessage: (chatId, text) => sendLongMessage(chatId, text),
    sendQuestionMessage,
    sendPhoto: (chatId, photoPath, caption) => sendPhoto(chatId, photoPath, caption),
  });

  // 6. Start token refresh loop (keeps OAuth token fresh)
  startTokenRefreshLoop();

  // 7. Start Svarog session (Claude Code SDK)
  await startSvarogSession();

  // 8. Init Health Monitor
  const health = new HealthMonitor({
    getBot,
    stopBot,
    startBot,
    pingSession: pingSvarogSession,
    restartSession: async () => {
      await stopSvarogSession();
      await startSvarogSession();
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

  // 9. Wire Telegram -> Svarog -> dispatch intents
  setMessageHandler(async (text, messageId, chatId, replyToMessageId, replyToText, images) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, replyToMessageId, replyToText, images, {
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
      await processMessage(text, messageId, chatId, null, null, [], {
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
    scheduler.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopSvarogSession();
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

  // 11. Cleanup stale workers (workers are loaded from DB on demand)
  await dispatcher.cleanupStaleWorkers();

  // 12. Start Scheduler (loads enabled schedules from DB)
  const scheduler = new Scheduler(dispatcher);
  setSchedulerRef(scheduler);
  scheduler.start();

  // 13. Start Watchdog (only monitors idle workers now)
  const watchdog = new Watchdog(dispatcher);
  watchdog.start();

  // 13. Start Telegram bot
  await startBot();

  // 14. Start health monitor (after bot is polling)
  health.start();

  log.info("Svarog is running!");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutting down (%s)...", signal);

    health.stop();
    scheduler.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopSvarogSession();
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
