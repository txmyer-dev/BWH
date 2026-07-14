import {describe, expect, it} from 'vitest';

import type {Asset, AssetRepository} from '../media/asset-service';
import type {MediaStorage} from '../media/storage';
import {PrivateAnalysisAssetSource} from './evidence-service';

const projectId = crypto.randomUUID();
const base = (overrides: Partial<Asset>): Asset => ({
  id: crypto.randomUUID(), projectId, kind: 'image', originalName: 'photo.jpg',
  mimeType: 'image/jpeg', originalObjectKey: `projects/${projectId}/originals/source`,
  processingStatus: 'ready', reservationExpiresAt: null, size: 3, caption: null,
  capturedAtText: null, knownPeople: [], sequenceOrder: 0, ...overrides
});

describe('PrivateAnalysisAssetSource', () => {
  it('reads image bytes and bounded supporting text only through trusted storage', async () => {
    const image = base({caption: 'At the station', capturedAtText: 'circa 1952', knownPeople: ['Ruth']});
    const text = base({kind: 'text', originalName: 'notes.txt', mimeType: 'text/plain', originalObjectKey: 'private/notes', size: 18, sequenceOrder: 0});
    const audio = base({kind: 'source_audio', originalName: 'memory.mp3', mimeType: 'audio/mpeg', originalObjectKey: 'private/audio', size: 12, sequenceOrder: 0, transcript: 'We took the train.'});
    const repository = {listByProject: async () => [image, text, audio]} as unknown as AssetRepository;
    const reads: string[] = [];
    const storage = {readObject: async ({objectKey}: {objectKey: string; maxBytes: number}) => {
      reads.push(objectKey);
      return Buffer.from(objectKey === 'private/notes' ? 'Family notes here.' : 'img');
    }} as unknown as MediaStorage;
    const assets = await new PrivateAnalysisAssetSource(repository, storage).listReadyAnalysisAssets(projectId);

    expect(assets).toEqual([
      expect.objectContaining({id: image.id, kind: 'image', imageBytes: 'data:image/jpeg;base64,aW1n', caption: expect.stringContaining('Ruth')}),
      expect.objectContaining({id: text.id, kind: 'text', text: 'Family notes here.'}),
      expect.objectContaining({id: audio.id, kind: 'transcript', text: 'We took the train.'})
    ]);
    expect(reads).toEqual([image.originalObjectKey, text.originalObjectKey]);
  });

  it('rejects oversized supporting text before returning it to the model', async () => {
    const text = base({kind: 'text', mimeType: 'text/plain', size: 60_000});
    const repository = {listByProject: async () => [text]} as unknown as AssetRepository;
    const storage = {readObject: async () => Buffer.alloc(60_000)} as unknown as MediaStorage;
    await expect(new PrivateAnalysisAssetSource(repository, storage).listReadyAnalysisAssets(projectId)).rejects.toThrow('ANALYSIS_TEXT_TOO_LARGE');
  });
});
