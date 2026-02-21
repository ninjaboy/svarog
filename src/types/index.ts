export const INTENT_TYPES = [
  "spawn_worker",
  "follow_up",
  "answer_question",
  "stop",
  "pause",
  "resume",
  "rewind",
  "status",
  "restore_worker",
  "general",
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

/** Worker lifecycle states (4-state machine).
 *
 * "stopped" is written directly to DB by cleanupWorker() for audit trail
 * but is NOT part of this enum — stop = abort + remove from pool.
 */
export enum WorkerState {
  /** SDK session is initializing (spawn or restore in progress) */
  Starting = "starting",
  /** Running a query, idle in pool awaiting follow-up, or interrupted */
  Active = "active",
  /** Blocked on AskUserQuestion or ExitPlanMode — awaiting user/manager input */
  WaitingInput = "waiting_input",
  /** Runtime error or API failure — can be restored */
  Errored = "errored",
}

export interface ClassifiedIntent {
  type: IntentType;
  project: string | null;
  prompt: string;
  userSummary: string;
  workerId: number | null;
  questionId: number | null;
  emoji: string | null;
  telegramMessageId: number;
  telegramChatId: number;
  replyToMessageId: number | null;
}

export interface WorkerInfo {
  id: number;
  projectId: number;
  sessionId: string;
  state: WorkerState | "stopped";
  currentPrompt: string;
  lastActivityAt: string;
  createdAt: string;
}

export interface PendingQuestion {
  id: number;
  workerId: number;
  question: string;
  telegramMessageId: number | null;
  resolveCallback?: (answer: string) => void;
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface ConciergResponse {
  type: IntentType;
  project: string | null;
  prompt: string;
  workerId: number | null;
  questionId: number | null;
  reply: string | null;
}
