import {describe, expect, it, vi} from 'vitest';

import {InMemoryProjectRepository} from '../projects/project-repository';
import {ProjectService} from '../projects/project-service';
import {
  AssetService,
  InMemoryAssetRepository,
  type UploadFile
} from './asset-service';
import {MemoryStorage} from './memory-storage';

const IMAGE_BYTES = 25 * 1024 * 1024;
const AUDIO_BYTES = 100 * 1024 * 1024;

const image = (overrides: Partial<UploadFile> = {}): UploadFile => ({
  kind: 'image',
  name: 'family-photo.jpg',
  contentType: 'image/jpeg',
  size: 2_048,
  ...overrides
});

const setup = async (
  now: () => Date = () => new Date('2026-07-14T12:00:00Z'),
  storage = new MemoryStorage(),
  assertStorageConsent: (projectId: string) => Promise<unknown> = async () => ({})
) => {
  const projectService = new ProjectService(new InMemoryProjectRepository());
  const project = await projectService.createProject({
    title: 'Maple Street',
    subjectName: 'Ruth',
    creatorName: 'Tom',
    creatorRelationship: 'son'
  });
  const repository = new InMemoryAssetRepository();
  const service = new AssetService(
    repository,
    storage,
    projectService,
    assertStorageConsent,
    now
  );
  return {project, repository, service, storage};
};

const uploadAndComplete = async (
  context: Awaited<ReturnType<typeof setup>>,
  file: UploadFile
) => {
  const requested = await context.service.requestUpload(
    context.project.projectId,
    context.project.ownerToken,
    file
  );
  context.storage.upload(requested.objectKey, file.size, file.contentType);
  return context.service.completeUpload(requested.assetId);
};

describe('AssetService upload policy', () => {
  it('does not reserve or sign an upload before storage consent', async () => {
    const storage = new MemoryStorage();
    const context = await setup(
      undefined,
      storage,
      async () => { throw new Error('STORAGE_CONSENT_REQUIRED'); }
    );

    await expect(context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      image()
    )).rejects.toThrow('STORAGE_CONSENT_REQUIRED');
    expect(await context.repository.listByProject(context.project.projectId)).toEqual([]);
    expect(storage.signedRequests).toEqual([]);
  });

  it('authorizes before checking storage consent', async () => {
    const consent = vi.fn(async () => { throw new Error('STORAGE_CONSENT_REQUIRED'); });
    const context = await setup(undefined, undefined, consent);
    await expect(context.service.requestUpload(
      context.project.projectId,
      '0'.repeat(64),
      image()
    )).rejects.toThrow('PROJECT_FORBIDDEN');
    expect(consent).not.toHaveBeenCalled();
  });
  it('requires three ready images before analysis', async () => {
    const context = await setup();

    await uploadAndComplete(context, image({name: 'one.jpg'}));
    await uploadAndComplete(context, image({name: 'two.jpg'}));
    await expect(
      context.service.assertReadyForAnalysis(context.project.projectId)
    ).rejects.toThrow('THREE_IMAGES_REQUIRED');

    await uploadAndComplete(context, image({name: 'three.jpg'}));
    await expect(
      context.service.assertReadyForAnalysis(context.project.projectId)
    ).resolves.toBeUndefined();
  });

  it('accepts at most seven images', async () => {
    const context = await setup();

    for (let index = 0; index < 7; index += 1) {
      await context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({name: `${index}.jpg`})
      );
    }

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({name: 'eighth.jpg'})
      )
    ).rejects.toThrow('IMAGE_LIMIT_REACHED');
  });

  it('atomically limits concurrent image and singleton reservations', async () => {
    const context = await setup();
    const imageResults = await Promise.allSettled(
      Array.from({length: 8}, (_, index) =>
        context.service.requestUpload(
          context.project.projectId,
          context.project.ownerToken,
          image({name: `${index}.jpg`})
        )
      )
    );
    expect(imageResults.filter((result) => result.status === 'fulfilled')).toHaveLength(7);
    expect(imageResults.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const singleton = {
      kind: 'text' as const,
      name: 'notes.txt',
      contentType: 'text/plain',
      size: 100
    };
    const singletonResults = await Promise.allSettled([
      context.service.requestUpload(context.project.projectId, context.project.ownerToken, singleton),
      context.service.requestUpload(context.project.projectId, context.project.ownerToken, singleton)
    ]);
    expect(singletonResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'accepts the approved image type %s',
    async (contentType) => {
      const context = await setup();
      await expect(
        context.service.requestUpload(
          context.project.projectId,
          context.project.ownerToken,
          image({contentType})
        )
      ).resolves.toEqual(
        expect.objectContaining({uploadUrl: expect.any(String)})
      );
    }
  );

  it('rejects unapproved image types and images over 25 MB', async () => {
    const context = await setup();

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({contentType: 'image/gif'})
      )
    ).rejects.toThrow('UNSUPPORTED_FILE_TYPE');
    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({size: IMAGE_BYTES + 1})
      )
    ).rejects.toThrow('FILE_TOO_LARGE');
  });

  it.each([
    {kind: 'text' as const, name: 'supporting.txt', contentType: 'text/plain', size: 100},
    {kind: 'source_audio' as const, name: 'memory.mp3', contentType: 'audio/mpeg', size: 1_000},
    {kind: 'creator_narration' as const, name: 'narration.wav', contentType: 'audio/wav', size: 1_000}
  ])('allows only one $kind asset', async (file) => {
    const context = await setup();
    await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      file
    );

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        file
      )
    ).rejects.toThrow('ASSET_KIND_LIMIT_REACHED');
  });

  it('enforces approved text/audio MIME types and the 100 MB audio limit', async () => {
    const context = await setup();

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        {kind: 'text', name: 'notes.html', contentType: 'text/html', size: 20}
      )
    ).rejects.toThrow('UNSUPPORTED_FILE_TYPE');
    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        {kind: 'source_audio', name: 'memory.mp3', contentType: 'audio/mpeg', size: AUDIO_BYTES + 1}
      )
    ).rejects.toThrow('FILE_TOO_LARGE');
  });

  it('rejects unknown runtime asset kinds instead of treating them as audio', async () => {
    const context = await setup();
    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        {
          kind: 'arbitrary',
          name: 'payload.mp3',
          contentType: 'audio/mpeg',
          size: 100
        } as unknown as UploadFile
      )
    ).rejects.toThrow('INVALID_ASSET_KIND');
  });

  it('uses underscore runtime names for both audio roles', async () => {
    const context = await setup();
    for (const kind of ['source_audio', 'creator_narration'] as const) {
      await expect(
        context.service.requestUpload(
          context.project.projectId,
          context.project.ownerToken,
          {kind, name: `${kind}.wav`, contentType: 'audio/wav', size: 100} as unknown as UploadFile
        )
      ).resolves.toEqual(expect.objectContaining({assetId: expect.any(String)}));
    }
  });

  it('safely reuses a compatible pending reservation and rejects cross-file reuse', async () => {
    const context = await setup();
    const file = {kind: 'text' as const, name: 'notes.txt', contentType: 'text/plain', size: 100};
    const first = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      file
    );
    const retried = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      {...file, reservationId: first.assetId} as UploadFile
    );
    expect(retried).toMatchObject({assetId: first.assetId, objectKey: first.objectKey});

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        {...file, name: 'different.txt', reservationId: first.assetId} as UploadFile
      )
    ).rejects.toThrow('UPLOAD_RESERVATION_MISMATCH');
  });

  it('never reopens a completed original reservation for writing', async () => {
    const context = await setup();
    const file = image();
    const ready = await uploadAndComplete(context, file);
    const signedBeforeRetry = context.storage.signedRequests.length;

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        {...file, reservationId: ready.id}
      )
    ).rejects.toThrow('UPLOAD_RESERVATION_MISMATCH');
    expect(context.storage.signedRequests).toHaveLength(signedBeforeRetry);
  });

  it('releases expired pending reservations so failed attempts do not exhaust quotas', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const context = await setup(() => now);
    for (let index = 0; index < 7; index += 1) {
      await context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({name: `${index}.jpg`})
      );
    }
    now = new Date('2026-07-14T12:11:00Z');
    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        image({name: 'replacement.jpg'})
      )
    ).resolves.toEqual(expect.objectContaining({assetId: expect.any(String)}));
  });

  it('extends a compatible retry beyond every newly issued upload URL', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const context = await setup(() => now);
    const file = {kind: 'text' as const, name: 'notes.txt', contentType: 'text/plain', size: 100};
    const first = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      file
    );

    now = new Date('2026-07-14T12:09:30Z');
    await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      {...file, reservationId: first.assetId}
    );
    const extended = await context.repository.findById(first.assetId);
    expect(extended?.reservationExpiresAt?.toISOString()).toBe(
      '2026-07-14T12:19:30.000Z'
    );
    expect(extended!.reservationExpiresAt!.getTime() - now.getTime()).toBeGreaterThan(
      5 * 60 * 1_000
    );

    now = new Date('2026-07-14T12:11:00Z');
    await expect(
      context.service.requestUpload(
        context.project.projectId,
        context.project.ownerToken,
        file
      )
    ).rejects.toThrow('ASSET_KIND_LIMIT_REACHED');
  });

  it('retains cleanup tombstones until durable object deletion succeeds', async () => {
    class RetryableCleanupStorage extends MemoryStorage {
      failCleanup = true;

      override async deleteMany(objectKeys: string[]) {
        if (this.failCleanup) throw new Error('STORAGE_UNAVAILABLE');
        return super.deleteMany(objectKeys);
      }
    }

    let now = new Date('2026-07-14T12:00:00Z');
    const storage = new RetryableCleanupStorage();
    const context = await setup(() => now, storage);
    const file = {kind: 'text' as const, name: 'notes.txt', contentType: 'text/plain', size: 100};
    const expired = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      file
    );

    now = new Date('2026-07-14T12:11:00Z');
    const replacement = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      {...file, reservationId: expired.assetId}
    );
    expect(replacement.assetId).not.toBe(expired.assetId);
    expect((await context.repository.findById(expired.assetId))?.processingStatus).toBe(
      'cleanup_pending'
    );

    storage.failCleanup = false;
    await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      {...file, reservationId: replacement.assetId}
    );
    await expect(context.repository.findById(expired.assetId)).resolves.toBeUndefined();
  });

  it('atomically replaces an expired retry reservation and returns its cleanup key', async () => {
    const repository = new InMemoryAssetRepository();
    const expiresAt = new Date('2026-07-14T12:10:00Z');
    const original = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      kind: 'text' as const,
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      originalObjectKey: 'projects/project/originals/original.txt',
      reservationExpiresAt: expiresAt,
      size: 100,
      caption: null,
      capturedAtText: null,
      knownPeople: []
    };
    await repository.reservePending(original, undefined, new Date('2026-07-14T12:00:00Z'));

    const replacement = await repository.reservePending(
      {
        ...original,
        id: crypto.randomUUID(),
        originalObjectKey: 'projects/project/originals/replacement.txt',
        reservationExpiresAt: new Date('2026-07-14T12:20:00Z')
      },
      original.id,
      expiresAt
    );

    expect(replacement.asset.id).not.toBe(original.id);
    expect(replacement.releasedObjectKeys).toContain(original.originalObjectKey);
    expect((await repository.findById(original.id))?.processingStatus).toBe(
      'cleanup_pending'
    );
  });

  it('rejects an expired retry when the replacement is not compatible', async () => {
    const repository = new InMemoryAssetRepository();
    const expiresAt = new Date('2026-07-14T12:10:00Z');
    const original = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      kind: 'text' as const,
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      originalObjectKey: 'projects/project/originals/original.txt',
      reservationExpiresAt: expiresAt,
      size: 100,
      caption: null,
      capturedAtText: null,
      knownPeople: []
    };
    await repository.reservePending(original, undefined, new Date('2026-07-14T12:00:00Z'));

    await expect(
      repository.reservePending(
        {
          ...original,
          id: crypto.randomUUID(),
          originalName: 'different.txt',
          originalObjectKey: 'projects/project/originals/replacement.txt',
          reservationExpiresAt: new Date('2026-07-14T12:20:00Z')
        },
        original.id,
        expiresAt
      )
    ).rejects.toThrow('UPLOAD_RESERVATION_MISMATCH');
  });

  it('uses project-prefixed immutable original object keys', async () => {
    const context = await setup();
    const requested = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      image()
    );

    expect(requested.objectKey).toMatch(
      new RegExp(`^projects/${context.project.projectId}/originals/`)
    );
    await expect(
      context.repository.complete(
        requested.assetId,
        `projects/${context.project.projectId}/originals/replacement.jpg`,
        {size: 2_048, contentType: 'image/jpeg'}
      )
    ).rejects.toThrow('ORIGINAL_OBJECT_KEY_IMMUTABLE');
  });

  it('authorizes before signing, uses five-minute uploads, and verifies server metadata', async () => {
    const context = await setup();

    await expect(
      context.service.requestUpload(
        context.project.projectId,
        '0'.repeat(64),
        image()
      )
    ).rejects.toThrow('PROJECT_FORBIDDEN');
    expect(context.storage.signedRequests).toHaveLength(0);

    const requested = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      image()
    );
    expect(context.storage.signedRequests[0]).toMatchObject({
      operation: 'upload',
      expiresInMs: 5 * 60 * 1_000
    });
    context.storage.upload(requested.objectKey, IMAGE_BYTES + 1, 'image/jpeg');
    await expect(context.service.completeUpload(requested.assetId)).rejects.toThrow(
      'FILE_TOO_LARGE'
    );
  });

  it('authorizes fifteen-minute download URLs and returns ready assets only', async () => {
    const context = await setup();
    const ready = await uploadAndComplete(context, image());

    await expect(
      context.service.createDownloadUrl(
        context.project.projectId,
        '0'.repeat(64),
        ready.id
      )
    ).rejects.toThrow('PROJECT_FORBIDDEN');
    const downloadUrl = await context.service.createDownloadUrl(
      context.project.projectId,
      context.project.ownerToken,
      ready.id
    );

    expect(downloadUrl).toContain(encodeURIComponent(ready.originalObjectKey));
    expect(context.storage.signedRequests.at(-1)).toMatchObject({
      operation: 'download',
      expiresInMs: 15 * 60 * 1_000
    });
  });

  it('does not complete an asset through a different project', async () => {
    const context = await setup();
    const requested = await context.service.requestUpload(
      context.project.projectId,
      context.project.ownerToken,
      image()
    );
    context.storage.upload(requested.objectKey, 2_048, 'image/jpeg');

    await expect(
      context.service.completeProjectUpload(crypto.randomUUID(), requested.assetId)
    ).rejects.toThrow('ASSET_NOT_FOUND');
  });
});
