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
import { setPoolInfoGetter, setSchedulerRef, setScreenStore } from "./svarog/mcp-tools.js";
import { CallbackRouter } from "./telegram/callback-router.js";
import { ScreenStore } from "./telegram/screen-store.js";
import { Scheduler } from "./scheduler/index.js";
import { Watchdog } from "./watchdog/index.js";
import {
  initTelegramBot,
  setMessageHandler,
  setEditHandler,
  setCallbackQueryHandler,
  setStatusHandler,
  setRestartHandler,
  sendMessage,
  sendLongMessage,
  sendQuestionMessage,
  sendPhoto,
  sendDocument,
  sendMessageWithButtons,
  editMessageWithButtons,
  editMessageButtons,
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
    sendMessageWithButtons,
    editMessageWithButtons,
    editMessageButtons,
  });

  // Init screen store for interactive navigation
  const screenStore = new ScreenStore();
  setScreenStore(screenStore);

  // Init callback router
  const callbackRouter = new CallbackRouter();

  // Register callback handlers

  // q: — worker question option answers
  callbackRouter.register("q", async (payload, msgId, chatId, answer) => {
    const [qId, idx] = payload.split(":");
    const resolved = dispatcher.resolveQuestionByOptionIndex(parseInt(qId), parseInt(idx));
    if (resolved) {
      await answer("✓");
      await editMessageButtons(chatId, msgId, []);
    } else {
      await answer("Вопрос уже отвечен", true);
    }
  });

  // p: — plan approve/reject
  callbackRouter.register("p", async (payload, msgId, chatId, answer) => {
    const [wId, decision] = payload.split(":");
    const workerId = parseInt(wId);
    if (decision === "a") {
      const resolved = dispatcher.resolvePlan(workerId, "APPROVED: User approved the plan.");
      await answer(resolved ? "✓ План утверждён" : "План не найден", !resolved);
    } else {
      const resolved = dispatcher.resolvePlan(workerId, "REJECTED: User rejected via button.");
      await answer(resolved ? "✗ План отклонён" : "План не найден", !resolved);
    }
    await editMessageButtons(chatId, msgId, []);
  });

  // st: — interactive status dashboard
  callbackRouter.register("st", async (payload, msgId, chatId, answer) => {
    const pool = dispatcher.getPool();

    if (payload === "list" || payload === "refresh") {
      const workers = pool.getAll();
      if (workers.length === 0) {
        await editMessageWithButtons(chatId, msgId, "📊 Нет активных воркеров.", []);
        return;
      }
      let text = `📊 <b>Активные воркеры: ${workers.length}</b>\n\n`;
      const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
      for (const w of workers) {
        const stateInfo = w.hasPendingPlan() ? '⏳ ждёт approve' : w.phase;
        text += `${w.label} — ${stateInfo}\n`;
        buttons.push([{ text: `${w.label}`, callbackData: `st:w:${w.id}` }]);
      }
      buttons.push([{ text: "🔄 Обновить", callbackData: "st:refresh" }]);
      await editMessageWithButtons(chatId, msgId, text, buttons, { html: true });
    } else if (payload.startsWith("w:")) {
      const workerId = parseInt(payload.slice(2));
      const session = pool.get(workerId);
      if (!session) { await answer("Воркер не найден", true); return; }
      const output = dispatcher.getWorkerOutput(workerId);
      let text = `<b>${session.label}</b>\n`;
      text += `Статус: ${session.state} | Фаза: ${session.phase}`;
      if (session.hasPendingPlan()) text += `\n⏳ План ожидает утверждения`;
      if (output?.events?.length) {
        text += `\n\n<b>Последние действия:</b>\n`;
        for (const ev of output.events.slice(-5)) {
          text += `• ${ev.content.slice(0, 80)}\n`;
        }
      }
      const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
      if (session.state !== 'waiting_input') {
        buttons.push([
          { text: "⏸ Pause", callbackData: `st:pause:${workerId}` },
          { text: "⏹ Stop", callbackData: `st:stop:${workerId}` },
        ]);
      }
      buttons.push([
        { text: "← Назад", callbackData: "st:list" },
        { text: "🔄 Обновить", callbackData: `st:w:${workerId}` },
      ]);
      await editMessageWithButtons(chatId, msgId, text, buttons, { html: true });
    } else if (payload.startsWith("pause:")) {
      const workerId = parseInt(payload.slice(6));
      await dispatcher.handleIntent({
        id: 0, type: "pause", project: null, prompt: "",
        workerId, questionId: null, telegramChatId: chatId, telegramMessageId: msgId,
      });
      await answer("⏸ Paused");
      await editMessageWithButtons(chatId, msgId, "⏸ Воркер приостановлен.", [
        [{ text: "← Назад", callbackData: "st:list" }],
      ], { html: true });
    } else if (payload.startsWith("stop:")) {
      const workerId = parseInt(payload.slice(5));
      await dispatcher.handleIntent({
        id: 0, type: "stop", project: null, prompt: "",
        workerId, questionId: null, telegramChatId: chatId, telegramMessageId: msgId,
      });
      await answer("⏹ Stopped");
      await editMessageWithButtons(chatId, msgId, "⏹ Воркер остановлен.", [
        [{ text: "← Назад", callbackData: "st:list" }],
      ], { html: true });
    }
  });

  // Wire /status command to interactive dashboard (fast path, no AI)
  const showStatusDashboard = async (chatId: number) => {
    const workers = dispatcher.getPool().getAll();
    if (workers.length === 0) {
      await sendMessageWithButtons(chatId, "📊 Нет активных воркеров.", []);
      return;
    }
    let text = `📊 <b>Активные воркеры: ${workers.length}</b>\n\n`;
    const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
    for (const w of workers) {
      const stateInfo = w.hasPendingPlan() ? '⏳ ждёт approve' : w.phase;
      text += `${w.label} — ${stateInfo}\n`;
      buttons.push([{ text: `${w.label}`, callbackData: `st:w:${w.id}` }]);
    }
    buttons.push([{ text: "🔄 Обновить", callbackData: "st:refresh" }]);
    await sendMessageWithButtons(chatId, text, buttons, { html: true });
  };
  setStatusHandler((chatId) => showStatusDashboard(chatId));

  // nav: — screen navigation (for knowledge explorer, articles, etc.)
  callbackRouter.register("nav", async (payload, msgId, chatId, answer) => {
    const screen = screenStore.get(payload);
    if (!screen) {
      await answer("Экран не найден или истёк", true);
      return;
    }
    await editMessageWithButtons(chatId, msgId, screen.text, screen.buttons, { html: screen.html });
  });

  // s: — Svarog MCP callback (route back as message to Svarog)
  callbackRouter.register("s", async (payload, _msgId, chatId, answer) => {
    await answer();
    // Route button press back to Svarog via processMessage
    try {
      await processMessage(`[BUTTON: ${payload}]`, 0, chatId, null, null, [], {
        sendMessage: sendPlainMessage,
        sendPhoto: sendPhotoWrapper,
        sendDocument: sendDocumentWrapper,
        sendMessageWithButtons,
        handleIntent: (intent) => dispatcher.handleIntent(intent),
      });
    } catch (err) {
      log.error({ err, payload }, "Error routing button callback to Svarog");
    }
  });

  // Wire callback handler
  setCallbackQueryHandler((data, msgId, chatId, answerFn) =>
    callbackRouter.handle(data, msgId, chatId, answerFn)
  );

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

  // Shared sendDocument wrapper for MCP tools
  const sendDocumentWrapper = async (chatId: number, filePath: string, caption?: string) => {
    await sendDocument(chatId, filePath, caption);
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
        sendDocument: sendDocumentWrapper,
        sendMessageWithButtons,
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
        sendDocument: sendDocumentWrapper,
        sendMessageWithButtons,
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
    screenStore.stop();
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
    screenStore.stop();
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
