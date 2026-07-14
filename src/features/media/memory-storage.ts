import type {MediaStorage} from './storage';

type StoredObject = {size: number; contentType: string; data?: Buffer};

export class MemoryStorage implements MediaStorage {
  private readonly objects = new Map<string, StoredObject>();
  readonly signedRequests: Array<{
    operation: 'upload' | 'download';
    objectKey: string;
    expiresInMs: number;
    contentType?: string;
  }> = [];

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInMs: number;
  }) {
    this.signedRequests.push({operation: 'upload', ...input});
    return `memory://upload/${encodeURIComponent(input.objectKey)}`;
  }

  async createDownloadUrl(input: {objectKey: string; expiresInMs: number}) {
    this.signedRequests.push({operation: 'download', ...input});
    return `memory://download/${encodeURIComponent(input.objectKey)}`;
  }

  async stat(objectKey: string) {
    const object = this.objects.get(objectKey);
    if (!object) {
      throw new Error('UPLOAD_NOT_FOUND');
    }
    return {...object};
  }

  async readObject(input: {objectKey: string; maxBytes: number}) {
    const object = this.objects.get(input.objectKey);
    if (!object) throw new Error('UPLOAD_NOT_FOUND');
    if (object.size > input.maxBytes) throw new Error('OBJECT_TOO_LARGE');
    return object.data ? Buffer.from(object.data) : Buffer.alloc(object.size);
  }

  async deleteMany(objectKeys: string[]) {
    for (const objectKey of objectKeys) {
      this.objects.delete(objectKey);
    }
  }

  upload(objectKey: string, size: number, contentType: string, data?: Buffer | string) {
    if (this.objects.has(objectKey)) {
      throw new Error('OBJECT_ALREADY_EXISTS');
    }
    this.objects.set(objectKey, {size, contentType, data: data === undefined ? undefined : Buffer.from(data)});
  }
}
