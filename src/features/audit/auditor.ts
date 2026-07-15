import type {FactualityAuditInput, FactualityAuditResult} from './schemas';

export interface FactualityAuditor {
  audit(input: FactualityAuditInput): Promise<FactualityAuditResult>;
}
