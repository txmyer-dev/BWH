import type {UploadFile} from './asset-service';
import {z} from 'zod';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg'
]);

const assetKinds = ['image', 'text', 'source_audio', 'creator_narration'] as const;

const uploadFileSchema = z.object({
  kind: z.enum(assetKinds),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  size: z.number().int().positive(),
  reservationId: z.uuid().optional(),
  caption: z.string().max(2_000).optional(),
  capturedAtText: z.string().max(200).optional(),
  knownPeople: z.array(z.string().max(120)).max(50).optional(),
  durationMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional()
});

export const parseUploadFile = (input: unknown): UploadFile => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('kind' in input) ||
    !assetKinds.includes(String(input.kind) as (typeof assetKinds)[number])
  ) {
    throw new Error('INVALID_ASSET_KIND');
  }
  const parsed = uploadFileSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_UPLOAD_REQUEST');
  return parsed.data;
};

export const validateFile = (file: UploadFile) => {
  if (
    !assetKinds.includes(String(file.kind) as (typeof assetKinds)[number])
  ) {
    throw new Error('INVALID_ASSET_KIND');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('INVALID_FILE_SIZE');
  }

  if (file.kind === 'image') {
    if (!IMAGE_TYPES.has(file.contentType)) {
      throw new Error('UNSUPPORTED_FILE_TYPE');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }
    return;
  }

  if (file.kind === 'text') {
    if (file.contentType !== 'text/plain') {
      throw new Error('UNSUPPORTED_FILE_TYPE');
    }
    if (file.size > MAX_TEXT_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }
    return;
  }

  if (!AUDIO_TYPES.has(file.contentType)) {
    throw new Error('UNSUPPORTED_FILE_TYPE');
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error('FILE_TOO_LARGE');
  }
  if (!file.durationMs) throw new Error('AUDIO_DURATION_REQUIRED');
};
