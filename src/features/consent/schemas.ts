import {z} from 'zod';

export const consentPurposeSchema = z.enum(['storage', 'processing']);
export const processingProviderSchema = z.enum([
  'google_gemini',
  'deepgram',
  'openai',
  'microsoft_azure'
]);
export const consentProviderSchema = z.union([
  z.literal('google_cloud_storage'),
  processingProviderSchema
]);

export const acceptConsentSchema = z.object({
  purpose: consentPurposeSchema,
  documentVersion: z.string().trim().min(1).max(80),
  providers: z.array(consentProviderSchema).min(1),
  dataCategories: z.array(z.string().trim().min(1).max(80)).min(1),
  permissionConfirmed: z.boolean()
}).strict();

export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;
export type ProcessingProvider = z.infer<typeof processingProviderSchema>;
export type ConsentProvider = z.infer<typeof consentProviderSchema>;
export type AcceptConsentBody = z.infer<typeof acceptConsentSchema>;

export type AcceptConsentInput = AcceptConsentBody & {projectId: string};

export type ConsentSnapshot = {
  id: string;
  projectId: string;
  purpose: ConsentPurpose;
  documentVersion: string;
  providers: string[];
  dataCategories: string[];
  snapshotHash: string;
  acceptedAt: Date;
  invalidatedAt: Date | null;
};
