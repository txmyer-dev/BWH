import {GoogleGenAI} from '@google/genai';
import {DeepgramClient as DeepgramSdkClient} from '@deepgram/sdk';
import OpenAI from 'openai';
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

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
import {OpenAIFactualityAuditor, openAIAuditPricing, type OpenAIAuditClient} from '../../features/audit/openai-factuality-auditor';
import {PostgresAuditRepository, type AuditRepository} from '../../features/audit/audit-repository';
import {DeepgramNarration} from '../../features/narration/deepgram-narration';
import {AzureNarration, type AzureSpeechClient} from '../../features/narration/azure-narration';

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
  DEEPGRAM_NARRATION_MODEL?: string;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  AZURE_SPEECH_VOICE?: string;
  AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS?: number;
  OPENAI_API_KEY?: string;
  OPENAI_AUDIT_MODEL?: string;
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
  createOpenAIClient?: (apiKey: string | undefined) => OpenAIAuditClient;
  auditRepository?: AuditRepository;
  createAzureSpeechClient?: (key: string, region: string, voice: string) => AzureSpeechClient;
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
  const openAIModel = env.OPENAI_AUDIT_MODEL ?? 'gpt-5.6';
  const injectedOpenAI = Boolean(dependencies.createOpenAIClient) && env.NODE_ENV !== 'production';
  const openAIClient = env.OPENAI_API_KEY || injectedOpenAI ? (dependencies.createOpenAIClient ?? ((key) => {
    if (!key) throw new Error('OPENAI_API_KEY_REQUIRED');
    return new OpenAI({apiKey: key, maxRetries: 0}) as unknown as OpenAIAuditClient;
  }))(env.OPENAI_API_KEY) : undefined;
  if (openAIClient) openAIAuditPricing(openAIModel);
  const auditRepository = dependencies.auditRepository ?? (dependencies.database ? new PostgresAuditRepository(dependencies.database) : undefined);
  const narrationModel = env.DEEPGRAM_NARRATION_MODEL ?? 'aura-2-arcas-en';
  if (narrationModel !== 'aura-2-arcas-en') throw new Error('DEEPGRAM_NARRATION_MODEL_UNPRICED');
  const deepgramNarration = env.DEEPGRAM_API_KEY ? new DeepgramNarration(env.DEEPGRAM_API_KEY, {model: narrationModel}) : undefined;
  const azureComplete = Boolean(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION && env.AZURE_SPEECH_VOICE && env.AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS);
  const azureClient = azureComplete ? (dependencies.createAzureSpeechClient ?? ((key: string, region: string, voice: string): AzureSpeechClient => {
    let active: SpeechSDK.SpeechSynthesizer | undefined;
    return {
      synthesize: ({text}) => new Promise((resolve, reject) => {
        const config = SpeechSDK.SpeechConfig.fromSubscription(key, region); config.speechSynthesisVoiceName = voice;
        config.speechSynthesisOutputFormat = SpeechSDK.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm;
        active = new SpeechSDK.SpeechSynthesizer(config);
        active.speakTextAsync(text, (result) => { const bytes = new Uint8Array(result.audioData); active?.close(); active = undefined; if (result.reason !== SpeechSDK.ResultReason.SynthesizingAudioCompleted) reject(new Error('AZURE_TTS_FAILED')); else resolve({bytes}); }, (error) => { active?.close(); active = undefined; reject(error); });
      }),
      stop: () => { active?.close(); active = undefined; }
    };
  }))(env.AZURE_SPEECH_KEY!, env.AZURE_SPEECH_REGION!, env.AZURE_SPEECH_VOICE!) : undefined;
  return {
    executor,
    storyAgent: new GeminiStoryAgent(client, {model: env.GEMINI_STORY_MODEL}, executor, results, artifacts, listReadyAssetIds),
    deepgramTranscriber: deepgramClient ? new DeepgramTranscriber(deepgramClient, {model: env.DEEPGRAM_TRANSCRIPTION_MODEL!}) : undefined,
    factualityAuditor: openAIClient && auditRepository ? new OpenAIFactualityAuditor(openAIClient, {model: openAIModel}, executor, results, auditRepository) : undefined,
    narrationProviders: {deepgram: deepgramNarration, azure: azureClient ? new AzureNarration(azureClient, {voice: env.AZURE_SPEECH_VOICE!}) : undefined},
    azureTtsPriceMicrosPerMillionCharacters: env.AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS
  };
};
