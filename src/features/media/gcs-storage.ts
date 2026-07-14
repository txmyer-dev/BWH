import {Storage} from '@google-cloud/storage';

import type {MediaStorage} from './storage';

export class GcsMediaStorage implements MediaStorage {
  private readonly bucket;

  constructor(bucketName: string, storage = new Storage()) {
    this.bucket = storage.bucket(bucketName);
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInMs: number;
  }) {
    const [url] = await this.bucket.file(input.objectKey).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + input.expiresInMs,
      contentType: input.contentType,
      extensionHeaders: {'x-goog-if-generation-match': '0'}
    });
    return url;
  }

  async createDownloadUrl(input: {objectKey: string; expiresInMs: number}) {
    const [url] = await this.bucket.file(input.objectKey).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + input.expiresInMs
    });
    return url;
  }

  async stat(objectKey: string) {
    const [metadata] = await this.bucket.file(objectKey).getMetadata();
    const size = Number(metadata.size);
    const contentType = metadata.contentType;
    if (!Number.isSafeInteger(size) || !contentType) {
      throw new Error('INVALID_OBJECT_METADATA');
    }
    return {size, contentType};
  }

  async readObject(input: {objectKey: string; maxBytes: number}) {
    const metadata = await this.stat(input.objectKey);
    if (metadata.size > input.maxBytes) throw new Error('OBJECT_TOO_LARGE');
    const [bytes] = await this.bucket.file(input.objectKey).download();
    if (bytes.byteLength > input.maxBytes) throw new Error('OBJECT_TOO_LARGE');
    return bytes;
  }

  async deleteMany(objectKeys: string[]) {
    await Promise.all(
      objectKeys.map((objectKey) =>
        this.bucket.file(objectKey).delete({ignoreNotFound: true})
      )
    );
  }
}
