import {z} from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  GCS_BUCKET: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_AUDIT_MODEL: z.string().min(1).default('gpt-5.6'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_STORY_MODEL: z.string().min(1).default('gemini-3.1-flash-lite'),
  GEMINI_REQUIRE_PAID_PROJECT: z.stringbool().default(false),
  GEMINI_PAID_PROJECT_VERIFIED: z.stringbool().default(false),
  GEMINI_PAID_PROJECT_ID: z.string().min(1).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_TRANSCRIPTION_MODEL: z.string().min(1).default('nova-3'),
  DEEPGRAM_NARRATION_MODEL: z.string().min(1).default('aura-2-arcas-en'),
  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  AZURE_SPEECH_VOICE: z.string().min(1).optional(),
  AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS: z.coerce.number().int().positive().optional(),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_LOCATION: z.string().default('us-central1'),
  CLOUD_TASKS_QUEUE_PATH: z.string().min(1).optional(),
  CLOUD_TASKS_TARGET_URL: z.string().url().optional(),
  CLOUD_TASKS_AUDIENCE: z.string().url().optional(),
  CLOUD_TASKS_SERVICE_ACCOUNT: z.string().email().optional(),
  RENDER_JOB_NAME: z.string().default('legacy-studio-render'),
  PROVIDER_FINGERPRINT_SECRET: z.string().min(32).optional(),
  PROVIDER_RUN_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  PROVIDER_DEFAULT_BUDGET_MICROS: z.coerce.number().int().positive().default(5_000_000),
  PROVIDER_DEFAULT_REQUEST_BUDGET: z.coerce.number().int().positive().default(100)
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.PROVIDER_FINGERPRINT_SECRET) {
    context.addIssue({code: 'custom', path: ['PROVIDER_FINGERPRINT_SECRET'], message: 'PROVIDER_FINGERPRINT_SECRET is required in production'});
  }
  const azure = [value.AZURE_SPEECH_KEY, value.AZURE_SPEECH_REGION, value.AZURE_SPEECH_VOICE, value.AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS];
  if (azure.some((item) => item !== undefined) && azure.some((item) => item === undefined)) {
    context.addIssue({code: 'custom', path: ['AZURE_SPEECH_KEY'], message: 'AZURE_SPEECH configuration and AZURE_TTS_PRICE must be complete'});
  }
});

export const parseEnv = (input: NodeJS.ProcessEnv) => schema.parse(input);
export type ServerEnv = z.infer<typeof schema>;
