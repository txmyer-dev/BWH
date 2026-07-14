import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {
  AssetService,
  PostgresAssetRepository,
  type UploadFile
} from '@/features/media/asset-service';
import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type RouteContext = {params: Promise<{projectId: string}>};

const services = () => {
  const database = getDatabase();
  const assetRepository = new PostgresAssetRepository(database);
  const projectService = new ProjectService(
    new PostgresProjectRepository(database)
  );
  const consentService = new ConsentService(
    new PostgresConsentRepository(database),
    async () => undefined
  );
  return {
    projectService,
    assetRepository,
    assetService: new AssetService(
      assetRepository,
      new GcsMediaStorage(parseEnv(process.env).GCS_BUCKET),
      projectService,
      (projectId) => consentService.assertStorageConsent(projectId)
    )
  };
};

const ownerToken = async (projectId: string) =>
  (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';

const errorResponse = (error: unknown) => {
  const code = error instanceof Error ? error.message : 'UPLOAD_FAILED';
  const status = code === 'PROJECT_FORBIDDEN'
    ? 403
    : code === 'ASSET_NOT_FOUND'
      ? 404
      : code === 'STORAGE_CONSENT_REQUIRED'
        ? 409
        : 400;
  return NextResponse.json({error: code}, {status});
};

export async function GET(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const database = getDatabase();
    const projectService = new ProjectService(new PostgresProjectRepository(database));
    const assetRepository = new PostgresAssetRepository(database);
    await projectService.assertProjectOwner(projectId, await ownerToken(projectId));
    return NextResponse.json((await assetRepository.listByProject(projectId)).map((asset) => ({
      id: asset.id, projectId: asset.projectId, kind: asset.kind,
      processingStatus: asset.processingStatus, caption: asset.caption,
      sequenceOrder: asset.sequenceOrder
    })));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const file = (await request.json()) as UploadFile;
    const {assetService} = services();
    return NextResponse.json(
      await assetService.requestUpload(
        projectId,
        await ownerToken(projectId),
        file
      )
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = (await request.json()) as {assetId?: string};
    if (!body.assetId) {
      throw new Error('ASSET_NOT_FOUND');
    }
    const {assetService, projectService} = services();
    await projectService.assertProjectOwner(
      projectId,
      await ownerToken(projectId)
    );
    return NextResponse.json(
      await assetService.completeProjectUpload(projectId, body.assetId)
    );
  } catch (error) {
    return errorResponse(error);
  }
}
