import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("callback-router");

export type AnswerCallbackFn = (text?: string, showAlert?: boolean) => Promise<void>;

export type CallbackHandler = (
  payload: string,
  messageId: number,
  chatId: number,
  answer: AnswerCallbackFn,
) => Promise<void>;

/**
 * Routes inline keyboard callback_data to registered handlers by prefix.
 * Callback data format: "prefix:payload" — e.g. "q:42:1", "p:17:a", "st:list".
 */
export class CallbackRouter {
  private handlers = new Map<string, CallbackHandler>();

  register(prefix: string, handler: CallbackHandler): void {
    this.handlers.set(prefix, handler);
  }

  async handle(
    data: string,
    messageId: number,
    chatId: number,
    answer: AnswerCallbackFn,
  ): Promise<void> {
    const colonIdx = data.indexOf(":");
    if (colonIdx === -1) {
      log.warn({ data }, "Callback data has no prefix");
      await answer("Unknown action", true);
      return;
    }

    const prefix = data.slice(0, colonIdx);
    const payload = data.slice(colonIdx + 1);

    const handler = this.handlers.get(prefix);
    if (!handler) {
      log.warn({ prefix, data }, "No handler registered for callback prefix");
      await answer("Unknown action", true);
      return;
    }

    try {
      await handler(payload, messageId, chatId, answer);
    } catch (err) {
      log.error({ err, data }, "Error in callback handler");
      await answer("Internal error", true);
    }
  }
}
