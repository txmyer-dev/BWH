export interface MediaStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInMs: number;
  }): Promise<string>;
  createDownloadUrl(input: {
    objectKey: string;
    expiresInMs: number;
  }): Promise<string>;
  stat(objectKey: string): Promise<{size: number; contentType: string}>;
  readObject(input: {objectKey: string; maxBytes: number}): Promise<Buffer>;
  deleteMany(objectKeys: string[]): Promise<void>;
}
