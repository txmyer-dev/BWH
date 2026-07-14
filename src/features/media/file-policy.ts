import type {UploadFile} from './asset-service';

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

export const validateFile = (file: UploadFile) => {
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
};
