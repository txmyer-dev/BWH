import {z} from 'zod';

export const evidenceKindSchema = z.enum([
  'image_observation', 'direct_quote', 'uploaded_text', 'transcript',
  'creator_memory', 'model_hypothesis'
]);

export const evidenceCandidateSchema = z.object({
  claim: z.string().min(1),
  kind: evidenceKindSchema,
  sourceAssetIds: z.array(z.string().uuid()).min(1),
  sourceExcerpt: z.string().min(1),
  confidence: z.number().min(0).max(1),
  proposedStatus: z.literal('proposed')
}).strict();

const sourcedHypothesisSchema = z.object({
  claim: z.string().min(1),
  sourceAssetIds: z.array(z.string().uuid()).min(1),
  sourceExcerpt: z.string().min(1)
}).strict();

export const collectionAnalysisSchema = z.object({
  title: z.string().min(1),
  theme: z.string().min(1),
  timeRange: z.string().min(1),
  ordering: z.array(z.string().uuid()).min(3).max(7),
  evidenceCandidates: z.array(evidenceCandidateSchema),
  hypotheses: z.array(sourcedHypothesisSchema),
  rankedGaps: z.array(z.object({
    question: z.string().min(1),
    reason: z.string().min(1),
    rank: z.number().int().positive()
  }).strict())
}).strict();

export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>;
export type CollectionAnalysis = z.infer<typeof collectionAnalysisSchema>;

export const analysisAssetSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['image', 'text', 'transcript']),
  caption: z.string().optional(),
  text: z.string().optional(),
  imageUrl: z.string().url().optional(),
  imageBytes: z.string().startsWith('data:image/').optional()
}).strict();

export type AnalysisAsset = z.infer<typeof analysisAssetSchema>;
export type CollectionAnalysisInput = {projectId: string; assets: AnalysisAsset[]};
