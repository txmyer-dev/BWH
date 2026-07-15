import {describe, expect, it, vi} from 'vitest';

import type {ProviderExecutor} from '../providers/types';
import {InMemoryNarrationRepository} from './narration-repository';
import {NarrationService} from './narration-service';
import type {NarrationProvider} from './narration-provider';

const wav = () => {
  const bytes = Buffer.alloc(44 + 3200); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40); return bytes;
};
const executor: ProviderExecutor = {execute: async (input) => {
  const dispatched = await input.dispatch({runId: '00000000-0000-4000-8000-000000000099', providerIdempotencyKey: 'safe', signal: new AbortController().signal});
  await input.persistResult({writeStructured: async (write) => write({} as never)}, {runId: '00000000-0000-4000-8000-000000000099', leaseToken: 'lease', consentId: 'consent', dispatchDeadlineAt: new Date()}, dispatched.result);
  return {runId: '00000000-0000-4000-8000-000000000099', cacheHit: false, result: dispatched.result};
}};

describe('NarrationService', () => {
  const setup = () => {
    const repo = new InMemoryNarrationRepository();
    repo.seedApprovedStoryboard({projectId: '00000000-0000-4000-8000-000000000001', storyboardId: '00000000-0000-4000-8000-000000000002', revision: 3, auditId: '00000000-0000-4000-8000-000000000003', narrationHash: 'approved-hash', scenes: [{id: '00000000-0000-4000-8000-000000000004', text: 'A true family memory.'}, {id: '00000000-0000-4000-8000-000000000005', text: 'Another true memory.'}]});
    const synthesize = vi.fn(async () => ({bytes: wav(), mimeType: 'audio/wav' as const, durationMs: 100, safeRequestId: 'safe'}));
    const provider: NarrationProvider = {id: 'deepgram', model: 'aura-2-arcas-en', synthesize};
    const objects = new Map<string, Uint8Array>();
    const storage = {writePrivateObject: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); }), deleteMany: vi.fn(async (keys: string[]) => keys.forEach((key) => objects.delete(key)))};
    const service = new NarrationService(repo, executor, {deepgram: provider}, storage, async () => undefined, 'fingerprint-secret-at-least-32-characters');
    return {repo, service, synthesize, storage};
  };

  it('requires an explicitly approved sample before selecting generated narration', async () => {
    const {service} = setup();
    const sample = await service.sample('00000000-0000-4000-8000-000000000001', 'deepgram');
    await expect(service.approveAudioSelection('00000000-0000-4000-8000-000000000001', {kind: 'generated', provider: 'deepgram', sampleId: sample.id})).rejects.toThrow('NARRATION_SAMPLE_APPROVAL_REQUIRED');
    await service.approveSample('00000000-0000-4000-8000-000000000001', sample.id);
    await expect(service.approveAudioSelection('00000000-0000-4000-8000-000000000001', {kind: 'generated', provider: 'deepgram', sampleId: sample.id})).resolves.toMatchObject({provider: 'deepgram'});
  });

  it('generates only missing exact-hash scene segments and reuses unchanged tracks', async () => {
    const {service, synthesize} = setup(); const projectId = '00000000-0000-4000-8000-000000000001';
    const sample = await service.sample(projectId, 'deepgram'); await service.approveSample(projectId, sample.id); await service.approveAudioSelection(projectId, {kind: 'generated', provider: 'deepgram', sampleId: sample.id});
    await service.generateMissingSegments(projectId); expect(synthesize).toHaveBeenCalledTimes(3);
    await service.generateMissingSegments(projectId); expect(synthesize).toHaveBeenCalledTimes(3);
  });

  it('does not fail over when the deliberately selected provider fails', async () => {
    const {repo, storage} = setup(); const azure = {id: 'azure' as const, model: 'voice', synthesize: vi.fn()};
    const deepgram = {id: 'deepgram' as const, model: 'aura-2-arcas-en', synthesize: vi.fn(async () => { throw new Error('NARRATION_PROVIDER_UNAVAILABLE'); })};
    const service = new NarrationService(repo, executor, {deepgram, azure}, storage, async () => undefined, 'fingerprint-secret-at-least-32-characters');
    await expect(service.sample('00000000-0000-4000-8000-000000000001', 'deepgram')).rejects.toThrow('NARRATION_PROVIDER_UNAVAILABLE');
    expect(azure.synthesize).not.toHaveBeenCalled();
  });

  it('rejects creator audio until the actual transcript has a current exact-hash approval', async () => {
    const {service, repo} = setup(); const projectId = '00000000-0000-4000-8000-000000000001'; const assetId = '00000000-0000-4000-8000-000000000006';
    repo.seedCreatorAudio({projectId, assetId, transcriptText: 'Actual Nova-3 transcript', provider: 'deepgram', audited: false});
    await expect(service.approveAudioSelection(projectId, {kind: 'creator', assetId})).rejects.toThrow('CREATOR_AUDIO_AUDIT_REQUIRED');
    repo.approveCreatorTranscript(projectId, assetId);
    await expect(service.approveAudioSelection(projectId, {kind: 'creator', assetId})).resolves.toMatchObject({kind: 'creator'});
  });
});
