import {describe, expect, it} from 'vitest';

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

const setup = async () => {
  const projectService = new ProjectService(new InMemoryProjectRepository());
  const project = await projectService.createProject({
    title: 'Maple Street',
    subjectName: 'Ruth',
    creatorName: 'Tom',
    creatorRelationship: 'son'
  });
  const repository = new InMemoryAssetRepository();
  const storage = new MemoryStorage();
  const service = new AssetService(repository, storage, projectService);
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
    {kind: 'source-audio' as const, name: 'memory.mp3', contentType: 'audio/mpeg', size: 1_000},
    {kind: 'creator-narration' as const, name: 'narration.wav', contentType: 'audio/wav', size: 1_000}
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
        {kind: 'source-audio', name: 'memory.mp3', contentType: 'audio/mpeg', size: AUDIO_BYTES + 1}
      )
    ).rejects.toThrow('FILE_TOO_LARGE');
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
