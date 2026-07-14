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

const consentDocumentFields = {
  documentVersion: z.string().trim().min(1).max(80),
  permissionConfirmed: z.boolean()
};

const dataCategoriesSchema = z.array(z.string().trim().min(1).max(80)).min(1);

export const acceptConsentSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('storage'),
    ...consentDocumentFields,
    providers: z.array(z.literal('google_cloud_storage')).min(1),
    dataCategories: dataCategoriesSchema.refine(
      (categories) => categories.includes('original_media'),
      {message: 'STORAGE_CONSENT_REQUIRED'}
    )
  }).strict(),
  z.object({
    purpose: z.literal('processing'),
    ...consentDocumentFields,
    providers: z.array(processingProviderSchema).min(1),
    dataCategories: dataCategoriesSchema
  }).strict()
]);

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
