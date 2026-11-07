export type Speaker = 'client' | 'operator' | 'bot' | 'system';
export type Classification = 'synthetic_allowed' | 'real_restricted' | 'unknown';
export interface SourceMessage { timestamp: string; speaker: Speaker; text: string }
export interface Message extends SourceMessage { id: string; position: number }
export interface Conversation {
  version: string;
  groupId: string;
  conversationId: string;
  channel: string;
  language: string;
  classification: Classification;
  messages: Message[];
  audioAvailable: boolean;
}
export interface Criterion {
  id: string;
  title: string;
  instructions: string;
  weight: number;
  answerType: 'boolean' | 'numeric';
  allowedValues: string[];
  scaleMax: number;
  naAllowed: boolean;
  naCondition: string;
  section: string;
  evidenceRequirement: string;
  flag: boolean;
}
export interface Checklist { id: string; version: string; title: string; criteria: Criterion[] }
export interface Evidence { messageId: string; quote: string }
export interface CriterionResult {
  criterionId: string;
  answer: string;
  applicabilityRationale: string;
  explanation: string;
  evidence: Evidence[];
  checkedRange: { startMessageId: string; endMessageId: string } | null;
  reviewRequired: boolean;
  uncertainty: string;
}
export interface ScoreRow { criterionId: string; answer: string; weight: number; contribution: number | null; normalizedContribution: number | null }
export interface Score { total: number | null; applicableWeight: number; rawPoints: number; rows: ScoreRow[]; sections: Record<string, { total: number | null; applicableWeight: number; rawPoints: number }>; flags: Record<string, boolean> }
export interface Evaluation {
  id: string;
  createdAt: string;
  conversationVersion: string;
  checklistVersion: string;
  provider: string;
  model: string;
  mode: 'free';
  status: 'live_validated';
  results: CriterionResult[];
  score: Score;
  usage: Record<string, number | null>;
  latencyMs: number;
  providerCallCount: number;
  configuration: Record<string, unknown>;
}
