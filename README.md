# The Legacy Studio

The Legacy Studio helps a creator turn a small, evidence-backed chapter of a loved one's life into a private downloadable Memory Film. The interface avoids AI jargon: the creator gathers photographs and recordings, confirms the family record, approves the narration, and selects **Prepare the gift**.

## Build Week scope

The submitted milestone creates one restrained Remotion film, renders it to H.264 MP4, stores it privately in Google Cloud Storage, and gives only the project owner a fifteen-minute download link. Browser preview, a separate render worker, Cloud Run Jobs, deletion recovery, scheduler provisioning, and production-scale hardening are deferred—not canceled—until after the hackathon.

Codex with GPT-5.6 was used throughout product definition, provider migration, consent and privacy boundaries, narration, testing, and the final film path. Key product decisions—including the downloadable Memory Film, generated narrator default, exact-text factuality gate, and one-service demo architecture—were made by the creator and implemented collaboratively with Codex.

## Provider data routing

- Google Cloud Storage receives original and derived private media.
- Google Gemini receives the consented story evidence needed to organize the chapter. It can also perform the final factuality review when `FACTUALITY_AUDIT_PROVIDER=gemini`. Production can use Vertex AI workload identity and normal GCP billing; the Gemini Developer API key path remains available for local or alternate deployments.
- Deepgram receives source audio for Nova-3 transcription and approved narration text for Arcas speech. Requests include `mip_opt_out=true`.
- OpenAI GPT-5.6 is the optional alternate factuality reviewer when `FACTUALITY_AUDIT_PROVIDER=openai`; it receives approved evidence references and final narration text, never raw media or storage URLs.
- Microsoft Azure receives approved narration text only when the creator explicitly selects the optional backup voice.

The product shows these destinations before processing consent. Routine tests use fakes and do not submit family media or spend provider credit.

## Local setup

Requirements: Node.js 24+, PostgreSQL, a private GCS bucket, and provider credentials for the paths being tested.

```bash
cp .env.example .env.local
npm ci
npm run db:migrate
npm test
npm run dev
```

`npm run build` creates both the Next.js application and the static Remotion bundle. A local MP4 render also needs a Chromium executable; set `REMOTION_BROWSER_EXECUTABLE` when it is not discoverable automatically. `REMOTION_CONCURRENCY` controls the number of parallel browser render workers and defaults to `4`.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
docker build -t legacy-studio-demo:test .
```

## Minimal GCP deployment

The deployment uses one Cloud Run service plus the project's existing Cloud SQL database, private GCS bucket, Cloud Tasks queue, Secret Manager values, Artifact Registry repository, and least-privilege service accounts. It does not create additional production infrastructure.

```powershell
powershell -File scripts/deploy.ps1 `
  -ProjectId YOUR_PROJECT `
  -RuntimeServiceAccount legacy-studio-runtime@YOUR_PROJECT.iam.gserviceaccount.com `
  -Bucket YOUR_PRIVATE_BUCKET `
  -CloudSqlInstance YOUR_PROJECT:us-central1:legacy-studio `
  -CloudTasksQueuePath projects/YOUR_PROJECT/locations/us-central1/queues/legacy-studio `
  -CloudTasksServiceAccount legacy-studio-tasks@YOUR_PROJECT.iam.gserviceaccount.com
```

The runtime identity needs only the database connection, private bucket object access, task-enqueue permissions, access to the named secrets, and permission to sign short-lived GCS download URLs. The task identity needs permission to invoke the Cloud Run service. Do not place credentials or identifiable family fixtures in the repository.
