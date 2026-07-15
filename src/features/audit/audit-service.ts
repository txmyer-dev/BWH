import type {FactualityAuditor} from './auditor';
import type {AuditRepository} from './audit-repository';
import {sha256Canonical} from './audit-repository';
import type {AuditContract} from './audit-repository';

export class AuditService {
  constructor(private readonly repository: AuditRepository, private readonly auditor: FactualityAuditor, private readonly assertCreator: (projectId: string) => Promise<void>, private readonly expectedContract?: AuditContract, private readonly expectedTranscriptionModel = 'nova-3') {}
  async requestAudit(projectId: string) {
    await this.assertCreator(projectId);
    const snapshot = await this.repository.loadSnapshot(projectId);
    if (snapshot.durationSeconds < 120 || snapshot.durationSeconds > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
    if (!snapshot.narration.length || snapshot.narration.some((scene) => !scene.text.trim())) throw new Error('AUDIT_APPROVED_EVIDENCE_REQUIRED');
    const evidenceHash = sha256Canonical(snapshot.evidence);
    const narrationHash = sha256Canonical(snapshot.narration);
    return this.auditor.audit({...snapshot, evidenceHash, narrationHash});
  }
  async approveNarrationText(projectId: string, auditId: string, narrationHash: string, evidenceHash: string, storyboardRevision: number) {
    await this.assertCreator(projectId);
    const audit = await this.repository.findById(projectId, auditId);
    if (!audit) throw new Error('AUDIT_NOT_FOUND');
    if (this.expectedContract && (audit.auditPromptVersion !== this.expectedContract.auditPromptVersion || audit.auditSchemaVersion !== this.expectedContract.auditSchemaVersion || audit.model !== this.expectedContract.model)) throw new Error('AUDIT_CONTRACT_STALE');
    if (audit.status !== 'passed' || audit.findings.some((finding) => finding.blocking)) throw new Error('AUDIT_BLOCKING_FINDINGS');
    if (audit.narrationHash !== narrationHash || audit.evidenceHash !== evidenceHash || audit.storyboardRevision !== storyboardRevision) throw new Error('AUDIT_HASH_MISMATCH');
    return this.repository.approve(projectId, audit);
  }
  async requestCreatorAudioAudit(projectId: string, assetId: string) {
    await this.assertCreator(projectId);
    const snapshot = await this.repository.loadCreatorAudioSnapshot(projectId, assetId);
    const evidenceHash = sha256Canonical(snapshot.evidence); const narrationHash = sha256Canonical({text: snapshot.narration[0]?.text ?? ''});
    return this.auditor.audit({...snapshot, evidenceHash, narrationHash});
  }
  async approveCreatorAudioTranscript(projectId: string, assetId: string, auditId: string, narrationHash: string, evidenceHash: string) {
    await this.assertCreator(projectId); const audit = await this.repository.findById(projectId, auditId);
    if (!audit || audit.auditScope !== 'creator_audio' || audit.assetId !== assetId || audit.status !== 'passed' || audit.findings.some((finding) => finding.blocking)) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
    const current = await this.repository.loadCreatorAudioSnapshot(projectId, assetId);
    const currentNarrationHash = sha256Canonical({text: current.narration[0]?.text ?? ''}); const currentEvidenceHash = sha256Canonical(current.evidence);
    if (this.expectedContract && (audit.auditPromptVersion !== this.expectedContract.auditPromptVersion || audit.auditSchemaVersion !== this.expectedContract.auditSchemaVersion || audit.model !== this.expectedContract.model)) throw new Error('AUDIT_CONTRACT_STALE');
    if (audit.narrationHash !== narrationHash || audit.evidenceHash !== evidenceHash || audit.narrationHash !== currentNarrationHash || audit.evidenceHash !== currentEvidenceHash || audit.transcriptId !== current.transcriptId || audit.transcriptProviderRunId !== current.transcriptProviderRunId || audit.storyboardRevision !== current.storyboardRevision) throw new Error('AUDIT_HASH_MISMATCH');
    if (!this.expectedContract) throw new Error('AUDIT_CONTRACT_STALE');
    return this.repository.approveCreatorAudio(projectId, assetId, audit, {auditContract: this.expectedContract, transcriptionModel: this.expectedTranscriptionModel});
  }
}
