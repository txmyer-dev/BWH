import type {DispatchClaim, ProviderOperation, ProviderRun} from './types';
import {fingerprintInput} from './input-fingerprint';
import type {ProviderRunRepository} from './provider-run-repository';

type ReserveInput = {projectId: string; consentId: string; provider: string; model: string; operation: ProviderOperation; canonicalInput: unknown; estimatedCostMicros: number; pricingVersion: string};
type Config = {fingerprintSecret: string; defaultBudgetMicros: number; defaultRequestBudget?: number; leaseMs?: number};

export class ProviderRunService {
  private readonly leaseMs: number;
  constructor(private readonly repository: ProviderRunRepository, private readonly config: Config) { this.leaseMs = config.leaseMs ?? 60_000; }
  async reserve(input: ReserveInput) { return this.repository.reserve({...input, inputFingerprint: fingerprintInput(this.config.fingerprintSecret, input.projectId, input.canonicalInput)}, this.config.defaultBudgetMicros, this.config.defaultRequestBudget ?? 100); }
  async claim(runId: string) { return this.repository.claim(runId, this.leaseMs); }
  async beginDispatch(claim: DispatchClaim, validateConsent?: () => Promise<void>) { return this.repository.beginDispatch(claim, validateConsent); }
  async heartbeat(claim: DispatchClaim) { return this.repository.heartbeat(claim, this.leaseMs); }
  async complete(claim: DispatchClaim, actualCostMicros: number) { return this.repository.complete(claim, actualCostMicros); }
  async completeWithResult<T>(claim: DispatchClaim, actualCostMicros: number, persist: () => Promise<T>) { return this.repository.completeWithResult(claim, actualCostMicros, persist); }
  async fail(claim: DispatchClaim, error: string) { return this.repository.fail(claim, error); }
  async reconcileExpired() { return this.repository.reconcileExpired(); }
  async get(runId: string) { return this.repository.get(runId); }
  async list(projectId: string) { return this.repository.list(projectId); }
  async acknowledgeAndRetry(runId: string): Promise<ProviderRun> {
    return this.repository.acknowledgeAndRetry(runId, this.config.defaultBudgetMicros, this.config.defaultRequestBudget ?? 100);
  }
}
