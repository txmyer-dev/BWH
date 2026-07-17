# Deployed Workflow Repairs Design

**Date:** 2026-07-16  
**Status:** Draft for written review  
**Scope:** Repair four defects verified through the deployed GCP browser workflow.

## Problem statement

The deployed workflow can create and prepare a memory-film project, but four defects prevent a reliable end-to-end experience:

1. Project creation redirects to the container's internal `https://localhost:8080` origin.
2. Previously uploaded photographs are represented as empty slots after the project page is reopened.
3. Factuality-review copy names OpenAI even when the accepted deployment contract uses Google Gemini.
4. The synchronous 1080p Remotion render reaches the Cloud Run service's 900-second request limit, closes Chromium, and returns a 504 without producing a downloadable film.

The repair must preserve project ownership checks, private media storage, factuality approval gates, render determinism, and scale-to-zero billing.

## Chosen approach

Use small application fixes for the first three defects and move film rendering into an asynchronous Cloud Run Job. The web service will schedule and report render work; the job will perform the expensive render and persist its result.

The alternatives are rejected as follows:

- Keeping synchronous rendering and tuning Chromium still couples success to an HTTP deadline and repeats expensive work after client disconnects.
- Sending a Cloud Task to the same service removes the browser wait but retains a long HTTP dispatch and the service timeout/resource contention.
- An always-on worker pool adds idle cost that is unnecessary for the expected hackathon workload.

## Application repairs

### Project redirect

The create-project response will return status `303` with a relative `Location: /projects/{projectId}` header. A relative redirect does not depend on the request URL reconstructed behind the Cloud Run proxy and therefore cannot leak the container's internal origin.

The project identifier continues to come only from the successfully created project. No forwarded host header is trusted or copied into the response.

### Persisted asset hydration

The project page will request the existing asset inventory when it mounts. Persisted image assets will be mapped by `sequenceOrder` into the seven photograph slots independently of local `File` objects.

Each slot will distinguish:

- empty;
- locally selected/uploading;
- persisted and ready;
- persisted but still processing;
- failed.

Reopening or refreshing the page will therefore show the stored filename/label and status. A local replacement may temporarily override the persisted presentation while uploading; after completion the refreshed inventory becomes authoritative. Source text and source audio will use the same persisted-inventory principle where the API supplies them.

No private GCS object will be made public merely to display state. The page needs metadata for hydration, not unrestricted object URLs.

### Provider-consistent copy

Generic workflow instructions will say "configured factuality reviewer" or "story check" rather than hardcoding OpenAI or Gemini. The consent record remains the authoritative place that names the actual provider and data categories for the current deployment.

This prevents UI drift during provider changes while preserving explicit provider disclosure at consent time.

## Asynchronous rendering architecture

### State model

The existing `processing_jobs` table will also store jobs whose `job_type` is `render_film`. Existing fields provide the required lifecycle:

- `pending`: accepted but not yet claimed;
- `processing`: claimed by a job execution;
- `completed`: MP4 stored and project render metadata committed;
- `failed`: terminal attempt failed and a safe error code is available.

`attempt_count`, `processing_started_at`, `lease_token`, `lease_expires_at`, `last_error`, and timestamps support idempotency, stale-claim recovery, diagnostics, and controlled retry. The existing partial unique index on active project/job type prevents concurrent active renders for one project.

The storyboard's deterministic render manifest and the project's `rendered_film_object_key` remain the source of truth for reuse. If an identical manifest has already completed, no Cloud Run Job is launched.

### Web API

`POST /api/projects/{projectId}/render` will:

1. authenticate the project owner;
2. validate all existing film prerequisites;
3. return the completed/reused result immediately when the manifest is already stored;
4. create or reuse the project's active `render_film` record;
5. launch a Cloud Run Job execution for a newly created record;
6. return `202` with the render job identifier and normalized status.

If job launch fails, the database record is marked failed with a safe launch error so the UI is not left polling forever. Repeated POSTs are idempotent and never create parallel renders for the same project.

`GET /api/projects/{projectId}/render` will authenticate the owner and return one of:

- `idle` when no render was requested;
- `pending`;
- `processing`;
- `completed` with reuse metadata;
- `failed` with a safe retryable message.

The existing download endpoint remains responsible for issuing a short-lived signed URL after a completed render. Render status responses will not expose private object keys or internal exception text.

### Cloud Run Job execution

The same immutable container image will support both the Next.js service command and a render-job command. The build will emit and copy an executable JavaScript worker entry point into the production image; it will not depend on omitted development TypeScript tooling. A job execution receives only `PROJECT_ID` and `RENDER_JOB_ID` overrides. It does not receive an owner token and exposes no public endpoint.

The worker will:

1. claim the matching pending or stale `render_film` record using a database lease;
2. rebuild and validate the current deterministic manifest;
3. reuse an already completed matching render if one appeared concurrently;
4. run Remotion using the bundled composition and configured Chromium;
5. upload the MP4 to the existing private GCS bucket;
6. atomically persist the manifest, object key, render timestamp, and completed job status;
7. mark the job failed with a bounded safe code when rendering or persistence fails;
8. always remove temporary local artifacts.

The job process exits nonzero on failure so Cloud Run execution logs and metrics reflect the outcome. Database idempotency prevents a platform retry from publishing conflicting results.

### Browser behavior

Selecting **Prepare the gift** will enqueue the render and move the UI to a queued/preparing state. The page will poll render status with bounded backoff while it is open. On completion it requests the existing signed download URL and displays the MP4 link.

On page load, render status is fetched so refreshes and browser restarts resume the correct state. A terminal failure restores the action button and displays a retry option. Polling stops on completion, failure, component unmount, or authentication failure.

## Deployment and permissions

The deployment script will create or update a scale-to-zero Cloud Run Job from the same image as the service. The job will receive the existing database secret, bucket configuration, Cloud SQL attachment, Remotion bundle/browser settings, and a dedicated or explicitly approved runtime service account.

The web service identity needs permission to execute only the named render job. The job identity needs only:

- Cloud SQL connectivity and database credentials;
- read/write access to the project's private media bucket as already required by rendering;
- access to the secrets/configuration needed by the render path.

The job requires no unauthenticated ingress and no minimum instance. Service configuration will include the fully qualified render job name. Deployment updates the job before the service so newly deployed scheduling code always targets an existing compatible job.

## Error handling and observability

Logs will include structured project/job identifiers, lifecycle transitions, manifest hash, render duration, and bounded failure code, but no owner tokens, signed URLs, family narration, or raw provider payloads.

The UI will distinguish queue/launch failure, render failure, and expired download URL without exposing internal messages. A failed job may be retried through a new POST after the previous record becomes terminal. Stale processing leases may be reclaimed by a later execution.

## Testing strategy

Implementation will proceed test-first.

Automated coverage will include:

- route test proving project creation returns a relative redirect;
- UI/state tests proving persisted assets hydrate the proper slots and survive reload state;
- copy test preventing provider-specific factuality wording outside consent disclosure;
- render repository tests for create/reuse, active uniqueness, claiming, completion, failure, and stale-lease recovery;
- Cloud Run launcher tests for the exact job name and minimal environment overrides;
- POST/GET render route tests for ownership, prerequisite failure, `202`, reuse, launch failure, and normalized status;
- worker tests for claim loss, successful publication, renderer failure, cleanup, and idempotent retry;
- UI tests for polling, refresh recovery, completion/download, failure, retry, and polling cancellation;
- deployment-script assertions or review covering job update order, secrets, Cloud SQL, resources, and IAM assumptions.

The existing unit suite, typecheck, production build, and lint excluding generated Remotion bundle output must pass. A local renderer smoke test will validate the worker entry point before deployment.

## Rollout and deployed verification

The existing `processing_jobs` schema and active-job index already support `render_film`, so no database migration is planned.

1. Build and publish one immutable image.
2. Create/update the Cloud Run render job with scale-to-zero behavior.
3. Grant the service identity permission to execute that named job.
4. Deploy the web service configured with the render job name.
5. Verify health and inspect revision/job configuration.
6. Repeat the full deployed browser workflow from project creation through MP4 download.
7. Refresh during an active render to prove status recovery.
8. Confirm Cloud Run Job completion, private GCS output, signed download behavior, and absence of localhost/provider-copy regressions.

Rollback consists of redeploying the prior service revision. The additive processing-job usage is harmless to the old revision; the Cloud Run Job may remain undeployed or be disabled after rollback without affecting stored project data.

## Acceptance criteria

- Project creation stays on the deployed Cloud Run origin.
- Refreshing a project shows its persisted uploads in their original slots.
- Workflow copy never contradicts the provider disclosed by consent.
- Starting a render returns promptly and remains observable across page refreshes.
- One project cannot run duplicate active renders.
- A successful job produces a private MP4 and a working short-lived download link.
- A failed job terminates, records a safe failure, and can be retried.
- The complete deployed browser workflow succeeds on GCP hardware without a service request timeout.
- The render job has no idle instance cost and no public endpoint.
