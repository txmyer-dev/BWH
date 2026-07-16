import {describe, expect, it} from 'vitest';

import {buildRenderManifest, createRenderProjection, type FilmSource} from './manifest';

const ids = {
  project: '11111111-1111-4111-8111-111111111111',
  storyboard: '22222222-2222-4222-8222-222222222222',
  audit: '33333333-3333-4333-8333-333333333333',
  scenes: [
    '44444444-4444-4444-8444-444444444441',
    '44444444-4444-4444-8444-444444444442',
    '44444444-4444-4444-8444-444444444443'
  ]
};

const source = (): FilmSource => ({
  projectId: ids.project,
  storyboardId: ids.storyboard,
  storyboardRevision: 7,
  auditId: ids.audit,
  evidenceHash: 'a'.repeat(64),
  narrationHash: 'b'.repeat(64),
  title: 'A Life in Motion',
  subjectName: 'June',
  dedication: 'For everyone who carries these memories forward.',
  disclosure: 'Narration created with a generated voice from Deepgram.',
  auditPassed: true,
  textApproved: true,
  audioApproved: true,
  creatorNarrationObjectKey: null,
  scenes: ids.scenes.map((id, index) => ({
    id,
    sceneType: index === 0 ? 'title' : index === 2 ? 'credits' : 'media',
    title: ['Beginnings', 'The summer everything changed', 'With love'][index],
    narrationText: index === 1 ? 'June found a new sense of home that summer.' : '',
    captionText: index === 1 ? 'Summer, 1978' : '',
    durationSeconds: 40,
    imageObjectKeys: index === 1 ? ['projects/private/assets/summer.jpg'] : [],
    narrationObjectKey: index === 1 ? 'projects/private/narration/scene.wav' : null,
    authenticClip: null,
    motionPreset: index === 1 ? 'slow_zoom_in' : 'hold',
    transitionPreset: 'crossfade'
  }))
});

describe('buildRenderManifest', () => {
  it('creates the same private manifest and hash for unchanged approved input', () => {
    const first = buildRenderManifest(source());
    const second = buildRenderManifest(source());

    expect(first).toEqual(second);
    expect(first).toMatchObject({version: 1, width: 1920, height: 1080, fps: 30, totalFrames: 3_600});
    expect(first.scenes.map((scene) => scene.fromFrame)).toEqual([0, 1_200, 2_400]);
    expect(JSON.stringify(first)).not.toContain('https://');
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a film whose exact story or audio approval is stale', () => {
    expect(() => buildRenderManifest({...source(), textApproved: false})).toThrow('FILM_APPROVAL_REQUIRED');
    expect(() => buildRenderManifest({...source(), audioApproved: false})).toThrow('FILM_APPROVAL_REQUIRED');
  });

  it('rejects a film outside the two-to-four-minute demo range', () => {
    const tooShort = source();
    tooShort.scenes = tooShort.scenes.map((scene) => ({...scene, durationSeconds: 20}));
    expect(() => buildRenderManifest(tooShort)).toThrow('FILM_DURATION_OUT_OF_RANGE');
  });
});

describe('createRenderProjection', () => {
  it('resolves private object keys only for the in-memory render projection', async () => {
    const requested: string[] = [];
    const projection = await createRenderProjection(buildRenderManifest(source()), async (objectKey) => {
      requested.push(objectKey);
      return `https://signed.example/${encodeURIComponent(objectKey)}`;
    });

    expect(requested).toEqual([
      'projects/private/assets/summer.jpg',
      'projects/private/narration/scene.wav'
    ]);
    expect(projection.scenes[1]).toMatchObject({
      imageUrls: ['https://signed.example/projects%2Fprivate%2Fassets%2Fsummer.jpg'],
      narrationUrl: 'https://signed.example/projects%2Fprivate%2Fnarration%2Fscene.wav'
    });
  });
});
