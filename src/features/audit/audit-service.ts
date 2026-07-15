import type {FactualityAuditor} from './auditor';
import type {AuditRepository} from './audit-repository';
import {sha256Canonical} from './audit-repository';

export class AuditService {
  constructor(private readonly repository: AuditRepository, private readonly auditor: FactualityAuditor, private readonly assertCreator: (projectId: string) => Promise<void>) {}
  async requestAudit(projectId: string) {
    await this.assertCreator(projectId);
    const snapshot = await this.repository.loadSnapshot(projectId);
    if (snapshot.durationSeconds < 120 || snapshot.durationSeconds > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
    const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
    if (!snapshot.narration.length || snapshot.narration.some((scene) => !scene.text.trim() || !scene.evidenceItemIds.length || scene.evidenceItemIds.some((id) => !evidenceIds.has(id)))) throw new Error('AUDIT_APPROVED_EVIDENCE_REQUIRED');
    const evidenceHash = sha256Canonical(snapshot.evidence);
    const narrationHash = sha256Canonical(snapshot.narration);
    return this.auditor.audit({...snapshot, evidenceHash, narrationHash});
  }
  async approveNarrationText(projectId: string, auditId: string, narrationHash: string, evidenceHash: string, storyboardRevision: number) {
    await this.assertCreator(projectId);
    const audit = await this.repository.findById(projectId, auditId);
    if (!audit) throw new Error('AUDIT_NOT_FOUND');
    if (audit.status !== 'passed' || audit.findings.some((finding) => finding.blocking)) throw new Error('AUDIT_BLOCKING_FINDINGS');
    if (audit.narrationHash !== narrationHash || audit.evidenceHash !== evidenceHash || audit.storyboardRevision !== storyboardRevision) throw new Error('AUDIT_HASH_MISMATCH');
    return this.repository.approve(projectId, audit);
  }
}
