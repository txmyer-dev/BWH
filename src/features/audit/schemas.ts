import {z} from 'zod';

export const auditFindingSchema = z.object({
  sceneId: z.string().uuid(),
  claim: z.string().min(1),
  kind: z.enum(['supported', 'unsupported', 'overstated', 'missing_citation']),
  blocking: z.boolean(),
  evidenceItemIds: z.array(z.string().uuid())
}).strict();

export const factualityAuditOutputSchema = z.object({
  findings: z.array(auditFindingSchema).max(100)
}).strict();

export type AuditFinding = z.infer<typeof auditFindingSchema>;
export type FactualityAuditInput = {
  projectId: string;
  storyboardId: string;
  storyboardRevision: number;
  evidenceHash: string;
  narrationHash: string;
  evidence: {id: string; claim: string; sourceExcerpt: string; sourceAssetIds: string[]}[];
  narration: {sceneId: string; text: string; evidenceItemIds: string[]}[];
};
export type FactualityAuditResult = {
  auditId: string;
  providerRunId: string;
  projectId: string;
  storyboardId: string;
  storyboardRevision: number;
  evidenceHash: string;
  narrationHash: string;
  status: 'passed'|'blocked';
  findings: AuditFinding[];
  auditPromptVersion: string;
  auditSchemaVersion: string;
  model: string;
};
