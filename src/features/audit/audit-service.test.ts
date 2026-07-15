import {describe, expect, it, vi} from 'vitest';

import {AuditService} from './audit-service';
import {InMemoryAuditRepository} from './audit-repository';
import {projectApprovedEvidenceLedger, projectNarrationLedger} from './audit-repository';
import type {EvidenceItem} from '../evidence/schemas';

const projectId = crypto.randomUUID();
const makeSnapshot = () => {
  const evidenceId = crypto.randomUUID();
  return ({
  projectId, storyboardId: crypto.randomUUID(), storyboardRevision: 2,
  evidence: [{id: evidenceId, claim: 'Fact', sourceExcerpt: 'Source', sourceAssetIds: [crypto.randomUUID()]}],
  narration: [{sceneId: crypto.randomUUID(), text: 'Fact.', evidenceItemIds: [evidenceId]}],
  durationSeconds: 120
  });
};

describe('AuditService', () => {
  it('performs no project read or provider work when owner authorization fails', async () => {
    const repository = new InMemoryAuditRepository(makeSnapshot());
    const read = vi.spyOn(repository, 'loadSnapshot'); const audit = vi.fn();
    const service = new AuditService(repository, {audit}, async () => { throw new Error('PROJECT_FORBIDDEN'); });
    await expect(service.requestAudit(projectId)).rejects.toThrow('PROJECT_FORBIDDEN');
    expect(read).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
  it('authorizes before reading or dispatch and audits only 120–240 second current boards', async () => {
    const events: string[] = []; const repository = new InMemoryAuditRepository(makeSnapshot());
    const service = new AuditService(repository, {audit: async (value) => { events.push('audit'); return {auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'passed', findings: [], auditPromptVersion: 'test', auditSchemaVersion: 'test', model: 'test', ...value}; }}, async () => { events.push('authorize'); });
    await service.requestAudit(projectId);
    expect(events).toEqual(['authorize', 'audit']);
  });

  it('blocks approval for findings and requires exact current revision and hashes', async () => {
    const repository = new InMemoryAuditRepository(makeSnapshot());
    const auditor = {audit: async (value: Awaited<ReturnType<typeof repository.loadSnapshot>> & {evidenceHash: string; narrationHash: string}) => repository.seedAudit({...value, auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'blocked', findings: [{sceneId: value.narration[0].sceneId, claim: 'Fact', kind: 'unsupported' as const, blocking: true, evidenceItemIds: []}]})};
    const service = new AuditService(repository, auditor, async () => undefined);
    const audit = await service.requestAudit(projectId);
    await expect(service.approveNarrationText(projectId, audit.auditId, audit.narrationHash, audit.evidenceHash, audit.storyboardRevision)).rejects.toThrow('AUDIT_BLOCKING_FINDINGS');
    const passing = repository.seedAudit({...audit, auditId: crypto.randomUUID(), status: 'passed', findings: []});
    await expect(service.approveNarrationText(projectId, passing.auditId, 'x'.repeat(64), passing.evidenceHash, passing.storyboardRevision)).rejects.toThrow('AUDIT_HASH_MISMATCH');
    await expect(service.approveNarrationText(projectId, passing.auditId, passing.narrationHash, passing.evidenceHash, passing.storyboardRevision)).resolves.toMatchObject({narrationApproved: true});
  });

  it('uses deterministic hashes of exact ordered narration and effective approved evidence', async () => {
    const repository = new InMemoryAuditRepository(makeSnapshot()); let first: unknown;
    const auditor = {audit: async (value: never) => { first = value; return repository.seedAudit({...(value as object), auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'passed', findings: []} as never); }};
    const service = new AuditService(repository, auditor, async () => undefined);
    const one = await service.requestAudit(projectId); const two = await service.requestAudit(projectId);
    expect(one.evidenceHash).toBe(two.evidenceHash); expect(one.narrationHash).toBe(two.narrationHash);
    expect(first).toMatchObject({evidenceHash: one.evidenceHash, narrationHash: one.narrationHash});
  });

  it('hashes the full effective approved ledger, including uncited evidence, and excludes proposed and rejected records', () => {
    const base = (status: EvidenceItem['verificationStatus'], overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({id: crypto.randomUUID(), projectId, kind: 'creator_memory', claim: 'Original', originalClaim: 'Original', sourceAssetIds: [], sourceExcerpt: 'Source', confidence: 1, verificationStatus: status, correction: null, ...overrides});
    const confirmed = base('confirmed'); const corrected = base('corrected', {correction: 'Corrected fact'}); const proposed = base('proposed'); const rejected = base('rejected');
    const ledger = projectApprovedEvidenceLedger([confirmed, corrected, proposed, rejected]);
    expect(ledger).toEqual([expect.objectContaining({id: confirmed.id, claim: 'Original'}), expect.objectContaining({id: corrected.id, claim: 'Corrected fact'})]);
    expect(JSON.stringify(ledger)).not.toContain(proposed.id); expect(JSON.stringify(ledger)).not.toContain(rejected.id);
  });

  it('allows an uncited narrated scene through to the auditor for a blocking missing-citation result', async () => {
    const snapshot = makeSnapshot(); snapshot.narration[0].evidenceItemIds = [];
    const repository = new InMemoryAuditRepository(snapshot); let received: unknown;
    const service = new AuditService(repository, {audit: async (value) => { received = value; return repository.seedAudit({...value, auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'blocked', findings: [{sceneId: value.narration[0].sceneId, claim: value.narration[0].text, kind: 'missing_citation', blocking: true, evidenceItemIds: []}]}); }}, async () => undefined);
    await expect(service.requestAudit(projectId)).resolves.toMatchObject({status: 'blocked'});
    expect(received).toMatchObject({narration: [expect.objectContaining({evidenceItemIds: []})]});
  });

  it('preserves narration text and citation arrays exactly as saved', () => {
    const sceneId = crypto.randomUUID(); const unknownId = crypto.randomUUID();
    expect(projectNarrationLedger([{id: sceneId, narrationText: '  Exact creator wording.  ', evidenceItemIds: [unknownId]}])).toEqual([{sceneId, text: '  Exact creator wording.  ', evidenceItemIds: [unknownId]}]);
  });

  it('requires a fresh audit when the persisted audit contract differs from the current deployment', async () => {
    const repository = new InMemoryAuditRepository(makeSnapshot()); const snapshot = await repository.loadSnapshot(projectId);
    const audit = repository.seedAudit({...snapshot, evidenceHash: 'e'.repeat(64), narrationHash: 'n'.repeat(64), auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'passed', findings: [], auditPromptVersion: 'old', auditSchemaVersion: 'schema', model: 'gpt-5.6'});
    const service = new AuditService(repository, {audit: async () => audit}, async () => undefined, {auditPromptVersion: 'current', auditSchemaVersion: 'schema', model: 'gpt-5.6'});
    await expect(service.approveNarrationText(projectId, audit.auditId, audit.narrationHash, audit.evidenceHash, audit.storyboardRevision)).rejects.toThrow('AUDIT_CONTRACT_STALE');
  });

  it('audits and approves the actual creator narration transcript as a distinct target', async () => {
    const repository = new InMemoryAuditRepository(makeSnapshot()); const assetId = crypto.randomUUID();
    repository.seedCreatorAudio({projectId, assetId, transcriptId: crypto.randomUUID(), transcriptText: 'The actual Nova-3 words.'});
    const service = new AuditService(repository, {audit: async (value) => repository.seedAudit({...value, auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'passed', findings: []})}, async () => undefined);
    const audit = await service.requestCreatorAudioAudit(projectId, assetId);
    expect(audit).toMatchObject({auditScope: 'creator_audio', assetId});
    await expect(service.approveCreatorAudioTranscript(projectId, assetId, audit.auditId, audit.narrationHash, audit.evidenceHash)).resolves.toMatchObject({creatorAudioApproved: true});
  });
});
