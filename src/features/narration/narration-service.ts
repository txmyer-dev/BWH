import {fingerprintInput} from '../providers/input-fingerprint';
import type {ProviderExecutionInput, ProviderExecutor} from '../providers/types';
import {azureNarrationPricing} from './azure-narration';
import {deepgramNarrationPricing} from './deepgram-narration';
import type {NarrationProvider} from './narration-provider';
import type {NarrationRepository, NarrationSample, NarrationSelection, NarrationTrack} from './narration-repository';

export type NarrationStorage = {writePrivateObject(objectKey: string, bytes: Uint8Array, contentType: 'audio/wav'): Promise<void>; deleteMany(objectKeys: string[]): Promise<void>};
type GeneratedResult = {objectKey: string; durationMs: number; sourceTextHash: string};

export class NarrationService {
  constructor(
    private readonly repository: NarrationRepository,
    private readonly executor: ProviderExecutor,
    private readonly providers: Partial<Record<'deepgram'|'azure', NarrationProvider>>,
    private readonly storage: NarrationStorage,
    private readonly assertCreator: (projectId: string) => Promise<void>,
    private readonly fingerprintSecret: string,
    private readonly azurePriceMicrosPerMillionCharacters?: number
  ) {}

  private pricing(provider: 'deepgram'|'azure', characters: number) { return provider === 'deepgram' ? deepgramNarrationPricing(characters) : azureNarrationPricing(characters, this.azurePriceMicrosPerMillionCharacters ?? 0); }

  private execution(input: {projectId: string; provider: 'deepgram'|'azure'; text: string; operation: 'sample_voice'|'synthesize_narration'; canonicalInput: Record<string, unknown>; objectKey: (runId: string) => string; persist: (writer: Parameters<ProviderExecutionInput<GeneratedResult>['persistResult']>[0], runId: string, result: GeneratedResult) => Promise<void>; load: (runId: string) => Promise<GeneratedResult>}) {
    const selected = this.providers[input.provider]; if (!selected) throw new Error(input.provider === 'azure' ? 'AZURE_NARRATION_NOT_CONFIGURED' : 'DEEPGRAM_NARRATION_NOT_CONFIGURED');
    const price = this.pricing(input.provider, input.text.length);
    const sourceTextHash = fingerprintInput(this.fingerprintSecret, input.projectId, {text: input.text});
    return this.executor.execute<GeneratedResult>({
      projectId: input.projectId, provider: input.provider === 'azure' ? 'microsoft_azure' : 'deepgram', model: selected.model, operation: input.operation,
      dataCategories: ['approved_narration_text'], canonicalInput: {...input.canonicalInput, sourceTextHash, provider: input.provider, model: selected.model, voice: selected.model}, estimatedCostMicros: price.estimatedCostMicros, pricingVersion: price.pricingVersion,
      dispatch: async ({runId, signal}) => {
        const audio = await selected.synthesize({text: input.text, voice: selected.model, requestId: runId, signal});
        const objectKey = input.objectKey(runId); await this.storage.writePrivateObject(objectKey, audio.bytes, 'audio/wav');
        return {result: {objectKey, durationMs: audio.durationMs, sourceTextHash}, usage: {actualCostMicros: price.estimatedCostMicros, requestCount: 1, metadata: {characters: input.text.length, durationMs: audio.durationMs, pricingVersion: price.pricingVersion}}};
      }, loadResult: input.load, persistResult: async (writer, claim, result) => input.persist(writer, claim.runId, result), cleanupOrphanedResult: async (result) => this.storage.deleteMany([result.objectKey])
    });
  }

  async sample(projectId: string, provider: 'deepgram'|'azure'): Promise<NarrationSample> {
    await this.assertCreator(projectId); const snapshot = await this.repository.loadApprovedStoryboard(projectId);
    const text = snapshot.scenes.map((scene) => scene.text).join(' ').slice(0, 500).trim(); if (!text) throw new Error('NARRATION_TEXT_APPROVAL_REQUIRED');
    const selected = this.providers[provider]; if (!selected) throw new Error(provider === 'azure' ? 'AZURE_NARRATION_NOT_CONFIGURED' : 'DEEPGRAM_NARRATION_NOT_CONFIGURED');
    const executed = await this.execution({projectId, provider, text, operation: 'sample_voice', canonicalInput: {storyboardId: snapshot.storyboardId, revision: snapshot.revision, auditId: snapshot.auditId, narrationHash: snapshot.narrationHash, purpose: 'sample'}, objectKey: (runId) => `projects/${projectId}/narration/${runId}/sample.wav`, load: async (runId) => { const row = await this.repository.findSampleByProviderRun(projectId, runId); if (!row) throw new Error('NARRATION_SAMPLE_RESULT_NOT_FOUND'); return {objectKey: row.objectKey, durationMs: row.durationMs, sourceTextHash: row.sourceTextHash}; }, persist: async (writer, runId, result) => { await this.repository.saveSample(writer, {projectId, storyboardId: snapshot.storyboardId, providerRunId: runId, provider, model: selected.model, voice: selected.model, auditId: snapshot.auditId, narrationHash: snapshot.narrationHash, ...result}); }});
    const sample = await this.repository.findSampleByProviderRun(projectId, executed.runId); if (!sample) throw new Error('NARRATION_SAMPLE_RESULT_NOT_FOUND'); return sample;
  }

  async approveSample(projectId: string, sampleId: string) { await this.assertCreator(projectId); return this.repository.approveSample(projectId, sampleId); }

  async approveAudioSelection(projectId: string, input: {kind: 'generated'; provider: 'deepgram'|'azure'; sampleId: string}|{kind: 'creator'; assetId: string}): Promise<NarrationSelection> {
    await this.assertCreator(projectId); const snapshot = await this.repository.loadApprovedStoryboard(projectId);
    if (input.kind === 'creator') { const approval = await this.repository.assertCreatorAudioApproved(projectId, input.assetId); return this.repository.setSelection(projectId, {kind: 'creator', ...approval}); }
    const provider = this.providers[input.provider]; if (!provider) throw new Error(input.provider === 'azure' ? 'AZURE_NARRATION_NOT_CONFIGURED' : 'DEEPGRAM_NARRATION_NOT_CONFIGURED');
    const sample = await this.repository.findSample(projectId, input.sampleId);
    if (!sample?.approvedAt || sample.provider !== input.provider || sample.model !== provider.model || sample.voice !== provider.model || sample.auditId !== snapshot.auditId || sample.narrationHash !== snapshot.narrationHash) throw new Error('NARRATION_SAMPLE_APPROVAL_REQUIRED');
    return this.repository.setSelection(projectId, {kind: 'generated', provider: input.provider, sampleId: sample.id, model: sample.model, voice: sample.voice, auditId: snapshot.auditId, narrationHash: snapshot.narrationHash});
  }

  async generateMissingSegments(projectId: string): Promise<NarrationTrack[]> {
    await this.assertCreator(projectId); const snapshot = await this.repository.loadApprovedStoryboard(projectId); const selection = await this.repository.getSelection(projectId);
    if (!selection || selection.kind !== 'generated' || selection.auditId !== snapshot.auditId || selection.narrationHash !== snapshot.narrationHash) throw new Error('NARRATION_SELECTION_REQUIRED');
    const provider = this.providers[selection.provider]; if (!provider || provider.model !== selection.model) throw new Error(selection.provider === 'azure' ? 'AZURE_NARRATION_NOT_CONFIGURED' : 'DEEPGRAM_NARRATION_NOT_CONFIGURED');
    const tracks: NarrationTrack[] = [];
    for (const scene of snapshot.scenes) {
      const sourceTextHash = fingerprintInput(this.fingerprintSecret, projectId, {text: scene.text});
      const existing = await this.repository.findTrack(projectId, scene.id, sourceTextHash, selection.provider, selection.model, selection.voice); if (existing) { tracks.push(existing); continue; }
      const executed = await this.execution({projectId, provider: selection.provider, text: scene.text, operation: 'synthesize_narration', canonicalInput: {storyboardId: snapshot.storyboardId, sceneId: scene.id, revision: snapshot.revision, auditId: snapshot.auditId, narrationHash: snapshot.narrationHash}, objectKey: (runId) => `projects/${projectId}/narration/${runId}/scenes/${scene.id}.wav`, load: async (runId) => { const row = await this.repository.findTrackByProviderRun(projectId, runId); if (!row) throw new Error('NARRATION_TRACK_RESULT_NOT_FOUND'); return {objectKey: row.objectKey, durationMs: row.durationMs, sourceTextHash: row.sourceTextHash}; }, persist: async (writer, runId, result) => { await this.repository.saveTrack(writer, {projectId, storyboardId: snapshot.storyboardId, sceneId: scene.id, providerRunId: runId, provider: selection.provider, model: selection.model, voice: selection.voice, auditId: snapshot.auditId, narrationHash: snapshot.narrationHash, ...result}); }});
      const track = await this.repository.findTrackByProviderRun(projectId, executed.runId); if (!track) throw new Error('NARRATION_TRACK_RESULT_NOT_FOUND'); tracks.push(track);
    }
    return tracks;
  }
}
