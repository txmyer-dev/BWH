import {access, writeFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

import {MemoryStorage} from '../media/memory-storage';
import type {FilmSource} from './manifest';
import {FilmRenderService, InMemoryFilmRepository, RemotionFilmRenderer, assembleFilmSource, type FilmRenderer} from './render-service';

const source = (): FilmSource => ({
  projectId: '11111111-1111-4111-8111-111111111111',
  storyboardId: '22222222-2222-4222-8222-222222222222',
  storyboardRevision: 3,
  auditId: '33333333-3333-4333-8333-333333333333',
  evidenceHash: 'c'.repeat(64),
  narrationHash: 'd'.repeat(64),
  title: 'A Chapter Together',
  subjectName: 'June',
  dedication: '',
  disclosure: 'Narration created with a generated voice from Deepgram.',
  auditPassed: true,
  textApproved: true,
  audioApproved: true,
  creatorNarrationObjectKey: null,
  scenes: [0, 1, 2].map((index) => ({
    id: `44444444-4444-4444-8444-44444444444${index}`,
    sceneType: index === 0 ? 'title' : index === 2 ? 'credits' : 'media',
    title: `Scene ${index + 1}`,
    narrationText: index === 1 ? 'A true memory.' : '',
    captionText: '',
    durationSeconds: 40,
    imageObjectKeys: index === 1 ? ['projects/private/image.jpg'] : [],
    narrationObjectKey: index === 1 ? 'projects/private/voice.wav' : null,
    authenticClip: null,
    motionPreset: 'hold',
    transitionPreset: 'crossfade'
  }))
});

class RecordingRenderer implements FilmRenderer {
  calls = 0;
  async render() {
    this.calls += 1;
    return Buffer.from('mp4-demo');
  }
}

const setup = () => {
  const repository = new InMemoryFilmRepository();
  repository.seed(source());
  const storage = new MemoryStorage();
  storage.upload('projects/private/image.jpg', 5, 'image/jpeg', 'image');
  storage.upload('projects/private/voice.wav', 5, 'audio/wav', 'audio');
  const renderer = new RecordingRenderer();
  const service = new FilmRenderService(repository, storage, renderer, async () => undefined);
  return {repository, storage, renderer, service};
};

describe('FilmRenderService', () => {
  it('renders one deterministic private MP4 and reuses it for the same manifest', async () => {
    const {renderer, service, storage} = setup();

    const first = await service.render(source().projectId);
    const second = await service.render(source().projectId);

    expect(second).toEqual({...first, reused: true});
    expect(renderer.calls).toBe(1);
    expect(first.objectKey).toBe(`projects/${source().projectId}/renders/${first.manifestHash}.mp4`);
    expect(await storage.readObject({objectKey: first.objectKey, maxBytes: 100})).toEqual(Buffer.from('mp4-demo'));
  });

  it('authorizes before loading or rendering private project data', async () => {
    const repository = new InMemoryFilmRepository();
    const renderer = new RecordingRenderer();
    const service = new FilmRenderService(repository, new MemoryStorage(), renderer, async () => {
      throw new Error('PROJECT_NOT_FOUND');
    });

    await expect(service.render(source().projectId)).rejects.toThrow('PROJECT_NOT_FOUND');
    expect(repository.loadCalls).toBe(0);
    expect(renderer.calls).toBe(0);
  });

  it('creates a fresh fifteen-minute owner-only download URL', async () => {
    const {service, storage} = setup();
    await service.render(source().projectId);

    const download = await service.getDownload(source().projectId);

    expect(download.expiresAt.getTime() - download.createdAt.getTime()).toBe(900_000);
    expect(storage.signedRequests.at(-1)).toMatchObject({operation: 'download', expiresInMs: 900_000});
  });
});

describe('assembleFilmSource', () => {
  it('requires a current generated narration track for every narrated scene', () => {
    const base = source();
    const narratedScene = base.scenes[1];
    const input = {
      projectId: base.projectId,
      storyboardId: base.storyboardId,
      storyboardRevision: base.storyboardRevision,
      auditId: base.auditId,
      evidenceHash: base.evidenceHash,
      narrationHash: base.narrationHash,
      title: base.title,
      subjectName: base.subjectName,
      dedication: base.dedication,
      audioApproved: true,
      selection: {kind: 'generated' as const, provider: 'deepgram' as const, model: 'aura-2-arcas-en', voice: 'aura-2-arcas-en'},
      scenes: base.scenes.map((scene) => ({...scene, assetIds: scene.imageObjectKeys.length ? ['55555555-5555-4555-8555-555555555555'] : [], authenticClip: null})),
      assets: [{id: '55555555-5555-4555-8555-555555555555', assetKind: 'image', processingStatus: 'ready', originalObjectKey: 'projects/private/image.jpg'}],
      tracks: []
    };

    expect(() => assembleFilmSource(input)).toThrow('FILM_NARRATION_TRACK_REQUIRED');
    expect(assembleFilmSource({...input, tracks: [{
      sceneId: narratedScene.id,
      provider: 'deepgram',
      model: 'aura-2-arcas-en',
      voice: 'aura-2-arcas-en',
      auditId: base.auditId,
      narrationHash: base.narrationHash,
      objectKey: 'projects/private/voice.wav'
    }]}).scenes[1].narrationObjectKey).toBe('projects/private/voice.wav');
  });
});

describe('RemotionFilmRenderer', () => {
  it('renders H.264 to temporary storage and removes the temporary file', async () => {
    let outputLocation = '';
    const renderer = new RemotionFilmRenderer({
      bundlePath: 'C:/bundle',
      concurrency: 4,
      selectComposition: async () => ({id: 'MemoryFilm', width: 1920, height: 1080, fps: 30, durationInFrames: 3_600, defaultProps: {}}),
      renderMedia: async (input) => {
        outputLocation = input.outputLocation;
        expect(input.codec).toBe('h264');
        expect(input.concurrency).toBe(4);
        await writeFile(input.outputLocation, Buffer.from('rendered-mp4'));
      }
    });

    const manifest = (await setup().service.render(source().projectId)).manifestHash;
    const fullManifest = (await import('./manifest')).buildRenderManifest(source());
    const projection = await (await import('./manifest')).createRenderProjection(fullManifest, async (key) => `memory://${key}`);
    const bytes = await renderer.render({manifest: fullManifest, projection});

    expect(manifest).toBe(fullManifest.manifestHash);
    expect(Buffer.from(bytes)).toEqual(Buffer.from('rendered-mp4'));
    await expect(access(outputLocation)).rejects.toThrow();
  });
});
