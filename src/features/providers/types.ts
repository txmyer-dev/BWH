import type {Database} from '../../server/db/client';

export type ProviderOperation = 'analyze_collection'|'generate_questions'|'compose_storyboard'|
  'regenerate_scene'|'transcribe'|'audit_narration'|'sample_voice'|'synthesize_narration';
export type ProviderRunStatus = 'reserved'|'processing'|'dispatching'|'completed'|
  'failed'|'ambiguous'|'superseded_ambiguous'|'late_completed';
export type DispatchClaim = {runId: string; leaseToken: string; consentId: string; dispatchDeadlineAt: Date};
export type ProviderDatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type ProviderUsage = {actualCostMicros: number; requestCount: number; metadata?: Record<string, string | number | boolean>};
export type ProviderDispatchResult<T> = {result: T; usage: ProviderUsage};
export interface ProviderResultWriter {
  writeStructured(write: (transaction: ProviderDatabaseTransaction) => Promise<void>): Promise<void>;
}
export type ProviderExecutionInput<T> = {
  projectId: string; provider: string; model: string; operation: ProviderOperation;
  dataCategories: string[]; canonicalInput: unknown; estimatedCostMicros: number;
  pricingVersion: string;
  dispatch: (context: {runId: string; providerIdempotencyKey: string; signal: AbortSignal}) => Promise<ProviderDispatchResult<T>>;
  loadResult: (runId: string) => Promise<T>;
  persistResult: (writer: ProviderResultWriter, claim: DispatchClaim, result: T) => Promise<void>;
  cleanupOrphanedResult?: (result: T) => Promise<void>;
};
export type ProviderExecution<T> = {runId: string; cacheHit: boolean; result: T};
export interface ProviderExecutor {
  execute<T>(input: ProviderExecutionInput<T>): Promise<ProviderExecution<T>>;
}

export type ProviderRun = {
  id: string; projectId: string; consentId: string; provider: string; model: string;
  consentSnapshotHash: string; dataCategories: string[];
  operation: ProviderOperation; inputFingerprint: string; status: ProviderRunStatus;
  estimatedCostMicros: number; reservedCostMicros: number; settledCostMicros: number | null;
  pricingVersion: string; requestCount: number; cacheHitCount: number;
  leaseToken: string | null; leaseExpiresAt: Date | null; dispatchDeadlineAt: Date | null;
  providerIdempotencyKey: string; retryOfRunId: string | null; activeResult: boolean;
  lastError: string | null; createdAt: Date; updatedAt: Date;
  usageMetadata: Record<string, string | number | boolean> | null;
};

export type ReserveProviderRunInput = Omit<ProviderRun, 'id'|'inputFingerprint'|'status'|'reservedCostMicros'|'settledCostMicros'|'requestCount'|'cacheHitCount'|'leaseToken'|'leaseExpiresAt'|'dispatchDeadlineAt'|'providerIdempotencyKey'|'retryOfRunId'|'activeResult'|'lastError'|'usageMetadata'|'createdAt'|'updatedAt'> & {inputFingerprint: string; retryOfRunId?: string};
