import {createHash} from 'node:crypto';
import {z} from 'zod';

const objectKey = z.string().min(1).refine((value) => !value.includes('://'), 'PRIVATE_OBJECT_KEY_REQUIRED');
const sceneType = z.enum(['title', 'media', 'original_audio', 'dedication', 'credits']);
const motionPreset = z.enum(['hold', 'slow_zoom_in', 'slow_pan_left', 'slow_pan_right']);
const transitionPreset = z.enum(['crossfade', 'fade_to_black']);

const filmSourceSchema = z.object({
  projectId: z.string().uuid(),
  storyboardId: z.string().uuid(),
  storyboardRevision: z.number().int().nonnegative(),
  auditId: z.string().uuid(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  narrationHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1),
  subjectName: z.string().min(1),
  dedication: z.string(),
  disclosure: z.string().min(1),
  auditPassed: z.boolean(),
  textApproved: z.boolean(),
  audioApproved: z.boolean(),
  creatorNarrationObjectKey: objectKey.nullable(),
  scenes: z.array(z.object({
    id: z.string().uuid(),
    sceneType,
    title: z.string(),
    narrationText: z.string(),
    captionText: z.string(),
    durationSeconds: z.number().positive().max(240),
    imageObjectKeys: z.array(objectKey),
    narrationObjectKey: objectKey.nullable(),
    authenticClip: z.object({
      objectKey,
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive()
    }).strict().nullable(),
    motionPreset,
    transitionPreset
  }).strict()).min(3)
}).strict();

export type FilmSource = z.infer<typeof filmSourceSchema>;

export type RenderScene = FilmSource['scenes'][number] & {
  fromFrame: number;
  durationFrames: number;
};

export type RenderManifest = Omit<FilmSource, 'auditPassed'|'textApproved'|'audioApproved'|'scenes'> & {
  version: 1;
  width: 1920;
  height: 1080;
  fps: 30;
  totalFrames: number;
  scenes: RenderScene[];
  manifestHash: string;
};

export type ProjectedScene = Omit<RenderScene, 'imageObjectKeys'|'narrationObjectKey'|'authenticClip'> & {
  imageUrls: string[];
  narrationUrl: string|null;
  authenticClip: {url: string; startMs: number; endMs: number}|null;
};

export type MemoryFilmProps = Omit<RenderManifest, 'scenes'|'creatorNarrationObjectKey'> & {
  creatorNarrationUrl: string|null;
  scenes: ProjectedScene[];
};

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const buildRenderManifest = (input: FilmSource): RenderManifest => {
  const source = filmSourceSchema.parse(input);
  if (!source.auditPassed || !source.textApproved || !source.audioApproved) {
    throw new Error('FILM_APPROVAL_REQUIRED');
  }
  const totalSeconds = source.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (totalSeconds < 120 || totalSeconds > 240) throw new Error('FILM_DURATION_OUT_OF_RANGE');

  let fromFrame = 0;
  const scenes = source.scenes.map((scene) => {
    const durationFrames = Math.max(1, Math.round(scene.durationSeconds * 30));
    const rendered = {...scene, fromFrame, durationFrames};
    fromFrame += durationFrames;
    return rendered;
  });
  const unsigned = {
    version: 1 as const,
    width: 1920 as const,
    height: 1080 as const,
    fps: 30 as const,
    projectId: source.projectId,
    storyboardId: source.storyboardId,
    storyboardRevision: source.storyboardRevision,
    auditId: source.auditId,
    evidenceHash: source.evidenceHash,
    narrationHash: source.narrationHash,
    title: source.title,
    subjectName: source.subjectName,
    dedication: source.dedication,
    disclosure: source.disclosure,
    creatorNarrationObjectKey: source.creatorNarrationObjectKey,
    totalFrames: fromFrame,
    scenes
  };
  return {...unsigned, manifestHash: hash(unsigned)};
};

export const createRenderProjection = async (
  manifest: RenderManifest,
  resolve: (objectKey: string) => Promise<string>
): Promise<MemoryFilmProps> => {
  const urls = new Map<string, string>();
  const resolveOnce = async (key: string) => {
    const existing = urls.get(key);
    if (existing) return existing;
    const url = await resolve(key);
    urls.set(key, url);
    return url;
  };
  const scenes: ProjectedScene[] = [];
  for (const scene of manifest.scenes) {
    scenes.push({
      id: scene.id,
      sceneType: scene.sceneType,
      title: scene.title,
      narrationText: scene.narrationText,
      captionText: scene.captionText,
      durationSeconds: scene.durationSeconds,
      motionPreset: scene.motionPreset,
      transitionPreset: scene.transitionPreset,
      fromFrame: scene.fromFrame,
      durationFrames: scene.durationFrames,
      imageUrls: await Promise.all(scene.imageObjectKeys.map(resolveOnce)),
      narrationUrl: scene.narrationObjectKey ? await resolveOnce(scene.narrationObjectKey) : null,
      authenticClip: scene.authenticClip ? {
        url: await resolveOnce(scene.authenticClip.objectKey),
        startMs: scene.authenticClip.startMs,
        endMs: scene.authenticClip.endMs
      } : null
    });
  }
  const {scenes: _scenes, creatorNarrationObjectKey, ...rest} = manifest;
  return {
    ...rest,
    creatorNarrationUrl: creatorNarrationObjectKey ? await resolveOnce(creatorNarrationObjectKey) : null,
    scenes
  };
};
