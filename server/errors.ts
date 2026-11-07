import { ProviderError } from './provider.js';
import { EvidenceValidationError } from './evidence.js';
import { OrganizerImportError } from './importer.js';
export class EvaluationRunError extends Error {
  constructor(readonly code: string, readonly attemptId: string) { super(code); }
}

/** Error bodies and SDK messages may contain source text or signed URLs. */
export function publicErrorCode(error: unknown): string {
  if (error instanceof ProviderError || error instanceof EvidenceValidationError || error instanceof OrganizerImportError || error instanceof EvaluationRunError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message)) return error.message;
  return 'REQUEST_FAILED';
}
