import {z} from 'zod';
import {evidenceKindSchema} from '../story/schemas';

export const verificationStatusSchema = z.enum(['proposed', 'confirmed', 'corrected', 'rejected']);
export const evidenceItemSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), kind: evidenceKindSchema,
  claim: z.string().min(1), originalClaim: z.string().min(1),
  sourceAssetIds: z.array(z.string().uuid()).min(1), sourceExcerpt: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(), verificationStatus: verificationStatusSchema,
  correction: z.string().min(1).nullable()
}).strict();

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
