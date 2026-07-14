import type {Storage} from '@google-cloud/storage';
import {describe, expect, it} from 'vitest';

import {GcsMediaStorage} from './gcs-storage';

describe('GcsMediaStorage', () => {
  it('signs create-only V4 upload URLs', async () => {
    let signedOptions: unknown;
    const file = {
      getSignedUrl: async (options: unknown) => {
        signedOptions = options;
        return ['https://storage.test/upload'];
      }
    };
    const fakeStorage = {
      bucket: () => ({file: () => file})
    } as unknown as Storage;
    const storage = new GcsMediaStorage('private-bucket', fakeStorage);

    await storage.createUploadUrl({
      objectKey: 'projects/project/originals/asset.jpg',
      contentType: 'image/jpeg',
      expiresInMs: 300_000
    });

    expect(signedOptions).toMatchObject({
      version: 'v4',
      action: 'write',
      contentType: 'image/jpeg',
      extensionHeaders: {'x-goog-if-generation-match': '0'}
    });
  });
});
