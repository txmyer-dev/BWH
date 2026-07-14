import {describe, expect, it, vi} from 'vitest';

import {ConsentService} from './consent-service';
import {InMemoryConsentRepository} from './consent-repository';

const projectId = '214a6a17-86f8-44f0-aa44-8ef739e2a032';

const setup = (authorize = vi.fn(async () => undefined)) => ({
  authorize,
  service: new ConsentService(
    new InMemoryConsentRepository(),
    authorize,
    () => new Date('2026-07-14T12:00:00Z')
  )
});

describe('ConsentService', () => {
  it('accepts a project storage snapshot and returns it from the storage gate', async () => {
    const {service} = setup();
    const storage = await service.accept({
      projectId,
      purpose: 'storage',
      documentVersion: '2026-07-14.1',
      providers: ['google_cloud_storage'],
      dataCategories: ['original_media', 'derived_media'],
      permissionConfirmed: true
    });

    await expect(service.assertStorageConsent(projectId)).resolves.toEqual(storage);
    await expect(
      service.assertProcessingConsent(projectId, 'deepgram', ['source_audio'])
    ).rejects.toThrow('PROCESSING_CONSENT_REQUIRED');
  });

  it('rejects consent unless the creator confirms permission', async () => {
    const {service} = setup();
    await expect(service.accept({
      projectId,
      purpose: 'storage',
      documentVersion: '2026-07-14.1',
      providers: ['google_cloud_storage'],
      dataCategories: ['original_media'],
      permissionConfirmed: false
    })).rejects.toThrow('PERMISSION_CONFIRMATION_REQUIRED');
  });

  it('authorizes the project owner before accepting a snapshot', async () => {
    const authorize = vi.fn(async () => { throw new Error('PROJECT_FORBIDDEN'); });
    const {service} = setup(authorize);
    await expect(service.accept({
      projectId,
      purpose: 'storage',
      documentVersion: '2026-07-14.1',
      providers: ['google_cloud_storage'],
      dataCategories: ['original_media'],
      permissionConfirmed: true
    })).rejects.toThrow('PROJECT_FORBIDDEN');
    expect(authorize).toHaveBeenCalledWith(projectId);
  });

  it('canonicalizes provider/category order for the snapshot hash', async () => {
    const first = setup().service;
    const second = setup().service;
    const input = {
      projectId,
      purpose: 'processing' as const,
      documentVersion: '2026-07-14.1',
      permissionConfirmed: true
    };
    const a = await first.accept({...input, providers: ['openai', 'deepgram'], dataCategories: ['narration_text', 'source_audio']});
    const b = await second.accept({...input, providers: ['deepgram', 'openai'], dataCategories: ['source_audio', 'narration_text']});
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.providers).toEqual(['deepgram', 'openai']);
    expect(a.dataCategories).toEqual(['narration_text', 'source_audio']);
  });

  it('invalidates processing consent when a requested provider broadens the snapshot', async () => {
    const {service} = setup();
    const original = await service.accept({
      projectId,
      purpose: 'processing',
      documentVersion: '2026-07-14.1',
      providers: ['google_gemini', 'deepgram', 'openai'],
      dataCategories: ['selected_photos', 'source_audio', 'narration_text'],
      permissionConfirmed: true
    });

    await expect(
      service.assertProcessingConsent(projectId, 'microsoft_azure', ['narration_text'])
    ).rejects.toThrow('PROCESSING_CONSENT_REQUIRED');
    await expect(
      service.assertProcessingConsent(projectId, 'deepgram', ['source_audio'])
    ).rejects.toThrow('PROCESSING_CONSENT_REQUIRED');

    const renewed = await service.accept({
      projectId,
      purpose: 'processing',
      documentVersion: '2026-07-14.1',
      providers: ['google_gemini', 'deepgram', 'openai', 'microsoft_azure'],
      dataCategories: original.dataCategories,
      permissionConfirmed: true
    });
    await expect(
      service.assertProcessingConsent(projectId, 'microsoft_azure', ['narration_text'])
    ).resolves.toEqual(renewed);
  });
});
