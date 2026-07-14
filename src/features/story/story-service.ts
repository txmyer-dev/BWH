import {randomUUID} from 'node:crypto';
import {and, asc, eq, sql} from 'drizzle-orm';
import {z} from 'zod';

import type {Database} from '../../server/db/client';
import {evidenceItems, filmScenes, interviewAnswers, interviewQuestions, storyboards, voiceProfiles} from '../../server/db/schema';
import type {EvidenceItem} from '../evidence/schemas';

export const motionPresetSchema = z.enum(['hold', 'slow_zoom_in', 'slow_pan_left', 'slow_pan_right']);
export const transitionPresetSchema = z.enum(['crossfade', 'fade_to_black']);
export const sceneTypeSchema = z.enum(['title', 'media', 'original_audio', 'dedication', 'credits']);

export const filmSceneInputSchema = z.object({
  sceneType: sceneTypeSchema,
  title: z.string(),
  narrationText: z.string(),
  captionText: z.string(),
  durationSeconds: z.number().positive().max(240),
  assetIds: z.array(z.string().uuid()),
  evidenceItemIds: z.array(z.string().uuid()),
  motionPreset: motionPresetSchema,
  transitionPreset: transitionPresetSchema
}).strict();

export type FilmSceneInput = z.infer<typeof filmSceneInputSchema>;
export type FilmScene = FilmSceneInput & {id: string; sequenceOrder: number};
export type VoiceTrait = {trait: string; description: string; evidenceItemIds: string[]};
export type VoiceProfile = {traits: VoiceTrait[]; coverage: 'grounded' | 'restrained'};
export type Question = {id: string; projectId: string; question: string; reason: string; rank: number; leading: false};
export type Storyboard = {
  id: string; projectId: string; title: string; theme: string;
  targetDurationSeconds: number; voiceProfile: VoiceProfile; scenes: FilmScene[];
};
type StoryboardCreate = Omit<Storyboard, 'id' | 'projectId' | 'scenes'> & {scenes: FilmSceneInput[]};

export type QuestionDraft = {question: string; reason: string; rank: number; leading: boolean};
export type AgentScene = Omit<FilmSceneInput, 'narrationText' | 'evidenceItemIds'> & {
  narrationSentences: {text: string; evidenceItemIds: string[]}[];
};
export type StoryboardDraft = {title: string; theme: string; voiceProfile: VoiceProfile; scenes: AgentScene[]};

export const questionDraftsSchema = z.array(z.object({
  question: z.string().min(1), reason: z.string().min(1), rank: z.number().int().positive(), leading: z.boolean()
}).strict()).max(10);
export const guidedQuestionsOutputSchema = z.object({questions: questionDraftsSchema}).strict();
const voiceTraitSchema = z.object({
  trait: z.string().min(1), description: z.string().min(1), evidenceItemIds: z.array(z.string().uuid()).min(1)
}).strict();
export const voiceProfileSchema = z.object({
  traits: z.array(voiceTraitSchema), coverage: z.enum(['grounded', 'restrained'])
}).strict();
export const agentSceneSchema = z.object({
  sceneType: sceneTypeSchema, title: z.string(),
  narrationSentences: z.array(z.object({text: z.string().min(1), evidenceItemIds: z.array(z.string().uuid()).min(1)}).strict()),
  captionText: z.string(), durationSeconds: z.number().positive().max(240),
  assetIds: z.array(z.string().uuid()), motionPreset: motionPresetSchema, transitionPreset: transitionPresetSchema
}).strict();
export const storyboardDraftSchema = z.object({
  title: z.string().min(1), theme: z.string().min(1), voiceProfile: voiceProfileSchema,
  scenes: z.array(agentSceneSchema).min(1).max(12)
}).strict();

export interface StoryGuideAgent {
  generateQuestions(input: {projectId: string; evidence: EvidenceItem[]}): Promise<QuestionDraft[]>;
  composeStoryboard(input: {projectId: string; approvedEvidence: EvidenceItem[]}): Promise<StoryboardDraft>;
  regenerateScene(input: {projectId: string; scene: AgentScene; approvedEvidence: EvidenceItem[]}): Promise<AgentScene>;
}

export interface StoryRepository {
  listQuestions(projectId: string): Promise<Question[]>;
  replaceQuestions(projectId: string, drafts: Omit<Question, 'id' | 'projectId'>[]): Promise<Question[]>;
  saveAnswer(projectId: string, questionId: string, answer: string): Promise<void>;
  findStoryboard(projectId: string): Promise<Storyboard | undefined>;
  createStoryboard(projectId: string, draft: StoryboardCreate): Promise<Storyboard>;
  addScene(projectId: string, storyboardId: string, scene: FilmSceneInput): Promise<FilmScene>;
  editScene(projectId: string, storyboardId: string, sceneId: string, change: Partial<FilmSceneInput>): Promise<Storyboard>;
  reorderScenes(projectId: string, storyboardId: string, orderedSceneIds: string[]): Promise<Storyboard>;
  replaceScene(projectId: string, storyboardId: string, sceneId: string, scene: FilmSceneInput): Promise<Storyboard>;
}

type EvidenceReader = {listByProject(projectId: string): Promise<EvidenceItem[]>};
const isApproved = (item: EvidenceItem) => item.kind !== 'model_hypothesis' && (item.verificationStatus === 'confirmed' || item.verificationStatus === 'corrected');

export class StoryService {
  constructor(
    private readonly repository: StoryRepository,
    private readonly agent: StoryGuideAgent,
    private readonly evidence: EvidenceReader,
    private readonly assertCreator: (projectId: string) => Promise<void>
  ) {}

  async generateQuestions(projectId: string) {
    await this.assertCreator(projectId);
    const existing = await this.repository.listQuestions(projectId);
    if (existing.length) return existing;
    const evidence = await this.evidence.listByProject(projectId);
    if (evidence.some((item) => item.projectId !== projectId)) throw new Error('CROSS_PROJECT_EVIDENCE');
    const drafts = (await this.agent.generateQuestions({projectId, evidence}))
      .filter((question) => !question.leading)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 5)
      .map((question) => ({...question, leading: false as const}));
    return this.repository.replaceQuestions(projectId, drafts);
  }

  async composeStoryboard(projectId: string) {
    await this.assertCreator(projectId);
    const existing = await this.repository.findStoryboard(projectId);
    if (existing) return existing;
    const approvedEvidence = await this.approvedEvidence(projectId);
    if (!approvedEvidence.length) throw new Error('APPROVED_EVIDENCE_REQUIRED');
    const draft = await this.agent.composeStoryboard({projectId, approvedEvidence});
    const voiceProfile = this.validateVoiceProfile(draft.voiceProfile, approvedEvidence);
    const scenes = draft.scenes.map((scene) => this.flattenAgentScene(scene, approvedEvidence));
    const duration = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    if (duration < 120 || duration > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
    return this.repository.createStoryboard(projectId, {
      title: draft.title, theme: draft.theme, targetDurationSeconds: duration, voiceProfile, scenes
    });
  }

  async saveAnswer(projectId: string, questionId: string, answer: string) {
    await this.assertCreator(projectId);
    const text = answer.trim();
    if (!text) throw new Error('ANSWER_REQUIRED');
    await this.repository.saveAnswer(projectId, questionId, text);
  }

  async getStoryboard(projectId: string) {
    await this.assertCreator(projectId);
    return this.repository.findStoryboard(projectId);
  }

  async addScene(projectId: string, storyboardId: string, input: FilmSceneInput) {
    await this.assertCreator(projectId);
    const scene = filmSceneInputSchema.parse(input);
    const board = await this.repository.findStoryboard(projectId);
    if (!board || board.id !== storyboardId) throw new Error('STORYBOARD_NOT_FOUND');
    await this.assertSceneReferences(projectId, scene);
    this.assertDuration([...board.scenes, {...scene, id: randomUUID(), sequenceOrder: board.scenes.length}]);
    return this.repository.addScene(projectId, storyboardId, scene);
  }

  async editScene(projectId: string, storyboardId: string, sceneId: string, change: Partial<FilmSceneInput>) {
    await this.assertCreator(projectId);
    const board = await this.repository.findStoryboard(projectId);
    if (!board || board.id !== storyboardId) throw new Error('STORYBOARD_NOT_FOUND');
    const current = board.scenes.find((scene) => scene.id === sceneId);
    if (!current) throw new Error('SCENE_NOT_FOUND');
    const currentInput: FilmSceneInput = {
      sceneType: current.sceneType, title: current.title, narrationText: current.narrationText,
      captionText: current.captionText, durationSeconds: current.durationSeconds,
      assetIds: current.assetIds, evidenceItemIds: current.evidenceItemIds,
      motionPreset: current.motionPreset, transitionPreset: current.transitionPreset
    };
    const merged = filmSceneInputSchema.parse({...currentInput, ...change});
    await this.assertSceneReferences(projectId, merged);
    this.assertDuration(board.scenes.map((scene) => scene.id === sceneId ? {...merged, id: scene.id, sequenceOrder: scene.sequenceOrder} : scene));
    return this.repository.editScene(projectId, storyboardId, sceneId, change);
  }

  async reorderScenes(projectId: string, storyboardId: string, orderedSceneIds: string[]) {
    await this.assertCreator(projectId);
    return this.repository.reorderScenes(projectId, storyboardId, orderedSceneIds);
  }

  async regenerateScene(projectId: string, storyboardId: string, sceneId: string) {
    await this.assertCreator(projectId);
    const storyboard = await this.repository.findStoryboard(projectId);
    if (!storyboard || storyboard.id !== storyboardId) throw new Error('STORYBOARD_NOT_FOUND');
    const scene = storyboard.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) throw new Error('SCENE_NOT_FOUND');
    const approvedEvidence = await this.approvedEvidence(projectId);
    const regenerated = await this.agent.regenerateScene({
      projectId,
      scene: {
        sceneType: scene.sceneType, title: scene.title, captionText: scene.captionText,
        durationSeconds: scene.durationSeconds, assetIds: scene.assetIds,
        motionPreset: scene.motionPreset, transitionPreset: scene.transitionPreset,
        narrationSentences: scene.narrationText ? [{text: scene.narrationText, evidenceItemIds: scene.evidenceItemIds}] : []
      },
      approvedEvidence
    });
    const next = this.flattenAgentScene(regenerated, approvedEvidence);
    await this.assertSceneReferences(projectId, next);
    this.assertDuration(storyboard.scenes.map((candidate) => candidate.id === sceneId ? {...next, id: candidate.id, sequenceOrder: candidate.sequenceOrder} : candidate));
    return this.repository.replaceScene(projectId, storyboardId, sceneId, next);
  }

  private async approvedEvidence(projectId: string) {
    const all = await this.evidence.listByProject(projectId);
    if (all.some((item) => item.projectId !== projectId)) throw new Error('CROSS_PROJECT_EVIDENCE');
    return all.filter(isApproved);
  }

  private validateVoiceProfile(profile: VoiceProfile, approved: EvidenceItem[]) {
    const ids = new Set(approved.map((item) => item.id));
    for (const trait of profile.traits) {
      if (!trait.evidenceItemIds.length || trait.evidenceItemIds.some((id) => !ids.has(id))) {
        throw new Error('UNAPPROVED_EVIDENCE_REFERENCE');
      }
    }
    return profile;
  }

  private flattenAgentScene(scene: AgentScene, approved: EvidenceItem[]): FilmSceneInput {
    const approvedIds = new Set(approved.map((item) => item.id));
    const allowedAssets = new Set(approved.flatMap((item) => item.sourceAssetIds));
    if (scene.assetIds.some((id) => !allowedAssets.has(id))) throw new Error('CROSS_PROJECT_ASSET');
    for (const sentence of scene.narrationSentences) {
      if (!sentence.text.trim() || !sentence.evidenceItemIds.length || sentence.evidenceItemIds.some((id) => !approvedIds.has(id))) {
        throw new Error('UNAPPROVED_EVIDENCE_REFERENCE');
      }
    }
    const {narrationSentences, ...sceneFields} = scene;
    return filmSceneInputSchema.parse({
      ...sceneFields,
      narrationText: scene.narrationSentences.map((sentence) => sentence.text.trim()).join(' '),
      evidenceItemIds: [...new Set(narrationSentences.flatMap((sentence) => sentence.evidenceItemIds))]
    });
  }

  private async assertSceneReferences(projectId: string, scene: FilmSceneInput) {
    if (scene.narrationText.trim() && !scene.evidenceItemIds.length) throw new Error('NARRATION_EVIDENCE_REQUIRED');
    const approved = await this.approvedEvidence(projectId);
    const allowed = new Set(approved.map((item) => item.id));
    if (scene.evidenceItemIds.some((id) => !allowed.has(id))) throw new Error('UNAPPROVED_EVIDENCE_REFERENCE');
    const assets = new Set(approved.flatMap((item) => item.sourceAssetIds));
    if (scene.assetIds.some((id) => !assets.has(id))) throw new Error('CROSS_PROJECT_ASSET');
  }

  private assertDuration(scenes: Pick<FilmScene, 'durationSeconds'>[]) {
    const duration = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    if (duration < 120 || duration > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
  }
}

const cloneStoryboard = (storyboard: Storyboard): Storyboard => ({
  ...storyboard,
  voiceProfile: {...storyboard.voiceProfile, traits: storyboard.voiceProfile.traits.map((trait) => ({...trait, evidenceItemIds: [...trait.evidenceItemIds]}))},
  scenes: storyboard.scenes.map((scene) => ({...scene, assetIds: [...scene.assetIds], evidenceItemIds: [...scene.evidenceItemIds]}))
});

export class InMemoryStoryRepository implements StoryRepository {
  private readonly questions = new Map<string, Question[]>();
  private readonly boards = new Map<string, Storyboard>();
  async listQuestions(projectId: string) { return (this.questions.get(projectId) ?? []).map((question) => ({...question})); }
  async replaceQuestions(projectId: string, drafts: Omit<Question, 'id' | 'projectId'>[]) {
    const existing = this.questions.get(projectId);
    if (existing?.length) return existing.map((question) => ({...question}));
    const questions = drafts.map((draft) => ({id: randomUUID(), projectId, ...draft}));
    this.questions.set(projectId, questions); return questions.map((question) => ({...question}));
  }
  async saveAnswer(projectId: string, questionId: string, answer: string) {
    if (!(this.questions.get(projectId) ?? []).some((question) => question.id === questionId)) throw new Error('QUESTION_NOT_FOUND');
    void answer;
  }
  async findStoryboard(projectId: string) { const found = this.boards.get(projectId); return found ? cloneStoryboard(found) : undefined; }
  async createStoryboard(projectId: string, draft: StoryboardCreate) {
    const existing = this.boards.get(projectId); if (existing) return cloneStoryboard(existing);
    const board: Storyboard = {...draft, id: randomUUID(), projectId, scenes: draft.scenes.map((scene, sequenceOrder) => ({...scene, id: randomUUID(), sequenceOrder}))};
    this.boards.set(projectId, board); return cloneStoryboard(board);
  }
  async addScene(projectId: string, storyboardId: string, scene: FilmSceneInput) {
    const board = this.requireBoard(projectId, storyboardId); const added = {...scene, id: randomUUID(), sequenceOrder: board.scenes.length};
    board.scenes.push(added); board.targetDurationSeconds += added.durationSeconds;
    return {...added, assetIds: [...added.assetIds], evidenceItemIds: [...added.evidenceItemIds]};
  }
  async editScene(projectId: string, storyboardId: string, sceneId: string, change: Partial<FilmSceneInput>) {
    const board = this.requireBoard(projectId, storyboardId); const index = board.scenes.findIndex((scene) => scene.id === sceneId);
    if (index < 0) throw new Error('SCENE_NOT_FOUND');
    board.scenes[index] = {...board.scenes[index], ...change};
    board.targetDurationSeconds = board.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    return cloneStoryboard(board);
  }
  async reorderScenes(projectId: string, storyboardId: string, orderedSceneIds: string[]) {
    const board = this.requireBoard(projectId, storyboardId);
    if (orderedSceneIds.length !== board.scenes.length || new Set(orderedSceneIds).size !== board.scenes.length) throw new Error('INVALID_SCENE_ORDER');
    const byId = new Map(board.scenes.map((scene) => [scene.id, scene]));
    if (orderedSceneIds.some((id) => !byId.has(id))) throw new Error('INVALID_SCENE_ORDER');
    board.scenes = orderedSceneIds.map((id, sequenceOrder) => ({...byId.get(id)!, sequenceOrder})); return cloneStoryboard(board);
  }
  async replaceScene(projectId: string, storyboardId: string, sceneId: string, scene: FilmSceneInput) {
    const board = this.requireBoard(projectId, storyboardId); const index = board.scenes.findIndex((candidate) => candidate.id === sceneId);
    if (index < 0) throw new Error('SCENE_NOT_FOUND');
    board.scenes[index] = {...scene, id: sceneId, sequenceOrder: board.scenes[index].sequenceOrder};
    board.targetDurationSeconds = board.scenes.reduce((total, candidate) => total + candidate.durationSeconds, 0);
    return cloneStoryboard(board);
  }
  private requireBoard(projectId: string, storyboardId: string) {
    const board = this.boards.get(projectId); if (!board || board.id !== storyboardId) throw new Error('STORYBOARD_NOT_FOUND'); return board;
  }
}

const mapScene = (row: typeof filmScenes.$inferSelect): FilmScene => ({
  id: row.id, sequenceOrder: row.sequenceOrder, sceneType: row.sceneType as FilmScene['sceneType'],
  title: row.title ?? '', narrationText: row.narrationText ?? '', captionText: row.captionText ?? '',
  durationSeconds: row.durationSeconds, assetIds: row.assetIds as string[], evidenceItemIds: row.evidenceItemIds as string[],
  motionPreset: row.motionPreset as FilmScene['motionPreset'], transitionPreset: row.transitionPreset as FilmScene['transitionPreset']
});

export class PostgresStoryRepository implements StoryRepository {
  constructor(private readonly database: Database) {}
  async listQuestions(projectId: string) {
    const rows = await this.database.query.interviewQuestions.findMany({where: (table, {eq: equals}) => equals(table.projectId, projectId), orderBy: (table) => asc(table.sequenceOrder)});
    return rows.map((row) => ({id: row.id, projectId: row.projectId, question: row.question, reason: row.reason, rank: row.sequenceOrder + 1, leading: false as const}));
  }
  async replaceQuestions(projectId: string, drafts: Omit<Question, 'id' | 'projectId'>[]) {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
      const existing = await transaction.select().from(interviewQuestions).where(eq(interviewQuestions.projectId, projectId));
      if (!existing.length && drafts.length) await transaction.insert(interviewQuestions).values(drafts.map((draft, sequenceOrder) => ({id: randomUUID(), projectId, question: draft.question, reason: draft.reason, sequenceOrder})));
    });
    return this.listQuestions(projectId);
  }
  async saveAnswer(projectId: string, questionId: string, answer: string) {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${questionId}))`);
      const [question] = await transaction.select().from(interviewQuestions).where(and(eq(interviewQuestions.id, questionId), eq(interviewQuestions.projectId, projectId)));
      if (!question) throw new Error('QUESTION_NOT_FOUND');
      const [existing] = await transaction.select().from(interviewAnswers).where(eq(interviewAnswers.questionId, questionId));
      if (existing) {
        await transaction.update(interviewAnswers).set({answer, updatedAt: new Date()}).where(eq(interviewAnswers.id, existing.id));
        await transaction.update(evidenceItems).set({claim: answer, sourceExcerpt: answer, updatedAt: new Date()}).where(eq(evidenceItems.creatorAnswerId, existing.id));
        return;
      }
      const answerId = randomUUID();
      await transaction.insert(interviewAnswers).values({id: answerId, questionId, answer});
      await transaction.insert(evidenceItems).values({
        id: randomUUID(), projectId, creatorAnswerId: answerId, type: 'creator_memory',
        claim: answer, originalClaim: answer, sourceAssetIds: [], sourceExcerpt: answer,
        confidence: 1, verificationStatus: 'confirmed'
      });
    });
  }
  async findStoryboard(projectId: string) {
    const board = await this.database.query.storyboards.findFirst({where: (table, {eq: equals}) => equals(table.projectId, projectId)});
    if (!board) return undefined;
    const profile = await this.database.query.voiceProfiles.findFirst({where: (table, {eq: equals}) => equals(table.projectId, projectId)});
    const scenes = await this.database.query.filmScenes.findMany({where: (table, {eq: equals}) => equals(table.storyboardId, board.id), orderBy: (table) => asc(table.sequenceOrder)});
    return {id: board.id, projectId, title: board.title, theme: board.theme, targetDurationSeconds: board.targetDurationSeconds, voiceProfile: profile?.profile as VoiceProfile ?? {traits: [], coverage: 'restrained'}, scenes: scenes.map(mapScene)};
  }
  async createStoryboard(projectId: string, draft: StoryboardCreate) {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
      const existing = await transaction.select({id: storyboards.id}).from(storyboards).where(eq(storyboards.projectId, projectId));
      if (existing.length) return;
      const id = randomUUID();
      await transaction.insert(storyboards).values({id, projectId, title: draft.title, theme: draft.theme, targetDurationSeconds: draft.targetDurationSeconds});
      await transaction.insert(voiceProfiles).values({id: randomUUID(), projectId, profile: draft.voiceProfile, evidenceItemIds: [...new Set(draft.voiceProfile.traits.flatMap((trait) => trait.evidenceItemIds))]});
      await transaction.insert(filmScenes).values(draft.scenes.map((scene, sequenceOrder) => ({id: randomUUID(), storyboardId: id, sequenceOrder, ...scene})));
    });
    return (await this.findStoryboard(projectId))!;
  }
  async addScene(projectId: string, storyboardId: string, scene: FilmSceneInput) {
    await this.requireBoard(projectId, storyboardId);
    const [row] = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${storyboardId}))`);
      const current = await transaction.select().from(filmScenes).where(eq(filmScenes.storyboardId, storyboardId));
      const total = current.reduce((sum, candidate) => sum + candidate.durationSeconds, scene.durationSeconds);
      if (total > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
      const inserted = await transaction.insert(filmScenes).values({id: randomUUID(), storyboardId, sequenceOrder: current.length, ...scene}).returning();
      await transaction.update(storyboards).set({targetDurationSeconds: total, updatedAt: new Date()}).where(and(eq(storyboards.id, storyboardId), eq(storyboards.projectId, projectId)));
      return inserted;
    });
    return mapScene(row);
  }
  async editScene(projectId: string, storyboardId: string, sceneId: string, change: Partial<FilmSceneInput>) {
    await this.requireBoard(projectId, storyboardId);
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${storyboardId}))`);
      const [updated] = await transaction.update(filmScenes).set(change).where(and(eq(filmScenes.id, sceneId), eq(filmScenes.storyboardId, storyboardId))).returning();
      if (!updated) throw new Error('SCENE_NOT_FOUND');
      const current = await transaction.select().from(filmScenes).where(eq(filmScenes.storyboardId, storyboardId));
      const total = current.reduce((sum, candidate) => sum + candidate.durationSeconds, 0);
      if (total < 120 || total > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
      await transaction.update(storyboards).set({targetDurationSeconds: total, updatedAt: new Date()}).where(and(eq(storyboards.id, storyboardId), eq(storyboards.projectId, projectId)));
    });
    return (await this.findStoryboard(projectId))!;
  }
  async reorderScenes(projectId: string, storyboardId: string, orderedSceneIds: string[]) {
    const board = await this.requireBoard(projectId, storyboardId);
    if (orderedSceneIds.length !== board.scenes.length || new Set(orderedSceneIds).size !== board.scenes.length || orderedSceneIds.some((id) => !board.scenes.some((scene) => scene.id === id))) throw new Error('INVALID_SCENE_ORDER');
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${storyboardId}))`);
      for (const [sequenceOrder, id] of orderedSceneIds.entries()) await transaction.update(filmScenes).set({sequenceOrder}).where(and(eq(filmScenes.id, id), eq(filmScenes.storyboardId, storyboardId)));
    });
    return (await this.findStoryboard(projectId))!;
  }
  async replaceScene(projectId: string, storyboardId: string, sceneId: string, scene: FilmSceneInput) {
    await this.requireBoard(projectId, storyboardId);
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${storyboardId}))`);
      const [updated] = await transaction.update(filmScenes).set(scene).where(and(eq(filmScenes.id, sceneId), eq(filmScenes.storyboardId, storyboardId))).returning();
      if (!updated) throw new Error('SCENE_NOT_FOUND');
      const current = await transaction.select().from(filmScenes).where(eq(filmScenes.storyboardId, storyboardId));
      const total = current.reduce((sum, candidate) => sum + candidate.durationSeconds, 0);
      if (total < 120 || total > 240) throw new Error('STORYBOARD_DURATION_OUT_OF_RANGE');
      await transaction.update(storyboards).set({targetDurationSeconds: total, updatedAt: new Date()}).where(and(eq(storyboards.id, storyboardId), eq(storyboards.projectId, projectId)));
    });
    return (await this.findStoryboard(projectId))!;
  }
  private async requireBoard(projectId: string, storyboardId: string) {
    const board = await this.findStoryboard(projectId); if (!board || board.id !== storyboardId) throw new Error('STORYBOARD_NOT_FOUND'); return board;
  }
}
