import {describe, expect, it, vi} from 'vitest';

import type {ProviderExecutor} from '../providers/types';
import {InMemoryProviderStructuredResultStore} from '../story/gemini-story-agent';
import {InMemoryAuditRepository} from './audit-repository';
import {GeminiFactualityAuditor} from './gemini-factuality-auditor';

const projectId = crypto.randomUUID();
const evidenceId = crypto.randomUUID();
const sceneId = crypto.randomUUID();
const input = {
  projectId,
  storyboardId: crypto.randomUUID(),
  storyboardRevision: 1,
  evidenceHash: 'e'.repeat(64),
  narrationHash: 'n'.repeat(64),
  evidence: [{id: evidenceId, claim: 'The family held an annual picnic.', sourceExcerpt: 'Annual picnic', sourceAssetIds: [crypto.randomUUID()]}],
  narration: [{sceneId, text: 'The family held an annual picnic.', evidenceItemIds: [evidenceId]}]
};
const output = {findings: [{sceneId, claim: input.narration[0].text, kind: 'supported' as const, blocking: false, evidenceItemIds: [evidenceId]}]};

const executor = (): ProviderExecutor => ({execute: vi.fn(async (request) => {
  const runId = crypto.randomUUID();
  const dispatched = await request.dispatch({runId, providerIdempotencyKey: `provider-run-${runId}`, signal: new AbortController().signal});
  await request.persistResult(
    {writeStructured: async (write: (transaction: never) => Promise<void>) => write({} as never)},
    {runId, leaseToken: crypto.randomUUID(), consentId: crypto.randomUUID(), dispatchDeadlineAt: new Date(Date.now() + 60_000)},
    dispatched.result
  );
  return {runId, cacheHit: false, result: dispatched.result};
})});

describe('GeminiFactualityAuditor', () => {
  it('audits approved narration through Google Gemini and persists the exact audit contract', async () => {
    const gate = executor();
    const client = {
      models: {generateContent: vi.fn(async (_request: unknown) => ({text: JSON.stringify(output), usageMetadata: {promptTokenCount: 100, candidatesTokenCount: 20}}))}
    };
    const repository = new InMemoryAuditRepository();
    const result = await new GeminiFactualityAuditor(
      client as never,
      {model: 'gemini-3.1-flash-lite'},
      gate,
      new InMemoryProviderStructuredResultStore(),
      repository
    ).audit(input);
    expect(result).toMatchObject({status: 'passed', model: 'gemini-3.1-flash-lite'});
    const execution = vi.mocked(gate.execute).mock.calls[0][0];
    expect(execution).toMatchObject({
      provider: 'google_gemini',
      model: 'gemini-3.1-flash-lite',
      operation: 'audit_narration',
      dataCategories: ['approved_narration_text', 'source_references']
    });
    const request = client.models.generateContent.mock.calls[0][0] as {config: {responseMimeType: string; responseJsonSchema: unknown}; contents: unknown};
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseJsonSchema).toBeTruthy();
    expect(JSON.stringify(request.contents)).toContain('UNTRUSTED_APPROVED_RECORD_AND_NARRATION_JSON');
  });
});
