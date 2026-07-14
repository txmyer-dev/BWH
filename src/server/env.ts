import {z} from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  GCS_BUCKET: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_LOCATION: z.string().default('us-central1'),
  RENDER_JOB_NAME: z.string().default('legacy-studio-render')
});

export const parseEnv = (input: NodeJS.ProcessEnv) => schema.parse(input);
