import {describe, expect, it} from 'vitest';
import {parseEnv} from './env';

const requiredEnv = {
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://user:password@localhost:5432/legacy_studio',
  GCS_BUCKET: 'legacy-studio',
  OPENAI_API_KEY: 'test-key',
  GCP_PROJECT_ID: 'legacy-studio-project'
};

describe('parseEnv', () => {
  it('applies deployment defaults', () => {
    expect(parseEnv(requiredEnv)).toMatchObject({
      GCP_LOCATION: 'us-central1',
      RENDER_JOB_NAME: 'legacy-studio-render',
      PROVIDER_RUN_LEASE_MS: 60_000,
      PROVIDER_DEFAULT_BUDGET_MICROS: 5_000_000,
      PROVIDER_DEFAULT_REQUEST_BUDGET: 100
      ,DEEPGRAM_TRANSCRIPTION_MODEL: 'nova-3'
    });
  });

  it('requires a production fingerprint secret and validates positive control-plane values', () => {
    expect(() => parseEnv({...requiredEnv, NODE_ENV: 'production'})).toThrow('PROVIDER_FINGERPRINT_SECRET');
    expect(() => parseEnv({...requiredEnv, PROVIDER_RUN_LEASE_MS: '0'})).toThrow();
  });

  it('rejects missing required configuration', () => {
    expect(() => parseEnv({NODE_ENV: 'test'})).toThrow();
  });
});
