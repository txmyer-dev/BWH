import {describe, expect, it} from 'vitest';
import {internalTranscriptionErrorStatus} from './response-status';

describe('internal transcription retry responses', () => {
  it('keeps an unexpired competing lease retryable', () => {
    expect(internalTranscriptionErrorStatus('TRANSCRIPTION_JOB_BUSY')).toBe(503);
  });
  it('keeps authentication and terminal provider failures non-successful', () => {
    expect(internalTranscriptionErrorStatus('CLOUD_TASK_UNAUTHORIZED')).toBe(401);
    expect(internalTranscriptionErrorStatus('TRANSCRIPTION_FAILED')).toBe(422);
  });
});
