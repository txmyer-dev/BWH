import {describe, expect, it} from 'vitest';

import type {EvidenceItem} from '../evidence/schemas';
import {
  InMemoryStoryRepository,
  StoryService,
  type StoryGuideAgent
} from './story-service';

const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();
const assetId = crypto.randomUUID();

class MutableProjectAssets {
  constructor(public readyIds = new Set([assetId])) {}
  async listReadyProjectAssetIds() { return [...this.readyIds]; }
}

const approved = (overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: crypto.randomUUID(),
  projectId,
  kind: 'creator_memory',
  claim: 'Mara opened the neighborhood bakery in 1962.',
  originalClaim: 'Mara opened the neighborhood bakery in 1962.',
  sourceAssetIds: [assetId],
  sourceExcerpt: 'I remember opening the bakery in 1962.',
  confidence: 1,
  verificationStatus: 'confirmed',
  correction: null,
  ...overrides
});

const createAgent = (): StoryGuideAgent => ({
  generateQuestions: async () => [
    {question: 'Did she enjoy the work?', reason: 'leading', rank: 1, leading: true},
    ...Array.from({length: 6}, (_, index) => ({
      question: `What detail belongs to gap ${index + 1}?`,
      reason: `Gap ${index + 1}`,
      rank: index + 2,
      leading: false
    }))
  ],
  composeStoryboard: async ({approvedEvidence}) => ({
    title: 'The Corner Bakery',
    theme: 'Care expressed through daily work',
    voiceProfile: {
      traits: [{trait: 'Plainspoken', description: 'Uses direct language.', evidenceItemIds: [approvedEvidence[0].id]}],
      coverage: 'grounded' as const
    },
    scenes: [
      {
        sceneType: 'media' as const,
        title: 'Opening the doors',
        narrationSentences: [{text: 'Mara opened the neighborhood bakery in 1962.', evidenceItemIds: [approvedEvidence[0].id]}],
        captionText: 'The bakery, 1962', durationSeconds: 120,
        assetIds: [assetId], motionPreset: 'slow_zoom_in' as const,
        transitionPreset: 'crossfade' as const
      }
    ]
  }),
  regenerateScene: async ({scene, approvedEvidence}) => ({
    ...scene,
    title: 'A revised opening',
    narrationSentences: [{text: 'Mara welcomed her neighbors in 1962.', evidenceItemIds: [approvedEvidence[0].id]}]
  })
});

const createService = (evidence: EvidenceItem[], assertCreator = async () => undefined, assets = new MutableProjectAssets()) => {
  const repository = new InMemoryStoryRepository();
  return {repository, assets, service: new StoryService(repository, createAgent(), {listByProject: async () => evidence}, assets, assertCreator)};
};

describe('StoryService guardrails', () => {
  it('returns at most five ranked, non-leading questions derived from ranked gaps', async () => {
    const {service} = createService([approved()]);
    const questions = await service.generateQuestions(projectId);
    expect(questions).toHaveLength(5);
    expect(questions.map((question) => question.rank)).toEqual([2, 3, 4, 5, 6]);
    expect(questions.every((question) => !question.leading)).toBe(true);
  });

  it('refuses to compose a storyboard without confirmed or corrected evidence', async () => {
    const {service} = createService([approved({verificationStatus: 'proposed'})]);
    await expect(service.composeStoryboard(projectId)).rejects.toThrow('APPROVED_EVIDENCE_REQUIRED');
  });

  it('never treats a model hypothesis as factual evidence even after review', async () => {
    const {service} = createService([approved({kind: 'model_hypothesis', verificationStatus: 'confirmed'})]);
    await expect(service.composeStoryboard(projectId)).rejects.toThrow('APPROVED_EVIDENCE_REQUIRED');
  });

  it('feeds corrected evidence to story composition only as the effective corrected fact', async () => {
    const corrected = approved({claim: 'The bakery opened in 1962.', originalClaim: 'The bakery opened in 1962.', verificationStatus: 'corrected', correction: 'The bakery opened in 1964.'});
    let received: unknown;
    const agent = createAgent();
    agent.composeStoryboard = async (input) => {
      received = input.approvedEvidence;
      return createAgent().composeStoryboard(input);
    };
    const service = new StoryService(new InMemoryStoryRepository(), agent, {listByProject: async () => [corrected]}, new MutableProjectAssets(), async () => undefined);
    await service.composeStoryboard(projectId);
    expect(received).toEqual([expect.objectContaining({claim: 'The bakery opened in 1964.'})]);
    expect(JSON.stringify(received)).not.toContain('1962');
  });

  it('rejects factual narration and voice traits without project-owned approved evidence', async () => {
    const foreign = approved({id: crypto.randomUUID(), projectId: otherProjectId});
    const agent = createAgent();
    agent.composeStoryboard = async () => ({
      title: 'Unsafe', theme: 'Unsafe',
      voiceProfile: {traits: [{trait: 'Warm', description: 'Warm.', evidenceItemIds: [foreign.id]}], coverage: 'grounded'},
      scenes: [{sceneType: 'media', title: 'Unsafe', narrationSentences: [{text: 'An unsupported fact.', evidenceItemIds: [foreign.id]}], captionText: '', durationSeconds: 120, assetIds: [assetId], motionPreset: 'hold', transitionPreset: 'fade_to_black'}]
    });
    const repository = new InMemoryStoryRepository();
    const service = new StoryService(repository, agent, {listByProject: async () => [approved()]}, new MutableProjectAssets(), async () => undefined);
    await expect(service.composeStoryboard(projectId)).rejects.toThrow('UNAPPROVED_EVIDENCE_REFERENCE');
  });

  it('regenerates one scene while preserving every other ID, order, and creator edit', async () => {
    const {service} = createService([approved()]);
    const storyboard = await service.composeStoryboard(projectId);
    const extra = await service.addScene(projectId, storyboard.id, {
      sceneType: 'dedication', title: 'For our family', narrationText: '', captionText: 'With love',
      durationSeconds: 10, assetIds: [], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'fade_to_black'
    }, storyboard.revision);
    await service.editScene(projectId, storyboard.id, extra.scene.id, {captionText: 'Creator-written dedication'}, extra.storyboard.revision);
    const before = await service.getStoryboard(projectId);
    const regenerated = await service.regenerateScene(projectId, storyboard.id, storyboard.scenes[0].id, before!.revision);
    expect(regenerated.scenes.map((scene) => scene.id)).toEqual(before?.scenes.map((scene) => scene.id));
    expect(regenerated.scenes[1]).toMatchObject({id: extra.scene.id, captionText: 'Creator-written dedication'});
    expect(regenerated.scenes[0].title).toBe('A revised opening');
  });

  it('requires owner authorization and rejects cross-project storyboard IDs', async () => {
    const denied = createService([approved()], async () => { throw new Error('PROJECT_FORBIDDEN'); });
    await expect(denied.service.generateQuestions(projectId)).rejects.toThrow('PROJECT_FORBIDDEN');

    const first = createService([approved()]);
    const storyboard = await first.service.composeStoryboard(projectId);
    await expect(first.service.editScene(otherProjectId, storyboard.id, storyboard.scenes[0].id, {title: 'No'}, storyboard.revision)).rejects.toThrow('STORYBOARD_NOT_FOUND');
  });

  it('rejects narration edits without approved provenance and invalid scene asset IDs', async () => {
    const fact = approved();
    const {service} = createService([fact]);
    const storyboard = await service.composeStoryboard(projectId);
    await expect(service.addScene(projectId, storyboard.id, {
      sceneType: 'media', title: 'Unsupported', narrationText: 'A new factual claim.', captionText: '', durationSeconds: 5,
      assetIds: [crypto.randomUUID()], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'crossfade'
    }, storyboard.revision)).rejects.toThrow('NARRATION_EVIDENCE_REQUIRED');
    await expect(service.editScene(projectId, storyboard.id, storyboard.scenes[0].id, {
      assetIds: [crypto.randomUUID()]
    }, storyboard.revision)).rejects.toThrow('INVALID_SCENE_ASSET');
  });

  it('rejects a slow regeneration when an intervening explicit edit advances the revision', async () => {
    const fact = approved();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent = createAgent();
    agent.regenerateScene = async (input) => { await gate; return {...input.scene, title: 'Stale regeneration'}; };
    const repository = new InMemoryStoryRepository();
    const service = new StoryService(repository, agent, {listByProject: async () => [fact]}, new MutableProjectAssets(), async () => undefined);
    const storyboard = await service.composeStoryboard(projectId);
    const regenerating = service.regenerateScene(projectId, storyboard.id, storyboard.scenes[0].id, storyboard.revision);
    const edited = await service.editScene(projectId, storyboard.id, storyboard.scenes[0].id, {title: 'Intervening edit'}, storyboard.revision);
    release();
    await expect(regenerating).rejects.toThrow('STORYBOARD_CONFLICT');
    expect((await service.getStoryboard(projectId))?.scenes[0].title).toBe('Intervening edit');
    expect(edited.revision).toBe(storyboard.revision + 1);
  });

  it('rejects stale scene saves and reorders without overwriting newer work', async () => {
    const {service} = createService([approved()]);
    const storyboard = await service.composeStoryboard(projectId);
    const extra = await service.addScene(projectId, storyboard.id, {
      sceneType: 'dedication', title: 'End', narrationText: '', captionText: '', durationSeconds: 5,
      assetIds: [], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'fade_to_black'
    }, storyboard.revision);
    await expect(service.editScene(projectId, storyboard.id, extra.scene.id, {title: 'Stale'}, storyboard.revision)).rejects.toThrow('STORYBOARD_CONFLICT');
    await expect(service.reorderScenes(projectId, storyboard.id, [extra.scene.id, storyboard.scenes[0].id], storyboard.revision)).rejects.toThrow('STORYBOARD_CONFLICT');
  });

  it('accepts a ready project photo without requiring evidence linkage', async () => {
    const unlinkedReadyPhoto = crypto.randomUUID();
    const assets = new MutableProjectAssets(new Set([assetId, unlinkedReadyPhoto]));
    const {service} = createService([approved()], async () => undefined, assets);
    const storyboard = await service.composeStoryboard(projectId);
    const added = await service.addScene(projectId, storyboard.id, {
      sceneType: 'media', title: 'Visual context', narrationText: '', captionText: '', durationSeconds: 5,
      assetIds: [unlinkedReadyPhoto], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'crossfade'
    }, storyboard.revision);
    expect(added.scene.assetIds).toEqual([unlinkedReadyPhoto]);
  });

  it.each([
    ['non-ready same-project', crypto.randomUUID()],
    ['cross-project', crypto.randomUUID()]
  ])('rejects a %s scene asset with INVALID_SCENE_ASSET', async (_label, invalidAssetId) => {
    const {service} = createService([approved()]);
    const storyboard = await service.composeStoryboard(projectId);
    await expect(service.addScene(projectId, storyboard.id, {
      sceneType: 'media', title: 'Invalid', narrationText: '', captionText: '', durationSeconds: 5,
      assetIds: [invalidAssetId], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'crossfade'
    }, storyboard.revision)).rejects.toThrow('INVALID_SCENE_ASSET');
  });

  it('rejects save, reorder, and regeneration when any storyboard asset stops being ready', async () => {
    const secondAssetId = crypto.randomUUID();
    const assets = new MutableProjectAssets(new Set([assetId, secondAssetId]));
    const {service} = createService([approved()], async () => undefined, assets);
    const storyboard = await service.composeStoryboard(projectId);
    const added = await service.addScene(projectId, storyboard.id, {
      sceneType: 'media', title: 'Second scene', narrationText: '', captionText: '', durationSeconds: 5,
      assetIds: [secondAssetId], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'crossfade'
    }, storyboard.revision);
    assets.readyIds.delete(assetId);
    await expect(service.editScene(projectId, storyboard.id, added.scene.id, {title: 'Later save'}, added.storyboard.revision)).rejects.toThrow('INVALID_SCENE_ASSET');
    await expect(service.reorderScenes(projectId, storyboard.id, [added.scene.id, storyboard.scenes[0].id], added.storyboard.revision)).rejects.toThrow('INVALID_SCENE_ASSET');
    await expect(service.regenerateScene(projectId, storyboard.id, added.scene.id, added.storyboard.revision)).rejects.toThrow('INVALID_SCENE_ASSET');
    await expect(service.composeStoryboard(projectId)).rejects.toThrow('INVALID_SCENE_ASSET');
  });
});
