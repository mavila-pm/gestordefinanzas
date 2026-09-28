import type { Summary } from './draft';

/** What a conversation message may show besides its text (shared by the server turn logic and the chat UI). */
export type OnboardingAction = 'summary' | 'start' | 'correct' | 'vision_confirm' | 'vision_discard' | 'camera';
export interface MessageCard {
  title?: string;
  rows?: Array<{ label: string; value: string; doubtful?: boolean }>;
  question?: string;
  replies?: string[];
  actions?: Array<{ kind: OnboardingAction; label: string }>;
  summary?: Summary;
  links?: Array<{ label: string; href: string }>;
  acts?: Array<{ label: string; act: 'patch_obligation' | 'mark_paid' | 'record_balance'; fields: Record<string, string> }>;
  /** Assistant: a bare value in the next message answers this. */
  pending?: 'balance' | 'income_amount';
  stop?: boolean;
}
export interface ChatMessage { id: string; role: 'user' | 'velsuno'; body: string; card: MessageCard | null }
export interface ChatState { messages: ChatMessage[]; error?: string; done?: boolean }
