import {z} from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  GCS_BUCKET: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_STORY_MODEL: z.string().min(1).default('gemini-3.1-flash-lite'),
  GEMINI_REQUIRE_PAID_PROJECT: z.stringbool().default(false),
  GEMINI_PAID_PROJECT_VERIFIED: z.stringbool().default(false),
  GEMINI_PAID_PROJECT_ID: z.string().min(1).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
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
});

export const parseEnv = (input: NodeJS.ProcessEnv) => schema.parse(input);
export type ServerEnv = z.infer<typeof schema>;
