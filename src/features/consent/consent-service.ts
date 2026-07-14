import {createHash, randomUUID} from 'node:crypto';

import type {ConsentRepository} from './consent-repository';
import {
  acceptConsentSchema,
  type AcceptConsentInput,
  type ConsentSnapshot,
  type ProcessingProvider
} from './schemas';

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

export const consentSnapshotHash = (providers: string[], dataCategories: string[]) =>
  createHash('sha256')
    .update(JSON.stringify({
      providers: sortedUnique(providers),
      dataCategories: sortedUnique(dataCategories)
    }))
    .digest('hex');

export class ConsentService {
  constructor(
    private readonly repository: ConsentRepository,
    private readonly assertOwner: (projectId: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async accept(input: AcceptConsentInput): Promise<ConsentSnapshot> {
    await this.assertOwner(input.projectId);
    if (input.permissionConfirmed !== true) {
      throw new Error('PERMISSION_CONFIRMATION_REQUIRED');
    }
    const {projectId: _projectId, ...body} = input;
    const validated = acceptConsentSchema.parse(body);
    const providers = sortedUnique(validated.providers);
    const dataCategories = sortedUnique(validated.dataCategories);
    const acceptedAt = this.now();
    return this.repository.accept({
      id: randomUUID(),
      projectId: input.projectId,
      purpose: validated.purpose,
      documentVersion: validated.documentVersion,
      providers,
      dataCategories,
      permissionConfirmed: true,
      snapshotHash: consentSnapshotHash(providers, dataCategories),
      acceptedAt,
      invalidatedAt: null
    });
  }

  async assertStorageConsent(projectId: string) {
    const consent = await this.repository.findValid(projectId, 'storage');
    if (
      !consent ||
      !consent.providers.includes('google_cloud_storage') ||
      !consent.dataCategories.includes('original_media')
    ) {
      throw new Error('STORAGE_CONSENT_REQUIRED');
    }
    return consent;
  }

  async assertProcessingConsent(
    projectId: string,
    provider: ProcessingProvider,
    categories: string[]
  ) {
    const consent = await this.repository.findValid(projectId, 'processing');
    const requestedCategories = sortedUnique(categories);
    if (
      !consent ||
      !consent.providers.includes(provider) ||
      requestedCategories.some((category) => !consent.dataCategories.includes(category))
    ) {
      if (consent) await this.repository.invalidate(consent.id, this.now());
      throw new Error('PROCESSING_CONSENT_REQUIRED');
    }
    return consent;
  }
}
