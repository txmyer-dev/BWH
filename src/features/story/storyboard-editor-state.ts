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
  dirtySceneIds: ReadonlySet<string>
): Storyboard => {
  const localById = new Map(current.scenes.map((scene) => [scene.id, scene]));
  return {
    ...incoming,
    scenes: incoming.scenes.map((scene, sequenceOrder) => {
      const local = localById.get(scene.id);
      return dirtySceneIds.has(scene.id) && local ? {...local, sequenceOrder} : {...scene, sequenceOrder};
    })
  };
};

export const displayEvidenceClaim = (item: EvidenceItem) => item.verificationStatus === 'corrected'
  ? {current: item.correction!, originallyProposed: item.originalClaim}
  : {current: item.claim, originallyProposed: null};
