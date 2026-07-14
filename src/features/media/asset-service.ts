import {randomUUID} from 'node:crypto';

import {and, eq, inArray, lte, sql} from 'drizzle-orm';

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
  durationMs?: number;
}

export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  originalName: string;
  mimeType: string;
  originalObjectKey: string;
  processingStatus: 'pending' | 'ready' | 'cleanup_pending';
  reservationExpiresAt: Date | null;
  size: number;
  caption: string | null;
  capturedAtText: string | null;
  knownPeople: string[];
  sequenceOrder: number;
  transcript?: string | null;
  durationMs?: number | null;
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
  finishCleanup(objectKeys: string[]): Promise<void>;
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
    transcript?: string;
    durationMs?: number;
  };
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.assetKind as AssetKind,
    originalName: metadata.originalName ?? '',
    mimeType: row.mimeType,
    originalObjectKey: row.originalObjectKey,
    processingStatus:
      row.processingStatus === 'ready'
        ? 'ready'
        : row.processingStatus === 'cleanup_pending'
          ? 'cleanup_pending'
          : 'pending',
    reservationExpiresAt: row.reservationExpiresAt,
    size: typeof metadata.size === 'number' ? metadata.size : 0,
    caption: row.caption,
    capturedAtText: row.capturedAtText,
    knownPeople: Array.isArray(metadata.knownPeople) ? metadata.knownPeople : [],
    sequenceOrder: row.sequenceOrder,
    transcript: typeof metadata.transcript === 'string' ? metadata.transcript : null,
    durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : null
  };
};

const reservationMatches = (asset: Asset, reservation: NewReservation) =>
  asset.projectId === reservation.projectId &&
  asset.kind === reservation.kind &&
  asset.originalName === reservation.originalName &&
  asset.mimeType === reservation.mimeType &&
  asset.size === reservation.size &&
  asset.durationMs === reservation.durationMs;

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

      await transaction
        .update(assets)
        .set({
          processingStatus: 'cleanup_pending',
          reservationExpiresAt: null,
          updatedAt: now
        })
        .where(
          and(
            eq(assets.projectId, reservation.projectId),
            eq(assets.processingStatus, 'pending'),
            lte(assets.reservationExpiresAt, now)
          )
        );

      const cleanupRows = await transaction.query.assets.findMany({
        where: (table, {and: all, eq: equals}) =>
          all(
            equals(table.projectId, reservation.projectId),
            equals(table.processingStatus, 'cleanup_pending')
          )
      });

      if (retryAssetId) {
        const retryRow = await transaction.query.assets.findFirst({
          where: (table, {and: all, eq: equals}) =>
            all(
              equals(table.id, retryAssetId),
              equals(table.projectId, reservation.projectId)
            )
        });
        if (!retryRow) {
          throw new Error('UPLOAD_RESERVATION_EXPIRED');
        }
        const retry = mapRow(retryRow);
        if (!reservationMatches(retry, reservation)) {
          throw new Error('UPLOAD_RESERVATION_MISMATCH');
        }
        if (retry.processingStatus !== 'cleanup_pending') {
          if (retry.processingStatus !== 'pending') {
            throw new Error('UPLOAD_RESERVATION_MISMATCH');
          }
          const [extended] = await transaction
            .update(assets)
            .set({
              reservationExpiresAt: reservation.reservationExpiresAt,
              updatedAt: now
            })
            .where(
              and(
                eq(assets.id, retry.id),
                eq(assets.processingStatus, 'pending')
              )
            )
            .returning();
          if (!extended) throw new Error('UPLOAD_RESERVATION_EXPIRED');
          return {
            asset: mapRow(extended),
            releasedObjectKeys: cleanupRows.map(
              (item) => item.originalObjectKey
            )
          };
        }
      }

      const currentRows = await transaction.query.assets.findMany({
        where: (table, {eq: equals}) =>
          equals(table.projectId, reservation.projectId)
      });
      const current = currentRows
        .map(mapRow)
        .filter((asset) => asset.processingStatus !== 'cleanup_pending');
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
            knownPeople: reservation.knownPeople,
            transcript: reservation.transcript,
            durationMs: reservation.durationMs
          }
        })
        .returning();
      return {
        asset: mapRow(created),
        releasedObjectKeys: cleanupRows.map((item) => item.originalObjectKey)
      };
    });
  }

  async finishCleanup(objectKeys: string[]) {
    if (objectKeys.length === 0) return;
    await this.database
      .delete(assets)
      .where(
        and(
          eq(assets.processingStatus, 'cleanup_pending'),
          inArray(assets.originalObjectKey, objectKeys)
        )
      );
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
          transcript: existing.transcript,
          durationMs: existing.durationMs,
          size: metadata.size
        },
        updatedAt: new Date()
      })
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.originalObjectKey, expectedOriginalObjectKey),
          eq(assets.processingStatus, 'pending')
        )
      )
      .returning();
    if (!updated) {
      const found = await this.findById(assetId);
      if (found?.processingStatus === 'cleanup_pending') {
        throw new Error('UPLOAD_RESERVATION_EXPIRED');
      }
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
        asset.reservationExpiresAt <= now
      ) {
        this.assets.set(id, {
          ...asset,
          processingStatus: 'cleanup_pending',
          reservationExpiresAt: null
        });
        releasedObjectKeys.push(asset.originalObjectKey);
      }
    }
    for (const asset of this.assets.values()) {
      if (
        asset.projectId === reservation.projectId &&
        asset.processingStatus === 'cleanup_pending' &&
        !releasedObjectKeys.includes(asset.originalObjectKey)
      ) {
        releasedObjectKeys.push(asset.originalObjectKey);
      }
    }

    if (retryAssetId) {
      const retry = this.assets.get(retryAssetId);
      if (!retry) {
        throw new Error('UPLOAD_RESERVATION_EXPIRED');
      }
      if (!reservationMatches(retry, reservation)) {
        throw new Error('UPLOAD_RESERVATION_MISMATCH');
      }
      if (retry.processingStatus !== 'cleanup_pending') {
        if (retry.processingStatus !== 'pending') {
          throw new Error('UPLOAD_RESERVATION_MISMATCH');
        }
        const extended = {
          ...retry,
          reservationExpiresAt: reservation.reservationExpiresAt
        };
        this.assets.set(retry.id, extended);
        return {
          asset: {...extended, knownPeople: [...extended.knownPeople]},
          releasedObjectKeys
        };
      }
    }

    const current = [...this.assets.values()].filter(
      (asset) =>
        asset.projectId === reservation.projectId &&
        asset.processingStatus !== 'cleanup_pending'
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

  async finishCleanup(objectKeys: string[]) {
    const keys = new Set(objectKeys);
    for (const [id, asset] of this.assets) {
      if (
        asset.processingStatus === 'cleanup_pending' &&
        keys.has(asset.originalObjectKey)
      ) {
        this.assets.delete(id);
      }
    }
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
    private readonly assertStorageConsent: (projectId: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async requestUpload(projectId: string, ownerToken: string, file: UploadFile) {
    await this.projects.assertProjectOwner(projectId, ownerToken);
    await this.assertStorageConsent(projectId);
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
            .filter(Boolean) ?? [],
        durationMs: validatedFile.durationMs ?? null
      },
      validatedFile.reservationId,
      now
    );
    if (reservation.releasedObjectKeys.length > 0) {
      try {
        await this.storage.deleteMany(reservation.releasedObjectKeys);
        await this.repository.finishCleanup(reservation.releasedObjectKeys);
      } catch {
        // Cleanup tombstones remain durable and are retried on a later request.
      }
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
    if (asset.processingStatus === 'cleanup_pending') {
      throw new Error('UPLOAD_RESERVATION_EXPIRED');
    }
    if (asset.processingStatus === 'ready') return asset;
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
