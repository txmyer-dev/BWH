import {randomUUID} from 'node:crypto';

import {and, eq} from 'drizzle-orm';

import type {ProjectService} from '../projects/project-service';
import type {Database} from '../../server/db/client';
import {assets} from '../../server/db/schema';
import {validateFile} from './file-policy';
import type {MediaStorage} from './storage';

export type AssetKind = 'image' | 'text' | 'source-audio' | 'creator-narration';

export interface UploadFile {
  kind: AssetKind;
  name: string;
  contentType: string;
  size: number;
  caption?: string;
  capturedAtText?: string;
  knownPeople?: string[];
}

export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  originalObjectKey: string;
  processingStatus: 'pending' | 'ready';
  size: number | null;
  caption: string | null;
  capturedAtText: string | null;
  knownPeople: string[];
  sequenceOrder: number;
}

type NewAsset = Omit<Asset, 'processingStatus' | 'size'>;

export interface AssetRepository {
  listByProject(projectId: string): Promise<Asset[]>;
  findById(assetId: string): Promise<Asset | undefined>;
  createPending(asset: NewAsset): Promise<void>;
  complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ): Promise<Asset>;
}

const readKind = (metadata: unknown, type: string): AssetKind => {
  if (
    metadata &&
    typeof metadata === 'object' &&
    'kind' in metadata &&
    ['image', 'text', 'source-audio', 'creator-narration'].includes(
      String(metadata.kind)
    )
  ) {
    return metadata.kind as AssetKind;
  }
  return type === 'audio' ? 'source-audio' : (type as AssetKind);
};

const mapRow = (row: typeof assets.$inferSelect): Asset => {
  const metadata = (row.metadata ?? {}) as {
    kind?: string;
    size?: number;
    knownPeople?: string[];
  };
  return {
    id: row.id,
    projectId: row.projectId,
    kind: readKind(metadata, row.type),
    mimeType: row.mimeType,
    originalObjectKey: row.originalObjectKey,
    processingStatus: row.processingStatus === 'ready' ? 'ready' : 'pending',
    size: typeof metadata.size === 'number' ? metadata.size : null,
    caption: row.caption,
    capturedAtText: row.capturedAtText,
    knownPeople: Array.isArray(metadata.knownPeople) ? metadata.knownPeople : [],
    sequenceOrder: row.sequenceOrder
  };
};

export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly database: Database) {}

  async listByProject(projectId: string) {
    const rows = await this.database.query.assets.findMany({
      where: (table, {eq: equals}) => equals(table.projectId, projectId)
    });
    return rows.map(mapRow);
  }

  async findById(assetId: string) {
    const row = await this.database.query.assets.findFirst({
      where: (table, {eq: equals}) => equals(table.id, assetId)
    });
    return row ? mapRow(row) : undefined;
  }

  async createPending(asset: NewAsset) {
    await this.database.insert(assets).values({
      id: asset.id,
      projectId: asset.projectId,
      type: asset.kind === 'source-audio' || asset.kind === 'creator-narration' ? 'audio' : asset.kind,
      mimeType: asset.mimeType,
      originalObjectKey: asset.originalObjectKey,
      processingStatus: 'pending',
      caption: asset.caption,
      capturedAtText: asset.capturedAtText,
      sequenceOrder: asset.sequenceOrder,
      metadata: {kind: asset.kind, knownPeople: asset.knownPeople}
    });
  }

  async complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ) {
    const existing = await this.findById(assetId);
    if (!existing) {
      throw new Error('ASSET_NOT_FOUND');
    }
    if (existing.originalObjectKey !== expectedOriginalObjectKey) {
      throw new Error('ORIGINAL_OBJECT_KEY_IMMUTABLE');
    }
    const [updated] = await this.database
      .update(assets)
      .set({
        processingStatus: 'ready',
        mimeType: metadata.contentType,
        metadata: {
          kind: existing.kind,
          knownPeople: existing.knownPeople,
          size: metadata.size
        },
        updatedAt: new Date()
      })
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.originalObjectKey, expectedOriginalObjectKey)
        )
      )
      .returning();
    if (!updated) {
      const existing = await this.findById(assetId);
      throw new Error(existing ? 'ORIGINAL_OBJECT_KEY_IMMUTABLE' : 'ASSET_NOT_FOUND');
    }
    return mapRow(updated);
  }
}

export class InMemoryAssetRepository implements AssetRepository {
  private readonly assets = new Map<string, Asset>();

  async listByProject(projectId: string) {
    return [...this.assets.values()]
      .filter((asset) => asset.projectId === projectId)
      .map((asset) => ({...asset, knownPeople: [...asset.knownPeople]}));
  }

  async findById(assetId: string) {
    const asset = this.assets.get(assetId);
    return asset ? {...asset, knownPeople: [...asset.knownPeople]} : undefined;
  }

  async createPending(asset: NewAsset) {
    this.assets.set(asset.id, {
      ...asset,
      processingStatus: 'pending',
      size: null,
      knownPeople: [...asset.knownPeople]
    });
  }

  async complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ) {
    const asset = this.assets.get(assetId);
    if (!asset) {
      throw new Error('ASSET_NOT_FOUND');
    }
    if (asset.originalObjectKey !== expectedOriginalObjectKey) {
      throw new Error('ORIGINAL_OBJECT_KEY_IMMUTABLE');
    }
    const ready: Asset = {
      ...asset,
      mimeType: metadata.contentType,
      size: metadata.size,
      processingStatus: 'ready'
    };
    this.assets.set(assetId, ready);
    return {...ready, knownPeople: [...ready.knownPeople]};
  }
}

const extensionFor = (file: UploadFile) => {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg'
  };
  return extensions[file.contentType] ?? 'bin';
};

export class AssetService {
  constructor(
    private readonly repository: AssetRepository,
    private readonly storage: MediaStorage,
    private readonly projects: Pick<ProjectService, 'assertProjectOwner'>
  ) {}

  async requestUpload(projectId: string, ownerToken: string, file: UploadFile) {
    await this.projects.assertProjectOwner(projectId, ownerToken);
    validateFile(file);
    const existing = await this.repository.listByProject(projectId);
    const sameKind = existing.filter((asset) => asset.kind === file.kind).length;
    if (file.kind === 'image' ? sameKind >= 7 : sameKind >= 1) {
      throw new Error(
        file.kind === 'image' ? 'IMAGE_LIMIT_REACHED' : 'ASSET_KIND_LIMIT_REACHED'
      );
    }

    const assetId = randomUUID();
    const objectKey = `projects/${projectId}/originals/${assetId}.${extensionFor(file)}`;
    await this.repository.createPending({
      id: assetId,
      projectId,
      kind: file.kind,
      mimeType: file.contentType,
      originalObjectKey: objectKey,
      caption: file.caption?.trim() || null,
      capturedAtText: file.capturedAtText?.trim() || null,
      knownPeople: file.knownPeople?.map((person) => person.trim()).filter(Boolean) ?? [],
      sequenceOrder: existing.filter((asset) => asset.kind === 'image').length
    });
    const uploadUrl = await this.storage.createUploadUrl({
      objectKey,
      contentType: file.contentType,
      expiresInMs: 5 * 60 * 1_000
    });
    return {assetId, uploadUrl, objectKey};
  }

  async completeUpload(assetId: string) {
    const asset = await this.repository.findById(assetId);
    if (!asset) {
      throw new Error('ASSET_NOT_FOUND');
    }
    const metadata = await this.storage.stat(asset.originalObjectKey);
    validateFile({
      kind: asset.kind,
      name: asset.originalObjectKey,
      contentType: metadata.contentType,
      size: metadata.size
    });
    if (metadata.contentType !== asset.mimeType) {
      throw new Error('UPLOADED_TYPE_MISMATCH');
    }
    return this.repository.complete(asset.id, asset.originalObjectKey, metadata);
  }

  async completeProjectUpload(projectId: string, assetId: string) {
    const asset = await this.repository.findById(assetId);
    if (!asset || asset.projectId !== projectId) {
      throw new Error('ASSET_NOT_FOUND');
    }
    return this.completeUpload(assetId);
  }

  async assertReadyForAnalysis(projectId: string) {
    const assets = await this.repository.listByProject(projectId);
    if (
      assets.filter(
        (asset) => asset.kind === 'image' && asset.processingStatus === 'ready'
      ).length < 3
    ) {
      throw new Error('THREE_IMAGES_REQUIRED');
    }
  }

  async createDownloadUrl(
    projectId: string,
    ownerToken: string,
    assetId: string
  ) {
    await this.projects.assertProjectOwner(projectId, ownerToken);
    const asset = await this.repository.findById(assetId);
    if (
      !asset ||
      asset.projectId !== projectId ||
      asset.processingStatus !== 'ready'
    ) {
      throw new Error('ASSET_NOT_FOUND');
    }
    return this.storage.createDownloadUrl({
      objectKey: asset.originalObjectKey,
      expiresInMs: 15 * 60 * 1_000
    });
  }
}
