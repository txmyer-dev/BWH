import {describe, expect, it} from 'vitest';
import {renderJobResourceName} from '../features/film/cloud-run-render-launcher';
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
      FACTUALITY_AUDIT_PROVIDER: 'openai',
      GEMINI_USE_VERTEX_AI: false,
      GEMINI_VERTEX_LOCATION: 'global',
      RENDER_JOB_NAME: 'legacy-studio-render',
      REMOTION_BUNDLE_PATH: 'remotion-bundle',
      REMOTION_CONCURRENCY: 4,
      PROVIDER_RUN_LEASE_MS: 60_000,
      PROVIDER_DEFAULT_BUDGET_MICROS: 5_000_000,
      PROVIDER_DEFAULT_REQUEST_BUDGET: 100
      ,DEEPGRAM_TRANSCRIPTION_MODEL: 'nova-3'
      ,DEEPGRAM_NARRATION_MODEL: 'aura-2-arcas-en'
    });
  });

  it('requires complete Azure speech configuration and an explicit positive price', () => {
    expect(() => parseEnv({...requiredEnv, AZURE_SPEECH_KEY: 'key'})).toThrow('AZURE_SPEECH');
    expect(() => parseEnv({...requiredEnv, AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_VOICE: 'voice'})).toThrow('AZURE_TTS_PRICE');
    expect(parseEnv({...requiredEnv, AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_VOICE: 'voice', AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS: '15000000'}).AZURE_SPEECH_VOICE).toBe('voice');
  });

  it('requires a production fingerprint secret and validates positive control-plane values', () => {
    expect(() => parseEnv({...requiredEnv, NODE_ENV: 'production'})).toThrow('PROVIDER_FINGERPRINT_SECRET');
    expect(() => parseEnv({...requiredEnv, PROVIDER_RUN_LEASE_MS: '0'})).toThrow();
  });

  it('resolves the default render job to a fully qualified Cloud Run resource name', () => {
    expect(renderJobResourceName(parseEnv(requiredEnv))).toBe(
      'projects/legacy-studio-project/locations/us-central1/jobs/legacy-studio-render'
    );
  });

  it('rejects an explicitly empty render job name', () => {
    expect(() => parseEnv({...requiredEnv, RENDER_JOB_NAME: ''})).toThrow('RENDER_JOB_NAME');
  });

  it('rejects missing required configuration', () => {
    expect(() => parseEnv({NODE_ENV: 'test'})).toThrow();
  });
});
