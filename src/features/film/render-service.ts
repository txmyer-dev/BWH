import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {and, asc, eq, isNotNull} from 'drizzle-orm';
import {renderMedia as renderWithRemotion, selectComposition as selectRemotionComposition} from '@remotion/renderer';

import type {Database} from '../../server/db/client';
import {assets, filmScenes, narrationTracks, projects, storyboards, subjects} from '../../server/db/schema';
import type {MediaStorage} from '../media/storage';
import type {NarrationRepository} from '../narration/narration-repository';
import {buildRenderManifest, createRenderProjection, type FilmSource, type MemoryFilmProps, type RenderManifest} from './manifest';

export type CompletedFilm = {manifestHash: string; objectKey: string};

export interface FilmRepository {
  loadSource(projectId: string): Promise<FilmSource>;
  findCompleted(projectId: string, manifestHash: string): Promise<CompletedFilm|undefined>;
  saveCompleted(projectId: string, manifest: RenderManifest, objectKey: string): Promise<void>;
}

export interface FilmRenderer {
  render(input: {manifest: RenderManifest; projection: MemoryFilmProps}): Promise<Uint8Array>;
}

type AssembleInput = {
  projectId: string;
  storyboardId: string;
  storyboardRevision: number;
  auditId: string;
  evidenceHash: string;
  narrationHash: string;
  title: string;
  subjectName: string;
  dedication: string;
  audioApproved: boolean;
  selection: {kind: 'generated'; provider: 'deepgram'|'azure'; model: string; voice: string}|{kind: 'creator'; objectKey: string};
  scenes: Array<Omit<FilmSource['scenes'][number], 'imageObjectKeys'|'narrationObjectKey'|'authenticClip'> & {
    assetIds: string[];
    authenticClip: {assetId: string; startMs: number; endMs: number}|null;
  }>;
  assets: Array<{id: string; assetKind: string; processingStatus: string; originalObjectKey: string}>;
  tracks: Array<{sceneId: string; provider: string; model: string; voice: string; auditId: string; narrationHash: string; objectKey: string}>;
};

export const assembleFilmSource = (input: AssembleInput): FilmSource => {
  const byAsset = new Map(input.assets.map((asset) => [asset.id, asset]));
  const scenes = input.scenes.map((scene) => {
    const imageObjectKeys = scene.assetIds.map((id) => byAsset.get(id)).filter((asset) => asset?.assetKind === 'image' && asset.processingStatus === 'ready').map((asset) => asset!.originalObjectKey);
    let narrationObjectKey: string|null = null;
    if (input.selection.kind === 'generated' && scene.narrationText.trim()) {
      const selection = input.selection;
      const track = input.tracks.find((candidate) =>
        candidate.sceneId === scene.id && candidate.provider === selection.provider &&
        candidate.model === selection.model && candidate.voice === selection.voice &&
        candidate.auditId === input.auditId && candidate.narrationHash === input.narrationHash
      );
      if (!track) throw new Error('FILM_NARRATION_TRACK_REQUIRED');
      narrationObjectKey = track.objectKey;
    }
    const clipAsset = scene.authenticClip ? byAsset.get(scene.authenticClip.assetId) : undefined;
    if (scene.authenticClip && (!clipAsset || clipAsset.assetKind !== 'source_audio' || clipAsset.processingStatus !== 'ready')) {
      throw new Error('FILM_AUTHENTIC_CLIP_REQUIRED');
    }
    return {
      id: scene.id,
      sceneType: scene.sceneType,
      title: scene.title,
      narrationText: scene.narrationText,
      captionText: scene.captionText,
      durationSeconds: scene.durationSeconds,
      imageObjectKeys,
      narrationObjectKey,
      authenticClip: scene.authenticClip && clipAsset ? {objectKey: clipAsset.originalObjectKey, startMs: scene.authenticClip.startMs, endMs: scene.authenticClip.endMs} : null,
      motionPreset: scene.motionPreset,
      transitionPreset: scene.transitionPreset
    };
  });
  return {
    projectId: input.projectId,
    storyboardId: input.storyboardId,
    storyboardRevision: input.storyboardRevision,
    auditId: input.auditId,
    evidenceHash: input.evidenceHash,
    narrationHash: input.narrationHash,
    title: input.title,
    subjectName: input.subjectName,
    dedication: input.dedication,
    disclosure: input.selection.kind === 'creator' ? 'Narration provided by the creator.' : `Narration created with a generated voice from ${input.selection.provider === 'azure' ? 'Microsoft Azure' : 'Deepgram'}.`,
    auditPassed: true,
    textApproved: true,
    audioApproved: input.audioApproved,
    creatorNarrationObjectKey: input.selection.kind === 'creator' ? input.selection.objectKey : null,
    scenes
  };
};

export class PostgresFilmRepository implements FilmRepository {
  constructor(private readonly database: Database, private readonly narration: NarrationRepository) {}

  async loadSource(projectId: string) {
    const approved = await this.narration.loadApprovedStoryboard(projectId);
    const selection = await this.narration.getSelection(projectId);
    if (!selection) throw new Error('NARRATION_SELECTION_REQUIRED');
    const [project, subject, board, sceneRows, assetRows, trackRows] = await Promise.all([
      this.database.query.projects.findFirst({where: (table, {eq: same}) => same(table.id, projectId)}),
      this.database.query.subjects.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)}),
      this.database.query.storyboards.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)}),
      this.database.select().from(filmScenes).innerJoin(storyboards, eq(filmScenes.storyboardId, storyboards.id)).where(eq(storyboards.projectId, projectId)).orderBy(asc(filmScenes.sequenceOrder)),
      this.database.select().from(assets).where(eq(assets.projectId, projectId)),
      this.database.select().from(narrationTracks).where(eq(narrationTracks.projectId, projectId))
    ]);
    if (!project || !subject || !board || board.id !== approved.storyboardId || !board.narrationApprovalEvidenceHash || !board.audioApprovedAt) throw new Error('FILM_APPROVAL_REQUIRED');
    let resolvedSelection: AssembleInput['selection'];
    if (selection.kind === 'creator') {
      const creator = await this.narration.assertCreatorAudioApproved(projectId, selection.assetId);
      if (creator.transcriptId !== selection.transcriptId || creator.transcriptHash !== selection.transcriptHash || creator.auditId !== selection.auditId) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
      const creatorAsset = assetRows.find((asset) => asset.id === selection.assetId && asset.assetKind === 'creator_narration' && asset.processingStatus === 'ready');
      if (!creatorAsset) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
      resolvedSelection = {kind: 'creator', objectKey: creatorAsset.originalObjectKey};
    } else {
      if (selection.auditId !== approved.auditId || selection.narrationHash !== approved.narrationHash) throw new Error('NARRATION_SELECTION_REQUIRED');
      resolvedSelection = {kind: 'generated', provider: selection.provider, model: selection.model, voice: selection.voice};
    }
    return assembleFilmSource({
      projectId,
      storyboardId: board.id,
      storyboardRevision: board.revision,
      auditId: approved.auditId,
      evidenceHash: board.narrationApprovalEvidenceHash,
      narrationHash: approved.narrationHash,
      title: board.title,
      subjectName: subject.name,
      dedication: board.dedication ?? '',
      audioApproved: Boolean(board.audioApprovedAt),
      selection: resolvedSelection,
      scenes: sceneRows.map(({film_scenes: scene}) => ({
        id: scene.id,
        sceneType: scene.sceneType as FilmSource['scenes'][number]['sceneType'],
        title: scene.title ?? '',
        narrationText: scene.narrationText ?? '',
        captionText: scene.captionText ?? '',
        durationSeconds: scene.durationSeconds,
        assetIds: scene.assetIds as string[],
        authenticClip: scene.authenticClip as {assetId: string; startMs: number; endMs: number}|null,
        motionPreset: scene.motionPreset as FilmSource['scenes'][number]['motionPreset'],
        transitionPreset: scene.transitionPreset as FilmSource['scenes'][number]['transitionPreset']
      })),
      assets: assetRows.map((asset) => ({id: asset.id, assetKind: asset.assetKind, processingStatus: asset.processingStatus, originalObjectKey: asset.originalObjectKey})),
      tracks: trackRows.map((track) => ({sceneId: track.sceneId, provider: track.provider, model: track.model, voice: track.voice, auditId: track.auditId, narrationHash: track.narrationHash, objectKey: track.objectKey}))
    });
  }

  async findCompleted(projectId: string, manifestHash: string) {
    const [project, board] = await Promise.all([
      this.database.query.projects.findFirst({where: (table, {eq: same}) => same(table.id, projectId)}),
      this.database.query.storyboards.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)})
    ]);
    const saved = board?.renderManifest as RenderManifest|null;
    if (!project?.renderedFilmObjectKey || saved?.manifestHash !== manifestHash) return undefined;
    return {manifestHash, objectKey: project.renderedFilmObjectKey};
  }

  async saveCompleted(projectId: string, manifest: RenderManifest, objectKey: string) {
    await this.database.transaction(async (transaction) => {
      const [board] = await transaction.update(storyboards).set({renderManifest: manifest, updatedAt: new Date()}).where(and(
        eq(storyboards.id, manifest.storyboardId),
        eq(storyboards.projectId, projectId),
        eq(storyboards.revision, manifest.storyboardRevision),
        eq(storyboards.currentAuditId, manifest.auditId),
        eq(storyboards.narrationApprovalHash, manifest.narrationHash),
        eq(storyboards.narrationApprovalEvidenceHash, manifest.evidenceHash),
        isNotNull(storyboards.audioApprovedAt)
      )).returning({id: storyboards.id});
      if (!board) throw new Error('FILM_APPROVAL_CHANGED_DURING_RENDER');
      await transaction.update(projects).set({renderedFilmObjectKey: objectKey, renderedAt: new Date(), updatedAt: new Date()}).where(eq(projects.id, projectId));
    });
  }
}

type RendererDependencies = {
  bundlePath: string;
  browserExecutable?: string;
  concurrency?: number;
  selectComposition?: (input: {serveUrl: string; id: string; inputProps: MemoryFilmProps; browserExecutable?: string}) => Promise<unknown>;
  renderMedia?: (input: {composition: unknown; serveUrl: string; codec: 'h264'; outputLocation: string; inputProps: MemoryFilmProps; browserExecutable?: string; concurrency?: number}) => Promise<unknown>;
};

export class RemotionFilmRenderer implements FilmRenderer {
  constructor(private readonly dependencies: RendererDependencies) {}

  async render({projection}: {manifest: RenderManifest; projection: MemoryFilmProps}) {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-studio-film-'));
    const outputLocation = join(directory, 'memory-film.mp4');
    try {
      const select = this.dependencies.selectComposition ?? ((input) => selectRemotionComposition(input as Parameters<typeof selectRemotionComposition>[0]));
      const render = this.dependencies.renderMedia ?? ((input) => renderWithRemotion(input as Parameters<typeof renderWithRemotion>[0]));
      const composition = await select({serveUrl: this.dependencies.bundlePath, id: 'MemoryFilm', inputProps: projection, browserExecutable: this.dependencies.browserExecutable});
      await render({
        composition,
        serveUrl: this.dependencies.bundlePath,
        codec: 'h264',
        outputLocation,
        inputProps: projection,
        browserExecutable: this.dependencies.browserExecutable,
        concurrency: this.dependencies.concurrency
      });
      return await readFile(outputLocation);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
}

export class FilmRenderService {
  constructor(
    private readonly repository: FilmRepository,
    private readonly storage: MediaStorage,
    private readonly renderer: FilmRenderer,
    private readonly assertOwner: (projectId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async render(projectId: string) {
    await this.assertOwner(projectId);
    const manifest = buildRenderManifest(await this.repository.loadSource(projectId));
    const completed = await this.repository.findCompleted(projectId, manifest.manifestHash);
    if (completed) return {...completed, reused: true as const};

    const projection = await createRenderProjection(manifest, (objectKey) =>
      this.storage.createDownloadUrl({objectKey, expiresInMs: 3_600_000})
    );
    const bytes = await this.renderer.render({manifest, projection});
    const objectKey = `projects/${projectId}/renders/${manifest.manifestHash}.mp4`;
    await this.storage.writePrivateObject(objectKey, bytes, 'video/mp4');
    await this.repository.saveCompleted(projectId, manifest, objectKey);
    return {manifestHash: manifest.manifestHash, objectKey, reused: false as const};
  }

  async getDownload(projectId: string) {
    await this.assertOwner(projectId);
    const manifest = buildRenderManifest(await this.repository.loadSource(projectId));
    const completed = await this.repository.findCompleted(projectId, manifest.manifestHash);
    if (!completed) throw new Error('FILM_NOT_RENDERED');
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 900_000);
    const url = await this.storage.createDownloadUrl({objectKey: completed.objectKey, expiresInMs: 900_000});
    return {url, createdAt, expiresAt};
  }
}

export class InMemoryFilmRepository implements FilmRepository {
  private source?: FilmSource;
  private completed?: CompletedFilm;
  loadCalls = 0;

  seed(source: FilmSource) {
    this.source = structuredClone(source);
  }

  async loadSource(projectId: string) {
    this.loadCalls += 1;
    if (!this.source || this.source.projectId !== projectId) throw new Error('FILM_SOURCE_NOT_FOUND');
    return structuredClone(this.source);
  }

  async findCompleted(projectId: string, manifestHash: string) {
    if (this.source?.projectId !== projectId || this.completed?.manifestHash !== manifestHash) return undefined;
    return {...this.completed};
  }

  async saveCompleted(projectId: string, manifest: RenderManifest, objectKey: string) {
    if (this.source?.projectId !== projectId) throw new Error('FILM_SOURCE_NOT_FOUND');
    this.completed = {manifestHash: manifest.manifestHash, objectKey};
  }
}
