import {describe, expect, it, vi} from 'vitest';

import {AuditService} from './audit-service';
import {InMemoryAuditRepository} from './audit-repository';

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
    const service = new AuditService(repository, {audit: async (value) => { events.push('audit'); return {auditId: crypto.randomUUID(), providerRunId: crypto.randomUUID(), status: 'passed', findings: [], ...value}; }}, async () => { events.push('authorize'); });
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
});
