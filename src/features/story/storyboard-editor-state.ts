import type {EvidenceItem} from '../evidence/schemas';
import type {FilmScene, FilmSceneInput, Storyboard} from './story-service';

export const sceneEditorFields = [
  'sceneType', 'title', 'narrationText', 'captionText', 'durationSeconds',
  'assetIds', 'evidenceItemIds', 'motionPreset', 'transitionPreset'
] as const satisfies readonly (keyof FilmSceneInput)[];

export const serializeSceneEdit = (scene: FilmScene): FilmSceneInput => ({
  sceneType: scene.sceneType,
  title: scene.title,
  narrationText: scene.narrationText,
  captionText: scene.captionText,
  durationSeconds: scene.durationSeconds,
  assetIds: [...scene.assetIds],
  evidenceItemIds: [...scene.evidenceItemIds],
  motionPreset: scene.motionPreset,
  transitionPreset: scene.transitionPreset
});

export const mergeStoryboardResponse = (
  current: Storyboard,
  incoming: Storyboard,
  options: {dirtySceneIds: ReadonlySet<string>; preserveLocalOrder?: boolean}
): Storyboard => {
  const localById = new Map(current.scenes.map((scene) => [scene.id, scene]));
  const incomingById = new Map(incoming.scenes.map((scene) => [scene.id, scene]));
  const ordered = options.preserveLocalOrder
    ? [
        ...current.scenes.map((scene) => incomingById.get(scene.id)).filter((scene): scene is FilmScene => Boolean(scene)),
        ...incoming.scenes.filter((scene) => !localById.has(scene.id))
      ]
    : incoming.scenes;
  return {
    ...incoming,
    scenes: ordered.map((scene, sequenceOrder) => {
      const local = localById.get(scene.id);
      return options.dirtySceneIds.has(scene.id) && local ? {...local, sequenceOrder} : {...scene, sequenceOrder};
    })
  };
};

export const shouldClearRequestDirty = (capturedGeneration: number, currentGeneration: number) => capturedGeneration === currentGeneration;

type ConflictFetcher = (url: string) => Promise<{ok: boolean; json(): Promise<unknown>}>;
export const rebaseStoryboardConflict = async (input: {
  projectId: string; getCurrent(): Storyboard; dirtySceneIds: ReadonlySet<string>;
  preserveLocalOrder: boolean; fetcher: ConflictFetcher;
}) => {
  const response = await input.fetcher(`/api/projects/${input.projectId}/storyboard`);
  if (!response.ok) throw new Error('STORYBOARD_RECOVERY_FAILED');
  return mergeStoryboardResponse(input.getCurrent(), await response.json() as Storyboard, {
    dirtySceneIds: input.dirtySceneIds,
    preserveLocalOrder: input.preserveLocalOrder
  });
};

export const displayEvidenceClaim = (item: EvidenceItem) => item.verificationStatus === 'corrected'
  ? {current: item.correction!, originallyProposed: item.originalClaim}
  : {current: item.claim, originallyProposed: null};

export type StoryboardAssetOptionSource = {
  id: string; projectId: string; kind: 'image' | 'text' | 'source_audio' | 'creator_narration';
  processingStatus: string; caption: string | null; sequenceOrder: number;
};

export const buildStoryboardOptions = (
  projectId: string,
  assets: StoryboardAssetOptionSource[],
  evidence: EvidenceItem[]
) => ({
  assets: assets
    .filter((asset) => asset.projectId === projectId && asset.processingStatus === 'ready')
    .sort((left, right) => left.sequenceOrder - right.sequenceOrder)
    .map((asset) => ({
      id: asset.id,
      label: asset.caption?.trim() || (asset.kind === 'image' ? `Photograph ${asset.sequenceOrder + 1}` : asset.kind === 'text' ? 'Supporting text' : 'Family recording')
    })),
  evidence: evidence
    .filter((item) => item.projectId === projectId && item.kind !== 'model_hypothesis' && (item.verificationStatus === 'confirmed' || item.verificationStatus === 'corrected'))
    .map((item) => ({id: item.id, label: displayEvidenceClaim(item).current}))
});
