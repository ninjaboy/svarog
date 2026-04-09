import type { CallbackRouter } from "./callback-router.js";
import type { TelegramButton } from "./index.js";
import type { WorkerPool } from "../worker/index.js";
import {
  getActiveWorkers,
  getWorkerRecentMessages,
  getWorkerWithProject,
  getUnansweredQuestions,
} from "../db/queries.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("status-plugin");

export interface StatusPluginDeps {
  getPool: () => WorkerPool;
  handleIntent: (intent: {
    id: number;
    type: string;
    project: string | null;
    prompt: string;
    workerId: number | null;
    questionId: number | null;
    telegramChatId: number;
    telegramMessageId: number;
  }) => Promise<void>;
  sendMessageWithButtons: (
    chatId: number,
    text: string,
    buttons: TelegramButton[][],
    options?: { html?: boolean },
  ) => Promise<number>;
  editMessageWithButtons: (
    chatId: number,
    messageId: number,
    text: string,
    buttons: TelegramButton[][],
    options?: { html?: boolean },
  ) => Promise<void>;
  editMessageButtons: (
    chatId: number,
    messageId: number,
    buttons: TelegramButton[][],
  ) => Promise<void>;
  getWorkerOutput: (workerId: number) => {
    state: string;
    stdout: string;
    stderr: string;
    events: Array<{ timestamp: Date; type: string; content: string }>;
  } | null;
}

function formatIdleTime(lastActivityAt: string): string {
  const diff = Date.now() - new Date(lastActivityAt + "Z").getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}с`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}м`;
  return `${Math.floor(diff / 3600_000)}ч`;
}

function stateEmoji(state: string, poolStatus: string): string {
  if (state === "starting") return "🟡";
  if (state === "waiting_input") return "🟠";
  if (state === "errored") return "🔴";
  if (poolStatus === "warm") return "🟢";
  if (poolStatus === "cold") return "⚪";
  return "⚫";
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}

/**
 * Show the worker list screen — either as a new message or by editing an existing one.
 */
async function showStatusList(
  deps: StatusPluginDeps,
  chatId: number,
  messageId?: number,
): Promise<void> {
  const pool = deps.getPool();
  const dbWorkers = getActiveWorkers();
  const pendingQuestions = getUnansweredQuestions();

  if (dbWorkers.length === 0) {
    const text = "📊 Нет активных воркеров.";
    const buttons: TelegramButton[][] = [
      [{ text: "🔄 Обновить", callbackData: "st:list" }],
    ];
    if (messageId) {
      await deps.editMessageWithButtons(chatId, messageId, text, buttons, { html: true });
    } else {
      await deps.sendMessageWithButtons(chatId, text, buttons, { html: true });
    }
    return;
  }

  let text = `📊 <b>Активные воркеры: ${dbWorkers.length}</b>\n`;

  // Add pending questions summary
  if (pendingQuestions.length > 0) {
    text += `❓ Ожидают ответа: ${pendingQuestions.length}\n`;
  }
  text += "\n";

  const buttons: TelegramButton[][] = [];
  const row: TelegramButton[] = [];

  for (const w of dbWorkers) {
    const session = pool.get(w.id);
    const poolStatus = session ? (session.isCold() ? "cold" : "warm") : "not_in_pool";
    const emoji = w.emoji || "⚙️";
    const label = w.userSummary ? truncate(w.userSummary, 20) : `Воркер`;
    const dot = stateEmoji(w.state, poolStatus);

    text += `${dot} ${emoji} <b>#${w.id}</b> ${truncate(w.userSummary || w.currentPrompt, 50)}\n`;

    row.push({ text: `${emoji} #${w.id} ${label}`, callbackData: `st:w:${w.id}` });
    if (row.length === 2) {
      buttons.push([...row]);
      row.length = 0;
    }
  }
  if (row.length > 0) buttons.push([...row]);

  buttons.push([{ text: "🔄 Обновить", callbackData: "st:list" }]);

  if (messageId) {
    await deps.editMessageWithButtons(chatId, messageId, text, buttons, { html: true });
  } else {
    await deps.sendMessageWithButtons(chatId, text, buttons, { html: true });
  }
}

/**
 * Show worker detail screen by editing the existing message.
 */
async function showWorkerDetail(
  deps: StatusPluginDeps,
  chatId: number,
  messageId: number,
  workerId: number,
): Promise<void> {
  const pool = deps.getPool();
  const session = pool.get(workerId);
  const workerWithProject = getWorkerWithProject(workerId);

  if (!workerWithProject) {
    await deps.editMessageWithButtons(chatId, messageId, "Воркер не найден.", [
      [{ text: "⬅ Назад", callbackData: "st:list" }],
    ], { html: true });
    return;
  }

  const { worker: w, project } = workerWithProject;
  const poolStatus = session ? (session.isCold() ? "cold" : "warm") : "not_in_pool";
  const phase = session?.phase ?? (w.state === "starting" ? "starting" : "unknown");
  const hasPendingPlan = session?.hasPendingPlan() ?? false;
  const emoji = w.emoji || "⚙️";
  const dot = stateEmoji(w.state, poolStatus);

  let text = `${emoji} <b>#${w.id} ${w.userSummary || truncate(w.currentPrompt, 50)}</b>\n\n`;
  text += `📁 Проект: <b>${project.name}</b>\n`;
  text += `${dot} Состояние: ${w.state} (${poolStatus})\n`;
  text += `⚡ Фаза: ${phase}\n`;
  text += `⏱ Простаивает: ${formatIdleTime(w.lastActivityAt)}\n`;

  if (hasPendingPlan) {
    text += `\n⏳ <b>План ожидает утверждения</b>\n`;
  }

  // Recent activity from in-memory events
  const output = deps.getWorkerOutput(workerId);
  if (output?.events && output.events.length > 0) {
    text += `\n<b>Последние действия:</b>\n`;
    const recentEvents = output.events.slice(-5);
    for (const ev of recentEvents) {
      text += `• ${truncate(ev.content, 80)}\n`;
    }
  }

  // Recent messages from DB
  const recentMessages = getWorkerRecentMessages(workerId, 3);
  if (recentMessages.length > 0) {
    text += `\n<b>Последние сообщения:</b>\n`;
    for (const msg of recentMessages.reverse()) {
      const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
      const content = data?.text || data?.content || JSON.stringify(data);
      text += `💬 ${truncate(String(content), 100)}\n`;
    }
  }

  // Action buttons
  const buttons: TelegramButton[][] = [];

  if (w.state !== "waiting_input" && poolStatus === "warm") {
    buttons.push([
      { text: "⏸ Пауза", callbackData: `st:pause:${w.id}` },
      { text: "⏹ Остановить", callbackData: `st:stop:${w.id}` },
    ]);
  } else if (poolStatus === "cold") {
    buttons.push([
      { text: "⏹ Остановить", callbackData: `st:stop:${w.id}` },
    ]);
  }

  buttons.push([
    { text: "⬅ Назад", callbackData: "st:list" },
    { text: "🔄 Обновить", callbackData: `st:w:${w.id}` },
  ]);

  await deps.editMessageWithButtons(chatId, messageId, text, buttons, { html: true });
}

/**
 * Register the status plugin on a CallbackRouter.
 * Returns `showStatusList` for use as /status command handler.
 */
export function registerStatusPlugin(
  router: CallbackRouter,
  deps: StatusPluginDeps,
): { showStatusList: (chatId: number) => Promise<void> } {

  router.register("st", async (payload, msgId, chatId, answer) => {
    try {
      if (payload === "list" || payload === "refresh") {
        await showStatusList(deps, chatId, msgId);
      } else if (payload.startsWith("w:")) {
        const workerId = parseInt(payload.slice(2));
        if (isNaN(workerId)) {
          await answer("Неверный ID", true);
          return;
        }
        await showWorkerDetail(deps, chatId, msgId, workerId);
      } else if (payload.startsWith("pause:")) {
        const workerId = parseInt(payload.slice(6));
        await deps.handleIntent({
          id: 0, type: "pause", project: null, prompt: "",
          workerId, questionId: null, telegramChatId: chatId, telegramMessageId: msgId,
        });
        await answer("⏸ Paused");
        await deps.editMessageWithButtons(chatId, msgId, "⏸ Воркер приостановлен.", [
          [{ text: "⬅ Назад", callbackData: "st:list" }],
        ], { html: true });
      } else if (payload.startsWith("stop:")) {
        const workerId = parseInt(payload.slice(5));
        await deps.handleIntent({
          id: 0, type: "stop", project: null, prompt: "",
          workerId, questionId: null, telegramChatId: chatId, telegramMessageId: msgId,
        });
        await answer("⏹ Stopped");
        await deps.editMessageWithButtons(chatId, msgId, "⏹ Воркер остановлен.", [
          [{ text: "⬅ Назад", callbackData: "st:list" }],
        ], { html: true });
      } else {
        await answer("Неизвестное действие", true);
      }
    } catch (err) {
      log.error({ err, payload }, "Error in status plugin");
      await answer("Ошибка обработки", true);
    }
  });

  return {
    showStatusList: (chatId: number) => showStatusList(deps, chatId),
  };
}
