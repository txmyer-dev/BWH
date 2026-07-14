import {z} from 'zod';

export const createProjectInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subjectName: z.string().trim().min(1).max(120),
  creatorName: z.string().trim().min(1).max(120),
  creatorRelationship: z.string().trim().min(1).max(120),
  giftIntention: z.string().trim().max(500).optional()
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export type StoredProjectInput = CreateProjectInput & {
  id: string;
  ownerTokenHash: string;
  subjectId: string;
};
