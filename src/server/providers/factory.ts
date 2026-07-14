import {GoogleGenAI} from '@google/genai';
import {DeepgramClient as DeepgramSdkClient} from '@deepgram/sdk';

import {GeminiStoryAgent, PostgresProviderStructuredResultStore, geminiPricing, type GeminiClient, type ProviderStructuredResultStore} from '../../features/story/gemini-story-agent';
import {PostgresConsentRepository} from '../../features/consent/consent-repository';
import {ConsentService} from '../../features/consent/consent-service';
import {DefaultProviderExecutor} from '../../features/providers/provider-executor';
import {PostgresProviderArtifactRepository, ProviderArtifactService} from '../../features/providers/provider-artifact-service';
import {PostgresAssetRepository} from '../../features/media/asset-service';
import {PostgresProviderRunRepository} from '../../features/providers/provider-run-repository';
import {ProviderRunService} from '../../features/providers/provider-run-service';
import type {ProviderExecutor} from '../../features/providers/types';
import type {Database} from '../db/client';
import {DeepgramTranscriber, type DeepgramClient, type DeepgramResponse} from '../../features/transcription/deepgram-transcriber';
import {deepgramTranscriptionPricing} from '../../features/transcription/transcription-service';

type ProviderEnvironment = {
  NODE_ENV: 'development'|'test'|'production';
  GCP_PROJECT_ID: string;
  GEMINI_API_KEY?: string;
  GEMINI_STORY_MODEL: string;
  GEMINI_REQUIRE_PAID_PROJECT: boolean;
  GEMINI_PAID_PROJECT_VERIFIED: boolean;
  GEMINI_PAID_PROJECT_ID?: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_TRANSCRIPTION_MODEL?: string;
  PROVIDER_FINGERPRINT_SECRET?: string;
  PROVIDER_DEFAULT_BUDGET_MICROS?: number;
  PROVIDER_DEFAULT_REQUEST_BUDGET?: number;
  PROVIDER_RUN_LEASE_MS?: number;
};

type ProviderDependencies = {
  executor?: ProviderExecutor;
  database?: Database;
  resultStore?: ProviderStructuredResultStore;
  createGeminiClient?: (apiKey: string | undefined) => GeminiClient;
  createDeepgramClient?: (apiKey: string) => DeepgramClient;
};

export const createProviderServices = (env: ProviderEnvironment, dependencies: ProviderDependencies) => {
  geminiPricing(env.GEMINI_STORY_MODEL);
  const attested = env.GEMINI_REQUIRE_PAID_PROJECT === true &&
    env.GEMINI_PAID_PROJECT_VERIFIED === true &&
    Boolean(env.GEMINI_PAID_PROJECT_ID) && env.GEMINI_PAID_PROJECT_ID === env.GCP_PROJECT_ID;
  const injectedFake = Boolean(dependencies.createGeminiClient) && env.NODE_ENV !== 'production';
  if (!injectedFake && (!attested || !env.GEMINI_API_KEY)) throw new Error('GEMINI_PAID_PROJECT_NOT_VERIFIED');
  const createClient = dependencies.createGeminiClient ?? ((apiKey) => {
    if (!apiKey) throw new Error('GEMINI_API_KEY_REQUIRED');
    return new GoogleGenAI({apiKey}) as unknown as GeminiClient;
  });
  const client = createClient(env.GEMINI_API_KEY);
  const executor = dependencies.executor ?? (() => {
    if (!dependencies.database) throw new Error('PROVIDER_DATABASE_REQUIRED');
    const consent = new ConsentService(new PostgresConsentRepository(dependencies.database), async () => undefined);
    const runs = new ProviderRunService(new PostgresProviderRunRepository(dependencies.database), {
      fingerprintSecret: env.PROVIDER_FINGERPRINT_SECRET ?? 'development-only-provider-fingerprint',
      defaultBudgetMicros: env.PROVIDER_DEFAULT_BUDGET_MICROS ?? 5_000_000,
      defaultRequestBudget: env.PROVIDER_DEFAULT_REQUEST_BUDGET ?? 100,
      leaseMs: env.PROVIDER_RUN_LEASE_MS ?? 60_000
    });
    return new DefaultProviderExecutor(consent, runs);
  })();
  const results = dependencies.resultStore ?? (dependencies.database ? new PostgresProviderStructuredResultStore(dependencies.database) : undefined);
  if (!results) throw new Error('PROVIDER_RESULT_STORE_REQUIRED');
  const artifacts = dependencies.database ? new ProviderArtifactService(new PostgresProviderArtifactRepository(dependencies.database)) : undefined;
  const listReadyAssetIds = dependencies.database ? async (projectId: string) => (await new PostgresAssetRepository(dependencies.database!).listByProject(projectId)).filter((asset) => asset.projectId === projectId && asset.processingStatus === 'ready').map((asset) => asset.id) : undefined;
  const deepgramClient = env.DEEPGRAM_API_KEY ? (dependencies.createDeepgramClient ?? ((key: string): DeepgramClient => {
    const sdk = new DeepgramSdkClient({apiKey: key, maxRetries: 0});
    return {listen: {prerecorded: {transcribeFile: async (bytes, options, requestOptions) => ({
      result: await sdk.listen.v1.media.transcribeFile(bytes, options as never, requestOptions) as unknown as DeepgramResponse['result'], error: null
    })}}};
  }))(env.DEEPGRAM_API_KEY) : undefined;
  if (deepgramClient) deepgramTranscriptionPricing(env.DEEPGRAM_TRANSCRIPTION_MODEL!);
  return {
    executor,
    storyAgent: new GeminiStoryAgent(client, {model: env.GEMINI_STORY_MODEL}, executor, results, artifacts, listReadyAssetIds),
    deepgramTranscriber: deepgramClient ? new DeepgramTranscriber(deepgramClient, {model: env.DEEPGRAM_TRANSCRIPTION_MODEL!}) : undefined
  };
};
