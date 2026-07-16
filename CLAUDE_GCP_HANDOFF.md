# Legacy Studio GCP Handoff

Configure and deploy the existing Legacy Studio application. Restrict work to GCP infrastructure and deployment. Do not redesign the application, refactor unrelated code, or expand the project scope.

## Repository

- Local worktree: `C:\Users\txmye_ficivtv\Documents\Build Week Hackathon\.worktrees\legacy-studio-mvp`
- Branch: `codex/legacy-studio-mvp`
- The Task 12 implementation is currently uncommitted. Preserve every existing file and change.
- Deployment files already exist:
  - `Dockerfile`
  - `cloudbuild.yaml`
  - `scripts/deploy.ps1`
  - `.env.example`
  - `README.md`

## GCP Target

- Account: `felaniamllc@gmail.com`
- Project: `project-ea4bb078-dabc-4178-84d`
- Region: `us-central1`
- Billing is enabled.
- Do not touch `the-helm-500416`.

Before making changes, verify that both the active account and project match the values above.

## Resources Already Created

### APIs enabled

- Artifact Registry
- Cloud Build
- Cloud Run
- Cloud SQL Admin
- Cloud Tasks
- Secret Manager
- IAM Credentials

### Artifact Registry

- Repository: `legacy-studio`
- Format: Docker
- Region: `us-central1`
- No image has been uploaded yet.

### Cloud Storage

- Bucket: `project-ea4bb078-dabc-4178-84d-legacy-studio-media`
- Region: `us-central1`
- Uniform bucket-level access enabled
- Runtime service account has object-admin access.
- Creation requested public-access prevention; verify its current effective setting rather than assuming it.

### Cloud Tasks

- Queue: `legacy-studio`
- Queue path: `projects/project-ea4bb078-dabc-4178-84d/locations/us-central1/queues/legacy-studio`
- State: running
- Maximum concurrent dispatches: 2
- Maximum dispatch rate: 2 per second

### Service accounts

Runtime identity:

`legacy-studio-runtime@project-ea4bb078-dabc-4178-84d.iam.gserviceaccount.com`

Task caller identity:

`legacy-studio-tasks@project-ea4bb078-dabc-4178-84d.iam.gserviceaccount.com`

Existing permissions include:

- Runtime: Cloud SQL client
- Runtime: Cloud Tasks enqueuer
- Runtime: GCS object admin on the media bucket
- Runtime: service-account signing/token permissions
- Cloud Build/default compute identity: Artifact Registry writer

Audit existing permissions before adding anything. Use least privilege and avoid duplicate or broad project-level grants.

### Cloud SQL

- Instance: `legacy-studio`
- Connection name: `project-ea4bb078-dabc-4178-84d:us-central1:legacy-studio`
- PostgreSQL 16
- Enterprise edition
- Tier: `db-f1-micro`
- Storage: 10 GB SSD
- Backups disabled
- Storage auto-resize disabled
- Deletion protection disabled
- Last verified state: `RUNNABLE`

The instance is running and potentially billable.

It currently contains only:

- Default `postgres` database
- Default `postgres` user

No application database or application user exists yet.

### Secret Manager

Only this secret object was observed:

`legacy-studio-openai-api-key`

The operation that created it was interrupted. Do not assume that it contains a usable secret version or value. Verify it first.

These secrets do not exist yet:

- `legacy-studio-database-url`
- `legacy-studio-gemini-api-key`
- `legacy-studio-deepgram-api-key`
- `legacy-studio-provider-fingerprint`

## Credentials Needed From the User

Request these securely. Never put them in the repository, ordinary chat messages, logs, or plaintext documentation:

- Gemini API key
- Deepgram API key
- OpenAI API key
- Azure Speech credentials only if the optional backup is enabled:
  - Speech key
  - Region
  - Voice name
  - Price in micros per one million characters

Generate these internally:

- Strong Cloud SQL application-user password
- Cryptographically random provider-fingerprint secret of at least 32 characters

## Required Application Configuration

Use these non-secret environment variables:

```text
GCP_PROJECT_ID=project-ea4bb078-dabc-4178-84d
GCP_LOCATION=us-central1
GCS_BUCKET=project-ea4bb078-dabc-4178-84d-legacy-studio-media

GEMINI_STORY_MODEL=gemini-3.1-flash-lite
GEMINI_REQUIRE_PAID_PROJECT=true
GEMINI_PAID_PROJECT_VERIFIED=true
GEMINI_PAID_PROJECT_ID=project-ea4bb078-dabc-4178-84d

DEEPGRAM_TRANSCRIPTION_MODEL=nova-3
DEEPGRAM_NARRATION_MODEL=aura-2-arcas-en

OPENAI_AUDIT_MODEL=gpt-5.6

REMOTION_BUNDLE_PATH=/app/remotion-bundle
REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium

CLOUD_TASKS_QUEUE_PATH=projects/project-ea4bb078-dabc-4178-84d/locations/us-central1/queues/legacy-studio
CLOUD_TASKS_SERVICE_ACCOUNT=legacy-studio-tasks@project-ea4bb078-dabc-4178-84d.iam.gserviceaccount.com
```

After Cloud Run supplies the deployed service URL, set both of these to that URL:

```text
CLOUD_TASKS_TARGET_URL=<CLOUD_RUN_SERVICE_URL>
CLOUD_TASKS_AUDIENCE=<CLOUD_RUN_SERVICE_URL>
```

Required secret-backed variables:

```text
DATABASE_URL=legacy-studio-database-url:latest
GEMINI_API_KEY=legacy-studio-gemini-api-key:latest
DEEPGRAM_API_KEY=legacy-studio-deepgram-api-key:latest
OPENAI_API_KEY=legacy-studio-openai-api-key:latest
PROVIDER_FINGERPRINT_SECRET=legacy-studio-provider-fingerprint:latest
```

Optional Azure backup variables must be configured as a complete set or omitted as a complete set:

```text
AZURE_SPEECH_KEY
AZURE_SPEECH_REGION
AZURE_SPEECH_VOICE
AZURE_TTS_PRICE_MICROS_PER_MILLION_CHARS
```

## Work Remaining

1. Verify the active account, active project, existing resources, and IAM bindings.
2. Create a dedicated PostgreSQL database and restricted application user.
3. Construct a Cloud SQL-compatible `DATABASE_URL` for the Node `postgres` client through the attached Cloud SQL Unix socket.
4. Store that URL in `legacy-studio-database-url`.
5. Apply the existing Drizzle migrations using `npm run db:migrate`. Use a controlled one-time method such as the Cloud SQL Auth Proxy or an appropriately configured Cloud Run job; do not expose the database publicly just to run migrations.
6. Create the missing Secret Manager secrets and secret versions.
7. Verify whether `legacy-studio-openai-api-key` has a usable enabled version; add one if it does not.
8. Grant the runtime service account access only to the secrets required by the application.
9. Build the existing container using `cloudbuild.yaml`.
10. Push the image to `us-central1-docker.pkg.dev/project-ea4bb078-dabc-4178-84d/legacy-studio/legacy-studio:latest`.
11. Deploy Cloud Run service `legacy-studio` with:
    - Runtime service account listed above
    - Cloud SQL instance attachment
    - 4 GiB memory
    - 2 CPUs
    - Concurrency 1
    - Timeout 900 seconds
    - Unauthenticated public access for the hackathon demo
12. Set the Cloud Tasks target URL and audience after the Cloud Run URL is known.
13. Grant the task service account `roles/run.invoker` on this Cloud Run service only.
14. Verify `/api/health`.
15. Perform one minimal upload -> processing -> film render -> MP4 download smoke test.
16. Report the final URL, exact resource state, expected ongoing costs, and all failed or deferred checks.

## Guardrails

- Do not touch the `the-helm-500416` project.
- Do not delete or recreate working resources merely to standardize them.
- Do not create additional services, databases, queues, buckets, VPCs, load balancers, monitoring stacks, or production-hardening infrastructure.
- Do not change application functionality or expand beyond the minimal Task 12 deployment.
- Do not commit, discard, reset, stash, or overwrite the existing uncommitted Task 12 work.
- Do not store credentials in repository files.
- Do not expose Cloud SQL through a public IP solely for migration convenience.
- Stop and ask the user before any destructive action or before enabling a resource with meaningful additional cost.

## Existing Deployment Command Shape

The repository contains `scripts/deploy.ps1`, which expects arguments in this form:

```powershell
powershell -File scripts/deploy.ps1 `
  -ProjectId project-ea4bb078-dabc-4178-84d `
  -RuntimeServiceAccount legacy-studio-runtime@project-ea4bb078-dabc-4178-84d.iam.gserviceaccount.com `
  -Bucket project-ea4bb078-dabc-4178-84d-legacy-studio-media `
  -CloudSqlInstance project-ea4bb078-dabc-4178-84d:us-central1:legacy-studio `
  -CloudTasksQueuePath projects/project-ea4bb078-dabc-4178-84d/locations/us-central1/queues/legacy-studio `
  -CloudTasksServiceAccount legacy-studio-tasks@project-ea4bb078-dabc-4178-84d.iam.gserviceaccount.com
```

Inspect the script before executing it. Confirm that its assumptions match the real GCP state and repair only deployment-specific issues necessary to complete the minimal deployment.

## Completion Standard

The handoff is complete only when:

- The existing application image builds successfully.
- Database migrations are applied.
- Cloud Run reaches a healthy ready state.
- `/api/health` succeeds.
- Cloud Tasks can authenticate to internal processing routes.
- A real MP4 can be rendered and downloaded through the deployed application, or the exact blocking failure is documented with evidence.
- The user receives the Cloud Run URL and a short cost/resource summary.
