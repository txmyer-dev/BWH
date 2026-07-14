import {randomUUID} from 'node:crypto';

import {and, eq, lt, sql} from 'drizzle-orm';

import type {ProjectService} from '../projects/project-service';
import type {Database} from '../../server/db/client';
import {assets, projects} from '../../server/db/schema';
import {parseUploadFile, validateFile} from './file-policy';
import type {MediaStorage} from './storage';

export type AssetKind = 'image' | 'text' | 'source_audio' | 'creator_narration';

export interface UploadFile {
  kind: AssetKind;
  name: string;
  contentType: string;
  size: number;
  reservationId?: string;
  caption?: string;
  capturedAtText?: string;
  knownPeople?: string[];
}

export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  originalName: string;
  mimeType: string;
  originalObjectKey: string;
  processingStatus: 'pending' | 'ready';
  reservationExpiresAt: Date | null;
  size: number;
  caption: string | null;
  capturedAtText: string | null;
  knownPeople: string[];
  sequenceOrder: number;
}

type NewReservation = Omit<
  Asset,
  'processingStatus' | 'sequenceOrder'
>;

type ReservationResult = {asset: Asset; releasedObjectKeys: string[]};

export interface AssetRepository {
  listByProject(projectId: string): Promise<Asset[]>;
  findById(assetId: string): Promise<Asset | undefined>;
  reservePending(
    reservation: NewReservation,
    retryAssetId: string | undefined,
    now: Date
  ): Promise<ReservationResult>;
  complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ): Promise<Asset>;
}

const mapRow = (row: typeof assets.$inferSelect): Asset => {
  const metadata = (row.metadata ?? {}) as {
    size?: number;
    knownPeople?: string[];
    originalName?: string;
  };
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.assetKind as AssetKind,
    originalName: metadata.originalName ?? '',
    mimeType: row.mimeType,
    originalObjectKey: row.originalObjectKey,
    processingStatus: row.processingStatus === 'ready' ? 'ready' : 'pending',
    reservationExpiresAt: row.reservationExpiresAt,
    size: typeof metadata.size === 'number' ? metadata.size : 0,
    caption: row.caption,
    capturedAtText: row.capturedAtText,
    knownPeople: Array.isArray(metadata.knownPeople) ? metadata.knownPeople : [],
    sequenceOrder: row.sequenceOrder
  };
};

const reservationMatches = (asset: Asset, reservation: NewReservation) =>
  asset.projectId === reservation.projectId &&
  asset.kind === reservation.kind &&
  asset.originalName === reservation.originalName &&
  asset.mimeType === reservation.mimeType &&
  asset.size === reservation.size;

const allocateSequence = (kind: AssetKind, existing: Asset[]) => {
  if (kind !== 'image') {
    if (existing.some((asset) => asset.kind === kind)) {
      throw new Error('ASSET_KIND_LIMIT_REACHED');
    }
    return 0;
  }
  const used = new Set(
    existing
      .filter((asset) => asset.kind === 'image')
      .map((asset) => asset.sequenceOrder)
  );
  for (let sequence = 0; sequence < 7; sequence += 1) {
    if (!used.has(sequence)) return sequence;
  }
  throw new Error('IMAGE_LIMIT_REACHED');
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

  async reservePending(
    reservation: NewReservation,
    retryAssetId: string | undefined,
    now: Date
  ) {
    return this.database.transaction(async (transaction) => {
      // Every reservation for a project takes the same row lock. Counting,
      // sequence allocation, and insert therefore form one atomic operation.
      await transaction.execute(
        sql`select ${projects.id} from ${projects} where ${projects.id} = ${reservation.projectId} for update`
      );

      const expired = await transaction
        .delete(assets)
        .where(
          and(
            eq(assets.projectId, reservation.projectId),
            eq(assets.processingStatus, 'pending'),
            lt(assets.reservationExpiresAt, now)
          )
        )
        .returning({originalObjectKey: assets.originalObjectKey});

      if (retryAssetId) {
        const retryRow = await transaction.query.assets.findFirst({
          where: (table, {and: all, eq: equals}) =>
            all(
              equals(table.id, retryAssetId),
              equals(table.projectId, reservation.projectId)
            )
        });
        if (!retryRow) throw new Error('UPLOAD_RESERVATION_EXPIRED');
        const retry = mapRow(retryRow);
        if (
          retry.processingStatus !== 'pending' ||
          !reservationMatches(retry, reservation)
        ) {
          throw new Error('UPLOAD_RESERVATION_MISMATCH');
        }
        return {
          asset: retry,
          releasedObjectKeys: expired.map((item) => item.originalObjectKey)
        };
      }

      const currentRows = await transaction.query.assets.findMany({
        where: (table, {eq: equals}) =>
          equals(table.projectId, reservation.projectId)
      });
      const current = currentRows.map(mapRow);
      const sequenceOrder = allocateSequence(reservation.kind, current);
      const [created] = await transaction
        .insert(assets)
        .values({
          id: reservation.id,
          projectId: reservation.projectId,
          type:
            reservation.kind === 'source_audio' ||
            reservation.kind === 'creator_narration'
              ? 'audio'
              : reservation.kind,
          assetKind: reservation.kind,
          mimeType: reservation.mimeType,
          originalObjectKey: reservation.originalObjectKey,
          processingStatus: 'pending',
          caption: reservation.caption,
          capturedAtText: reservation.capturedAtText,
          sequenceOrder,
          reservationExpiresAt: reservation.reservationExpiresAt,
          metadata: {
            originalName: reservation.originalName,
            size: reservation.size,
            knownPeople: reservation.knownPeople
          }
        })
        .returning();
      return {
        asset: mapRow(created),
        releasedObjectKeys: expired.map((item) => item.originalObjectKey)
      };
    });
  }

  async complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ) {
    const existing = await this.findById(assetId);
    if (!existing) throw new Error('ASSET_NOT_FOUND');
    if (existing.originalObjectKey !== expectedOriginalObjectKey) {
      throw new Error('ORIGINAL_OBJECT_KEY_IMMUTABLE');
    }
    const [updated] = await this.database
      .update(assets)
      .set({
        processingStatus: 'ready',
        reservationExpiresAt: null,
        mimeType: metadata.contentType,
        metadata: {
          originalName: existing.originalName,
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
      const found = await this.findById(assetId);
      throw new Error(found ? 'ORIGINAL_OBJECT_KEY_IMMUTABLE' : 'ASSET_NOT_FOUND');
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

  async reservePending(
    reservation: NewReservation,
    retryAssetId: string | undefined,
    now: Date
  ): Promise<ReservationResult> {
    const releasedObjectKeys: string[] = [];
    for (const [id, asset] of this.assets) {
      if (
        asset.projectId === reservation.projectId &&
        asset.processingStatus === 'pending' &&
        asset.reservationExpiresAt &&
        asset.reservationExpiresAt < now
      ) {
        this.assets.delete(id);
        releasedObjectKeys.push(asset.originalObjectKey);
      }
    }

    if (retryAssetId) {
      const retry = this.assets.get(retryAssetId);
      if (!retry) throw new Error('UPLOAD_RESERVATION_EXPIRED');
      if (
        retry.processingStatus !== 'pending' ||
        !reservationMatches(retry, reservation)
      ) {
        throw new Error('UPLOAD_RESERVATION_MISMATCH');
      }
      return {
        asset: {...retry, knownPeople: [...retry.knownPeople]},
        releasedObjectKeys
      };
    }

    const current = [...this.assets.values()].filter(
      (asset) => asset.projectId === reservation.projectId
    );
    const created: Asset = {
      ...reservation,
      processingStatus: 'pending',
      sequenceOrder: allocateSequence(reservation.kind, current),
      knownPeople: [...reservation.knownPeople]
    };
    this.assets.set(created.id, created);
    return {
      asset: {...created, knownPeople: [...created.knownPeople]},
      releasedObjectKeys
    };
  }

  async complete(
    assetId: string,
    expectedOriginalObjectKey: string,
    metadata: {size: number; contentType: string}
  ) {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error('ASSET_NOT_FOUND');
    if (asset.originalObjectKey !== expectedOriginalObjectKey) {
      throw new Error('ORIGINAL_OBJECT_KEY_IMMUTABLE');
    }
    const ready: Asset = {
      ...asset,
      mimeType: metadata.contentType,
      size: metadata.size,
      processingStatus: 'ready',
      reservationExpiresAt: null
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

const RESERVATION_LIFETIME_MS = 10 * 60 * 1_000;

export class AssetService {
  constructor(
    private readonly repository: AssetRepository,
    private readonly storage: MediaStorage,
    private readonly projects: Pick<ProjectService, 'assertProjectOwner'>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async requestUpload(projectId: string, ownerToken: string, file: UploadFile) {
    await this.projects.assertProjectOwner(projectId, ownerToken);
    const validatedFile = parseUploadFile(file);
    validateFile(validatedFile);
    const now = this.now();
    const assetId = randomUUID();
    const objectKey = `projects/${projectId}/originals/${assetId}.${extensionFor(validatedFile)}`;
    const reservation = await this.repository.reservePending(
      {
        id: assetId,
        projectId,
        kind: validatedFile.kind,
        originalName: validatedFile.name,
        mimeType: validatedFile.contentType,
        originalObjectKey: objectKey,
        reservationExpiresAt: new Date(
          now.getTime() + RESERVATION_LIFETIME_MS
        ),
        size: validatedFile.size,
        caption: validatedFile.caption?.trim() || null,
        capturedAtText: validatedFile.capturedAtText?.trim() || null,
        knownPeople:
          validatedFile.knownPeople
            ?.map((person) => person.trim())
            .filter(Boolean) ?? []
      },
      validatedFile.reservationId,
      now
    );
    if (reservation.releasedObjectKeys.length > 0) {
      await this.storage.deleteMany(reservation.releasedObjectKeys);
    }
    const uploadUrl = await this.storage.createUploadUrl({
      objectKey: reservation.asset.originalObjectKey,
      contentType: reservation.asset.mimeType,
      expiresInMs: 5 * 60 * 1_000
    });
    return {
      assetId: reservation.asset.id,
      uploadUrl,
      objectKey: reservation.asset.originalObjectKey
    };
  }

  async completeUpload(assetId: string) {
    const asset = await this.repository.findById(assetId);
    if (!asset) throw new Error('ASSET_NOT_FOUND');
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
    const projectAssets = await this.repository.listByProject(projectId);
    if (
      projectAssets.filter(
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
