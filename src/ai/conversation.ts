import type { Summary } from './draft';
import type { Patch } from './types';

/** What a conversation message may show besides its text (shared by the server turn logic and the chat UI). */
export type OnboardingAction = 'summary' | 'start' | 'correct' | 'vision_confirm' | 'vision_discard' | 'camera';
/** Deterministic assistant buttons (domain writes, never inference). */
export type AssistantAct = 'patch_obligation' | 'mark_paid' | 'record_balance' | 'link_income' | 'set_pref' | 'create_debt' | 'set_essentials' | 'apply_plan';
export interface MessageCard {
  title?: string;
  rows?: Array<{ label: string; value: string; doubtful?: boolean }>;
  question?: string;
  replies?: string[];
  actions?: Array<{ kind: OnboardingAction; label: string }>;
  summary?: Summary;
  links?: Array<{ label: string; href: string }>;
  acts?: Array<{ label: string; act: AssistantAct; fields: Record<string, string> }>;
  /** Camera read in "Preguntar": the proposal waits here (server-side row) until the person confirms. */
  vision?: Patch[];
  /** Idempotency fingerprint of the photos read (never the image itself); server-side only. */
  readKey?: string;
  /** Assistant: what the next message answers (src/ai/vels-collect.ts); re-validated on read, rows are client-insertable. */
  pending?: 'balance' | 'currency' | 'income' | 'income_date' | 'income_amount' | 'income_days';
  /** Assistant: the question to answer once the pending facts are in (validated by asResume). */
  resume?: unknown;
  /** Assistant: what the person already said in this exchange (validated by asDraft). */
  draft?: unknown;
  stop?: boolean;
}
export interface ChatMessage { id: string; role: 'user' | 'velsuno'; body: string; card: MessageCard | null }
export interface ChatState { messages: ChatMessage[]; error?: string; done?: boolean }
