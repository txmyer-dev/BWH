import type {DispatchClaim, ProviderOperation, ProviderRun, ProviderResultWriter, ProviderUsage} from './types';
import {fingerprintInput} from './input-fingerprint';
import type {ProviderRunRepository} from './provider-run-repository';

type ReserveInput = {projectId: string; consentId: string; consentSnapshotHash?: string; dataCategories?: string[]; provider: string; model: string; operation: ProviderOperation; canonicalInput: unknown; estimatedCostMicros: number; pricingVersion: string};
type Config = {fingerprintSecret: string; defaultBudgetMicros: number; defaultRequestBudget?: number; leaseMs?: number};
export const providerRunSummary = ({id, operation, provider, status, cacheHitCount, requestCount, estimatedCostMicros, settledCostMicros, createdAt}: ProviderRun) => ({id, operation, provider, status, cacheHitCount, requestCount, estimatedCostMicros, settledCostMicros, createdAt});

export class ProviderRunService {
  private readonly leaseMs: number;
  constructor(private readonly repository: ProviderRunRepository, private readonly config: Config) { this.leaseMs = config.leaseMs ?? 60_000; }
  async reserve(input: ReserveInput) { const {canonicalInput, ...stored} = input; return this.repository.reserve({...stored, consentSnapshotHash: input.consentSnapshotHash ?? 'unspecified', dataCategories: [...new Set(input.dataCategories ?? [])].sort(), inputFingerprint: fingerprintInput(this.config.fingerprintSecret, input.projectId, canonicalInput)}, this.config.defaultBudgetMicros, this.config.defaultRequestBudget ?? 100); }
  async claim(runId: string) { return this.repository.claim(runId, this.leaseMs); }
  async beginDispatch(claim: DispatchClaim, validateConsent?: () => Promise<void>) { return this.repository.beginDispatch(claim, validateConsent); }
  async heartbeat(claim: DispatchClaim) { return this.repository.heartbeat(claim, this.leaseMs); }
  async complete(claim: DispatchClaim, usage: ProviderUsage) { return this.repository.complete(claim, usage); }
  async completeWithResult<T>(claim: DispatchClaim, usage: ProviderUsage, persist: (writer: ProviderResultWriter) => Promise<T>) { return this.repository.completeWithResult(claim, usage, persist); }
  async fail(claim: DispatchClaim, error: string) { return this.repository.fail(claim, error); }
  async reconcileExpired() { return this.repository.reconcileExpired(); }
  async get(runId: string) { return this.repository.get(runId); }
  async list(projectId: string) { return this.repository.list(projectId); }
  async acknowledgeAndRetry(runId: string): Promise<ProviderRun> {
    return this.repository.acknowledgeAndRetry(runId, this.config.defaultBudgetMicros, this.config.defaultRequestBudget ?? 100);
  }
}
