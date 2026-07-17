# Deployed Workflow Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the deployed project redirect, persisted-upload display, factuality copy, and timed-out film render so the complete browser workflow succeeds on GCP.

**Architecture:** Keep the three UI/HTTP repairs local and move Remotion into an on-demand Cloud Run Job. The web service validates and enqueues idempotent `render_film` records, the job claims and completes them through Cloud SQL, and the browser polls owner-protected status until the existing signed-download endpoint is ready.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Drizzle/PostgreSQL, `@google-cloud/run`, Cloud Run Jobs, Cloud SQL, private GCS, Remotion, esbuild, PowerShell deployment scripts.

## Global Constraints

- Preserve project ownership checks and never expose owner tokens, private object keys, signed URLs in logs, family narration, or raw provider payloads.
- Generic workflow copy must use “configured factuality reviewer” or “story check”; explicit provider disclosure remains in the consent record.
- Render work must use a scale-to-zero Cloud Run Job with no public endpoint and no minimum instance.
- Only one `pending` or `processing` `render_film` job may exist per project.
- The same immutable image must contain the Next.js service, Remotion bundle, and compiled JavaScript worker entry point.
- The browser must recover render status after refresh and stop polling on completion, failure, unmount, or authentication failure.
- Implement every behavior test-first and preserve all existing tests.

---

### Task 1: Proxy-safe project redirect

**Files:**
- Create: `src/features/projects/project-redirect.ts`
- Test: `src/features/projects/project-redirect.test.ts`
- Modify: `src/app/api/projects/route.ts`

**Interfaces:**
- Produces: `projectRedirect(projectId: string, ownerToken: string): NextResponse`
- Consumes: the existing project ID and owner token returned by `ProjectService.createProject()`.

- [ ] **Step 1: Write the failing redirect test**

```ts
import {describe, expect, it} from 'vitest';
import {projectRedirect} from './project-redirect';

describe('projectRedirect', () => {
  it('uses a relative location and preserves the owner cookie', () => {
    const id = '315c5992-2b16-4a90-9788-bfe77dc5a15d';
    const response = projectRedirect(id, 'owner-secret');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/projects/${id}`);
    expect(response.headers.get('set-cookie')).toContain(`legacy_owner_${id}=owner-secret`);
    expect(response.headers.get('location')).not.toContain('localhost');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/features/projects/project-redirect.test.ts`  
Expected: FAIL because `./project-redirect` does not exist.

- [ ] **Step 3: Implement the relative response helper and use it in the route**

```ts
// src/features/projects/project-redirect.ts
import {NextResponse} from 'next/server';

export const projectRedirect = (projectId: string, ownerToken: string) => {
  const response = new NextResponse(null, {
    status: 303,
    headers: {Location: `/projects/${projectId}`}
  });
  response.cookies.set(`legacy_owner_${projectId}`, ownerToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
  return response;
};
```

Replace the `NextResponse.redirect(new URL(...))` block in `src/app/api/projects/route.ts` with:

```ts
return projectRedirect(created.projectId, created.ownerToken);
```

Import `projectRedirect` and remove the now-unused `NextResponse` import only if JSON error responses are changed to the global `Response`; otherwise retain it.

- [ ] **Step 4: Run the focused and project tests**

Run: `npx vitest run src/features/projects/project-redirect.test.ts src/features/projects/project-service.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/features/projects/project-redirect.ts src/features/projects/project-redirect.test.ts src/app/api/projects/route.ts
git commit -m "fix: keep project redirect on deployed origin"
```

### Task 2: Persisted asset slot hydration

**Files:**
- Create: `src/features/media/asset-slot-state.ts`
- Test: `src/features/media/asset-slot-state.test.ts`
- Modify: `src/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Produces: `PersistedAssetSummary`, `ImageSlot`, `hydrateImageSlots(assets, count)`, and `mergeLocalImageDraft(slot, draft)`.
- Consumes: the existing owner-protected `GET /api/projects/{projectId}/assets/upload-url` response.

- [ ] **Step 1: Write failing slot-mapping tests**

```ts
import {describe, expect, it} from 'vitest';
import {hydrateImageSlots} from './asset-slot-state';

describe('hydrateImageSlots', () => {
  it('maps persisted images by sequence and leaves missing positions empty', () => {
    const slots = hydrateImageSlots([
      {id: 'b', kind: 'image', processingStatus: 'ready', caption: 'Second', sequenceOrder: 1},
      {id: 'a', kind: 'image', processingStatus: 'processing', caption: null, sequenceOrder: 0},
      {id: 'text', kind: 'text', processingStatus: 'ready', caption: null, sequenceOrder: 0}
    ], 3);
    expect(slots).toEqual([
      {kind: 'persisted', assetId: 'a', status: 'processing', label: 'Photograph 1'},
      {kind: 'persisted', assetId: 'b', status: 'ready', label: 'Second'},
      {kind: 'empty'}
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/features/media/asset-slot-state.test.ts`  
Expected: FAIL because `asset-slot-state.ts` does not exist.

- [ ] **Step 3: Implement the pure hydration model**

```ts
export type PersistedAssetSummary = {
  id: string;
  kind: string;
  processingStatus: string;
  caption: string|null;
  sequenceOrder: number;
};

export type ImageSlot =
  | {kind: 'empty'}
  | {kind: 'persisted'; assetId: string; status: string; label: string};

export const hydrateImageSlots = (assets: PersistedAssetSummary[], count = 7): ImageSlot[] => {
  const slots: ImageSlot[] = Array.from({length: count}, () => ({kind: 'empty'}));
  for (const asset of assets) {
    if (asset.kind !== 'image' || asset.sequenceOrder < 0 || asset.sequenceOrder >= count) continue;
    slots[asset.sequenceOrder] = {
      kind: 'persisted',
      assetId: asset.id,
      status: asset.processingStatus,
      label: asset.caption?.trim() || `Photograph ${asset.sequenceOrder + 1}`
    };
  }
  return slots;
};
```

- [ ] **Step 4: Hydrate the project page from the existing inventory endpoint**

Add state and a reusable refresh function in `page.tsx`:

```tsx
const [persistedImageSlots, setPersistedImageSlots] = useState<ImageSlot[]>(() => hydrateImageSlots([], 7));

const refreshAssetInventory = useCallback(async () => {
  const response = await fetch(`/api/projects/${projectId}/assets/upload-url`);
  if (!response.ok) throw new Error('ASSET_INVENTORY_FAILED');
  const assets = await response.json() as PersistedAssetSummary[];
  setPersistedImageSlots(hydrateImageSlots(assets, 7));
  return assets;
}, [projectId]);

useEffect(() => {
  void refreshAssetInventory().catch(() => setMessage('Your saved uploads could not be refreshed yet.'));
}, [refreshAssetInventory]);
```

After a successful upload `PATCH`, call `await refreshAssetInventory()`. In the seven-slot render, prefer the local draft while it has a selected file; otherwise render the persisted slot label/status and use `aria-label={`Saved photograph slot ${index + 1}`}`. Only use `Empty photograph slot` when both states are empty.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/features/media/asset-slot-state.test.ts && npm run typecheck`  
Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```powershell
git add -- src/features/media/asset-slot-state.ts src/features/media/asset-slot-state.test.ts 'src/app/projects/[projectId]/page.tsx'
git commit -m "fix: hydrate persisted project uploads"
```

### Task 3: Provider-consistent factuality copy

**Files:**
- Create: `src/features/audit/audit-copy.ts`
- Test: `src/features/audit/audit-copy.test.ts`
- Modify: `src/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Produces: `FACTUALITY_REVIEW_COPY` and `CREATOR_AUDIO_REVIEW_COPY`.
- Consumes: no provider-specific runtime value; the consent UI remains authoritative for provider identity.

- [ ] **Step 1: Write the failing copy contract test**

```ts
import {describe, expect, it} from 'vitest';
import {CREATOR_AUDIO_REVIEW_COPY, FACTUALITY_REVIEW_COPY} from './audit-copy';

describe('factuality workflow copy', () => {
  it('does not hardcode a provider outside consent disclosure', () => {
    const copy = `${FACTUALITY_REVIEW_COPY} ${CREATOR_AUDIO_REVIEW_COPY}`;
    expect(copy).toContain('configured factuality reviewer');
    expect(copy).not.toMatch(/OpenAI|Gemini/);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/features/audit/audit-copy.test.ts`  
Expected: FAIL because `audit-copy.ts` does not exist.

- [ ] **Step 3: Add canonical copy and replace both contradictory paragraphs**

```ts
export const FACTUALITY_REVIEW_COPY =
  'Only the narration and the family details you approved are sent to the configured factuality reviewer for this story check.';

export const CREATOR_AUDIO_REVIEW_COPY =
  'Your recording is transcribed with Deepgram Nova-3, then its exact transcript is checked against the approved family record by the configured factuality reviewer before it can be selected.';
```

Import and render these constants in the final-review and creator-recording sections. Do not alter the consent list that explicitly identifies the current Gemini deployment and OpenAI as an alternate.

- [ ] **Step 4: Run the copy test and scan the page**

Run: `npx vitest run src/features/audit/audit-copy.test.ts; rg -n "sent to OpenAI|record by OpenAI" 'src/app/projects/[projectId]/page.tsx'`  
Expected: test PASS; `rg` returns no matches.

- [ ] **Step 5: Commit**

```powershell
git add -- src/features/audit/audit-copy.ts src/features/audit/audit-copy.test.ts 'src/app/projects/[projectId]/page.tsx'
git commit -m "fix: keep factuality provider copy consistent"
```

### Task 4: Durable render-job repository

**Files:**
- Create: `src/features/film/render-job-repository.ts`
- Test: `src/features/film/render-job-repository.test.ts`
- Modify: `src/features/story/story-service.ts`
- Modify: `src/features/story/story-invalidation.test.ts`

**Interfaces:**
- Produces:
  - `RenderJobStatus = 'pending'|'processing'|'completed'|'failed'|'superseded'`
  - `RenderJobRecord`
  - `RenderJobRepository.request(projectId): Promise<{job: RenderJobRecord; created: boolean}>`
  - `latest(projectId)`, `claim(jobId, projectId, now, leaseMs)`, `complete(jobId, leaseToken)`, `fail(jobId, leaseToken, code)`, `failPendingLaunch(jobId, code)`, `supersedeProject(projectId)`.
- Consumes: `processingJobs` and its existing active `(projectId, jobType)` partial unique index.

- [ ] **Step 1: Write failing in-memory lifecycle tests**

```ts
import {describe, expect, it} from 'vitest';
import {InMemoryRenderJobRepository} from './render-job-repository';

describe('render job lifecycle', () => {
  it('deduplicates active requests and completes only the lease owner', async () => {
    const repository = new InMemoryRenderJobRepository();
    const first = await repository.request('project');
    const duplicate = await repository.request('project');
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({created: false, job: {id: first.job.id}});
    const claim = await repository.claim(first.job.id, 'project', new Date('2026-07-16T12:00:00Z'), 3_600_000);
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') throw new Error('expected claim');
    await expect(repository.complete(first.job.id, crypto.randomUUID())).rejects.toThrow('RENDER_JOB_LEASE_LOST');
    await repository.complete(first.job.id, claim.job.leaseToken!);
    expect(await repository.latest('project')).toMatchObject({status: 'completed'});
  });

  it('reclaims an expired processing lease and allows retry after failure', async () => {
    const repository = new InMemoryRenderJobRepository();
    const {job} = await repository.request('project');
    await repository.claim(job.id, 'project', new Date('2026-07-16T12:00:00Z'), 1_000);
    expect((await repository.claim(job.id, 'project', new Date('2026-07-16T12:00:02Z'), 1_000)).outcome).toBe('claimed');
  });

  it('keeps an old render terminal after it is superseded', async () => {
    const repository = new InMemoryRenderJobRepository();
    const {job} = await repository.request('project');
    await repository.supersedeProject('project');
    expect(await repository.latest('project')).toMatchObject({id: job.id, status: 'superseded', lastError: 'RENDER_SUPERSEDED'});
    expect((await repository.request('project')).created).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/features/film/render-job-repository.test.ts`  
Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement the interface, in-memory repository, and PostgreSQL repository**

```ts
import {randomUUID} from 'node:crypto';
import {and, desc, eq, inArray, lte, or, sql} from 'drizzle-orm';
import type {Database} from '../../server/db/client';
import {processingJobs} from '../../server/db/schema';

export type RenderJobStatus = 'pending'|'processing'|'completed'|'failed'|'superseded';
export type RenderJobRecord = {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  attemptCount: number;
  processingStartedAt: Date|null;
  leaseExpiresAt: Date|null;
  leaseToken: string|null;
  lastError: string|null;
};

export type RenderJobClaim =
  | {outcome: 'claimed'; job: RenderJobRecord}
  | {outcome: 'busy'|'missing'};

export interface RenderJobRepository {
  request(projectId: string): Promise<{job: RenderJobRecord; created: boolean}>;
  latest(projectId: string): Promise<RenderJobRecord|undefined>;
  claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim>;
  complete(jobId: string, leaseToken: string): Promise<void>;
  fail(jobId: string, leaseToken: string, code: string): Promise<void>;
  failPendingLaunch(jobId: string, code: string): Promise<void>;
  supersedeProject(projectId: string): Promise<void>;
}

const mapRow = (row: typeof processingJobs.$inferSelect): RenderJobRecord => ({
  id: row.id, projectId: row.projectId, status: row.status as RenderJobStatus,
  attemptCount: row.attemptCount, processingStartedAt: row.processingStartedAt,
  leaseExpiresAt: row.leaseExpiresAt, leaseToken: row.leaseToken, lastError: row.lastError
});

export class PostgresRenderJobRepository implements RenderJobRepository {
  constructor(private readonly database: Database) {}

  async latest(projectId: string) {
    const row = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: same}) => all(same(table.projectId, projectId), same(table.jobType, 'render_film')),
      orderBy: (table, {desc: newest}) => [newest(table.createdAt)]
    });
    return row ? mapRow(row) : undefined;
  }

  async request(projectId: string) {
    const active = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: same, inArray: oneOf}) => all(same(table.projectId, projectId), same(table.jobType, 'render_film'), oneOf(table.status, ['pending', 'processing']))
    });
    if (active) return {job: mapRow(active), created: false};
    const [created] = await this.database.insert(processingJobs).values({id: randomUUID(), projectId, jobType: 'render_film'}).onConflictDoNothing().returning();
    if (created) return {job: mapRow(created), created: true};
    const winner = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: same, inArray: oneOf}) => all(same(table.projectId, projectId), same(table.jobType, 'render_film'), oneOf(table.status, ['pending', 'processing']))
    });
    if (!winner) throw new Error('RENDER_JOB_CREATE_FAILED');
    return {job: mapRow(winner), created: false};
  }

  async claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim> {
    const leaseToken = randomUUID();
    const [claimed] = await this.database.update(processingJobs).set({
      status: 'processing', leaseToken, processingStartedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      attemptCount: sql`${processingJobs.attemptCount} + 1`, updatedAt: now
    }).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.jobType, 'render_film'), or(
      eq(processingJobs.status, 'pending'),
      and(eq(processingJobs.status, 'processing'), lte(processingJobs.leaseExpiresAt, now))
    ))).returning();
    if (claimed) return {outcome: 'claimed', job: mapRow(claimed)};
    const existing = await this.latest(projectId);
    return !existing || existing.id !== jobId ? {outcome: 'missing'} : {outcome: 'busy'};
  }

  async complete(jobId: string, leaseToken: string) {
    const [row] = await this.database.update(processingJobs).set({status: 'completed', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'render_film'), eq(processingJobs.status, 'processing'), eq(processingJobs.leaseToken, leaseToken))).returning({id: processingJobs.id});
    if (!row) throw new Error('RENDER_JOB_LEASE_LOST');
  }

  async fail(jobId: string, leaseToken: string, code: string) {
    const [row] = await this.database.update(processingJobs).set({status: 'failed', lastError: code, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'render_film'), eq(processingJobs.status, 'processing'), eq(processingJobs.leaseToken, leaseToken))).returning({id: processingJobs.id});
    if (!row) throw new Error('RENDER_JOB_LEASE_LOST');
  }

  async failPendingLaunch(jobId: string, code: string) {
    await this.database.update(processingJobs).set({status: 'failed', lastError: code, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'render_film'), eq(processingJobs.status, 'pending')));
  }
  async supersedeProject(projectId: string) {
    await this.database.update(processingJobs).set({status: 'superseded', leaseToken: null, leaseExpiresAt: null, lastError: 'RENDER_SUPERSEDED', updatedAt: new Date()}).where(and(eq(processingJobs.projectId, projectId), eq(processingJobs.jobType, 'render_film'), inArray(processingJobs.status, ['pending', 'processing', 'completed'])));
  }
}
```

- [ ] **Step 4: Implement the in-memory repository with the same transition rules**

```ts
export class InMemoryRenderJobRepository implements RenderJobRepository {
  private readonly rows = new Map<string, RenderJobRecord>();
  async latest(projectId: string) {
    return [...this.rows.values()].filter((row) => row.projectId === projectId).at(-1);
  }
  async request(projectId: string) {
    const active = [...this.rows.values()].find((row) => row.projectId === projectId && ['pending', 'processing'].includes(row.status));
    if (active) return {job: structuredClone(active), created: false};
    const job: RenderJobRecord = {id: randomUUID(), projectId, status: 'pending', attemptCount: 0, processingStartedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: null};
    this.rows.set(job.id, job);
    return {job: structuredClone(job), created: true};
  }
  async claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim> {
    const row = this.rows.get(jobId);
    if (!row || row.projectId !== projectId) return {outcome: 'missing'};
    if (row.status === 'processing' && (!row.leaseExpiresAt || row.leaseExpiresAt > now)) return {outcome: 'busy'};
    if (row.status !== 'pending' && row.status !== 'processing') return {outcome: 'busy'};
    const claimed = {...row, status: 'processing' as const, attemptCount: row.attemptCount + 1, processingStartedAt: now, leaseExpiresAt: new Date(now.getTime() + leaseMs), leaseToken: randomUUID()};
    this.rows.set(jobId, claimed);
    return {outcome: 'claimed', job: structuredClone(claimed)};
  }
  async complete(jobId: string, leaseToken: string) { this.transition(jobId, leaseToken, 'completed', null); }
  async fail(jobId: string, leaseToken: string, code: string) { this.transition(jobId, leaseToken, 'failed', code); }
  async failPendingLaunch(jobId: string, code: string) {
    const row = this.rows.get(jobId);
    if (row?.status === 'pending') this.rows.set(jobId, {...row, status: 'failed', lastError: code});
  }
  async supersedeProject(projectId: string) {
    for (const [id, row] of this.rows) if (row.projectId === projectId && ['pending', 'processing', 'completed'].includes(row.status)) this.rows.set(id, {...row, status: 'superseded', leaseToken: null, leaseExpiresAt: null, lastError: 'RENDER_SUPERSEDED'});
  }
  private transition(jobId: string, leaseToken: string, status: 'completed'|'failed', lastError: string|null) {
    const row = this.rows.get(jobId);
    if (!row || row.status !== 'processing' || row.leaseToken !== leaseToken) throw new Error('RENDER_JOB_LEASE_LOST');
    this.rows.set(jobId, {...row, status, lastError, leaseToken: null, leaseExpiresAt: null});
  }
}
```

- [ ] **Step 5: Supersede old render jobs in the invalidation transaction**

In `invalidateDownstreamStoryState()`, add this update to the same transaction that clears `projects.renderedFilmObjectKey`:

```ts
await transaction.update(processingJobs).set({
  status: 'superseded', leaseToken: null, leaseExpiresAt: null,
  lastError: 'RENDER_SUPERSEDED', updatedAt: new Date()
}).where(and(
  eq(processingJobs.projectId, projectId), eq(processingJobs.jobType, 'render_film'),
  inArray(processingJobs.status, ['pending', 'processing', 'completed'])
));
```

Extend `story-invalidation.test.ts` to import `processingJobs`, record its update, and assert `{status:'superseded', leaseToken:null, leaseExpiresAt:null, lastError:'RENDER_SUPERSEDED'}`. This proves the old render is retired atomically with the object-key invalidation.

- [ ] **Step 6: Run focused tests and typecheck the PostgreSQL implementation**

Run: `npx vitest run src/features/film/render-job-repository.test.ts src/features/story/story-invalidation.test.ts && npm run typecheck`
Expected: PASS with no Drizzle or TypeScript errors.

- [ ] **Step 7: Commit**

```powershell
git add -- src/features/film/render-job-repository.ts src/features/film/render-job-repository.test.ts src/features/story/story-service.ts src/features/story/story-invalidation.test.ts
git commit -m "feat: persist asynchronous render jobs"
```

### Task 5: Cloud Run Job launcher and environment contract

**Files:**
- Create: `src/features/film/cloud-run-render-launcher.ts`
- Test: `src/features/film/cloud-run-render-launcher.test.ts`
- Modify: `src/server/env.ts`
- Modify: `src/server/env.test.ts`

**Interfaces:**
- Produces: `RenderJobLauncher.launch({projectId, jobId}): Promise<void>` and `CloudRunRenderJobLauncher`.
- Consumes: `GCP_PROJECT_ID`, `GCP_LOCATION`, and `RENDER_JOB_NAME`.

- [ ] **Step 1: Write the failing launcher test**

```ts
import {describe, expect, it, vi} from 'vitest';
import {CloudRunRenderJobLauncher} from './cloud-run-render-launcher';

it('starts the named job with only project and render job identifiers', async () => {
  const runJob = vi.fn().mockResolvedValue([{}]);
  const launcher = new CloudRunRenderJobLauncher(
    {runJob} as never,
    'projects/demo/locations/us-central1/jobs/legacy-studio-render'
  );
  await launcher.launch({projectId: 'project-id', jobId: 'job-id'});
  expect(runJob).toHaveBeenCalledWith({
    name: 'projects/demo/locations/us-central1/jobs/legacy-studio-render',
    overrides: {containerOverrides: [{env: [
      {name: 'PROJECT_ID', value: 'project-id'},
      {name: 'RENDER_JOB_ID', value: 'job-id'}
    ]}]}
  });
});
```

- [ ] **Step 2: Run the launcher test and verify RED**

Run: `npx vitest run src/features/film/cloud-run-render-launcher.test.ts`  
Expected: FAIL because the launcher module does not exist.

- [ ] **Step 3: Implement the launcher**

```ts
import {JobsClient} from '@google-cloud/run';

export interface RenderJobLauncher {
  launch(input: {projectId: string; jobId: string}): Promise<void>;
}

export class CloudRunRenderJobLauncher implements RenderJobLauncher {
  constructor(private readonly client: Pick<JobsClient, 'runJob'>, private readonly name: string) {}
  async launch({projectId, jobId}: {projectId: string; jobId: string}) {
    await this.client.runJob({name: this.name, overrides: {containerOverrides: [{env: [
      {name: 'PROJECT_ID', value: projectId},
      {name: 'RENDER_JOB_ID', value: jobId}
    ]}]}});
  }
}

export const renderJobResourceName = (env: {GCP_PROJECT_ID: string; GCP_LOCATION: string; RENDER_JOB_NAME: string}) =>
  env.RENDER_JOB_NAME.startsWith('projects/')
    ? env.RENDER_JOB_NAME
    : `projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/jobs/${env.RENDER_JOB_NAME}`;
```

- [ ] **Step 4: Tighten and test the environment field**

Keep `RENDER_JOB_NAME` defaulting to `legacy-studio-render`, add an env test that `renderJobResourceName(parseEnv(...))` resolves the fully qualified name, and ensure production parsing still fails closed on missing existing secrets.

- [ ] **Step 5: Run launcher and env tests**

Run: `npx vitest run src/features/film/cloud-run-render-launcher.test.ts src/server/env.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- src/features/film/cloud-run-render-launcher.ts src/features/film/cloud-run-render-launcher.test.ts src/server/env.ts src/server/env.test.ts
git commit -m "feat: launch render work on Cloud Run Jobs"
```

### Task 6: Render coordinator and owner-protected status API

**Files:**
- Create: `src/features/film/render-coordinator.ts`
- Test: `src/features/film/render-coordinator.test.ts`
- Modify: `src/app/api/projects/[projectId]/render/route.ts`
- Test: `src/app/api/projects/[projectId]/render/route.test.ts`

**Interfaces:**
- Produces: `RenderCoordinator.request(projectId)` and `RenderCoordinator.status(projectId)`.
- Consumes: `FilmRepository`, `RenderJobRepository`, `RenderJobLauncher`, and owner assertion.

- [ ] **Step 1: Write failing coordinator tests for reuse, enqueue, deduplication, and launch failure**

```ts
it('returns promptly after scheduling one new render', async () => {
  const result = await coordinator.request(projectId);
  expect(result).toMatchObject({status: 'pending', created: true});
  expect(launcher.launch).toHaveBeenCalledTimes(1);
});

it('does not launch a duplicate active render', async () => {
  await coordinator.request(projectId);
  await coordinator.request(projectId);
  expect(launcher.launch).toHaveBeenCalledTimes(1);
});

it('marks a pending record failed when launch is rejected', async () => {
  launcher.launch.mockRejectedValueOnce(new Error('internal detail'));
  await expect(coordinator.request(projectId)).rejects.toThrow('RENDER_JOB_LAUNCH_FAILED');
  expect(await jobs.latest(projectId)).toMatchObject({status: 'failed', lastError: 'RENDER_JOB_LAUNCH_FAILED'});
});
```

Use the existing film fixture from `render-service.test.ts`; assert owner checking happens before source loading.

- [ ] **Step 2: Run the coordinator tests and verify RED**

Run: `npx vitest run src/features/film/render-coordinator.test.ts`  
Expected: FAIL because `render-coordinator.ts` does not exist.

- [ ] **Step 3: Implement the coordinator**

```ts
import type {FilmRepository} from './render-service';
import {buildRenderManifest} from './manifest';
import type {RenderJobLauncher} from './cloud-run-render-launcher';
import type {RenderJobRepository} from './render-job-repository';

const publicError = (error: string|null) => {
  if (error === 'RENDER_JOB_LAUNCH_FAILED' || error === 'RENDER_SUPERSEDED') return error;
  return error ? 'RENDER_EXECUTION_FAILED' : undefined;
};

export class RenderCoordinator {
  constructor(
    private readonly films: FilmRepository,
    private readonly jobs: RenderJobRepository,
    private readonly launcher: RenderJobLauncher,
    private readonly assertOwner: (projectId: string) => Promise<void>
  ) {}

  async request(projectId: string) {
    await this.assertOwner(projectId);
    const manifest = buildRenderManifest(await this.films.loadSource(projectId));
    const completed = await this.films.findCompleted(projectId, manifest.manifestHash);
    if (completed) return {status: 'completed' as const, manifestHash: manifest.manifestHash, reused: true as const};
    const requested = await this.jobs.request(projectId);
    if (requested.created) {
      try {
        await this.launcher.launch({projectId, jobId: requested.job.id});
      } catch {
        await this.jobs.failPendingLaunch(requested.job.id, 'RENDER_JOB_LAUNCH_FAILED');
        throw new Error('RENDER_JOB_LAUNCH_FAILED');
      }
    }
    return {jobId: requested.job.id, status: requested.job.status, attemptCount: requested.job.attemptCount, created: requested.created};
  }

  async status(projectId: string) {
    await this.assertOwner(projectId);
    const job = await this.jobs.latest(projectId);
    if (!job) return {status: 'idle' as const};
    return {jobId: job.id, status: job.status, attemptCount: job.attemptCount, ...(publicError(job.lastError) ? {error: publicError(job.lastError)} : {})};
  }
}
```

- [ ] **Step 4: Write failing POST/GET route tests**

Export `createRenderHandlers(coordinator)` from the route module so the test can inject a coordinator without a database, cookie store, or Google client. Assert:

```ts
expect((await POST(request, context)).status).toBe(202);
expect(await (await GET(request, context)).json()).toEqual({
  jobId: expect.any(String), status: 'pending', attemptCount: 0
});
```

Also assert 200 for completed reuse, 403 for owner failure, 409 for existing film prerequisite errors, and 502 with `{error:'RENDER_JOB_LAUNCH_FAILED'}` for launch rejection.

- [ ] **Step 5: Replace synchronous route construction**

```ts
export const createRenderHandlers = (coordinator: Pick<RenderCoordinator, 'request'|'status'>) => ({
  POST: async (_request: Request, context: Context) => {
    try {
      const result = await coordinator.request((await context.params).projectId);
      return NextResponse.json(result, {status: result.status === 'completed' ? 200 : 202});
    } catch (error) {
      const safe = safeFilmRouteError(error);
      return NextResponse.json({error: safe.code}, {status: safe.status});
    }
  },
  GET: async (_request: Request, context: Context) => {
    try {
      return NextResponse.json(await coordinator.status((await context.params).projectId));
    } catch (error) {
      const safe = safeFilmRouteError(error);
      return NextResponse.json({error: safe.code}, {status: safe.status});
    }
  }
});
```

The production `coordinator()` factory reads the owner cookie, parses env, and constructs `PostgresFilmRepository`, `PostgresRenderJobRepository`, and `CloudRunRenderJobLauncher(new JobsClient(), renderJobResourceName(env))`. Export `POST` and `GET` as thin calls through `createRenderHandlers(await coordinator(projectId))`. Add `RENDER_JOB_LAUNCH_FAILED: 502` to `safeFilmRouteError()`; retain existing 403/409 mappings.

- [ ] **Step 6: Run coordinator and route tests**

Run: `npx vitest run src/features/film/render-coordinator.test.ts 'src/app/api/projects/[projectId]/render/route.test.ts' src/features/film/route-errors.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/features/film/render-coordinator.ts src/features/film/render-coordinator.test.ts 'src/app/api/projects/[projectId]/render/route.ts' 'src/app/api/projects/[projectId]/render/route.test.ts' src/features/film/route-errors.ts src/features/film/route-errors.test.ts
git commit -m "feat: expose asynchronous render status"
```

### Task 7: Compiled render worker and immutable image

**Files:**
- Create: `src/workers/render-film.ts`
- Create: `src/features/film/render-worker.ts`
- Test: `src/features/film/render-worker.test.ts`
- Create: `scripts/build-worker.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`
- Modify: `src/server/env.ts`
- Modify: `src/server/env.test.ts`

**Interfaces:**
- Produces: `RenderWorker.run({projectId, jobId}): Promise<void>` and `/app/dist/render-film.mjs`.
- Consumes: `RenderJobRepository`, `FilmRenderService`, `PROJECT_ID`, and `RENDER_JOB_ID`.

- [ ] **Step 1: Write failing worker lifecycle tests**

```ts
it('claims, renders, and completes a job', async () => {
  await worker.run({projectId, jobId});
  expect(render).toHaveBeenCalledWith(projectId);
  expect(await jobs.latest(projectId)).toMatchObject({status: 'completed'});
});

it('records a bounded failure and rejects so Cloud Run marks the execution failed', async () => {
  render.mockRejectedValueOnce(new Error('Chromium included private filesystem detail'));
  await expect(worker.run({projectId, jobId})).rejects.toThrow('RENDER_EXECUTION_FAILED');
  expect(await jobs.latest(projectId)).toMatchObject({status: 'failed', lastError: 'RENDER_EXECUTION_FAILED'});
});

it('does nothing when another execution owns an unexpired lease', async () => {
  await expect(worker.run({projectId, jobId})).resolves.toBeUndefined();
  expect(render).not.toHaveBeenCalled();
});

it('does not overwrite a superseded state when edits race a render', async () => {
  render.mockImplementationOnce(async () => { await jobs.supersedeProject(projectId); });
  await expect(worker.run({projectId, jobId})).rejects.toThrow('RENDER_SUPERSEDED');
  expect(await jobs.latest(projectId)).toMatchObject({status: 'superseded'});
});
```

- [ ] **Step 2: Run worker tests and verify RED**

Run: `npx vitest run src/features/film/render-worker.test.ts`  
Expected: FAIL because the worker module does not exist.

- [ ] **Step 3: Implement the worker orchestration**

```ts
export class RenderWorker {
  constructor(
    private readonly jobs: RenderJobRepository,
    private readonly render: (projectId: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 3_600_000
  ) {}

  async run({projectId, jobId}: {projectId: string; jobId: string}) {
    const claim = await this.jobs.claim(jobId, projectId, this.now(), this.leaseMs);
    if (claim.outcome === 'busy') return;
    if (claim.outcome === 'missing') throw new Error('RENDER_JOB_NOT_FOUND');
    try {
      await this.render(projectId);
      await this.jobs.complete(jobId, claim.job.leaseToken!);
    } catch {
      const latest = await this.jobs.latest(projectId);
      if (latest?.id === jobId && latest.status === 'superseded') throw new Error('RENDER_SUPERSEDED');
      await this.jobs.fail(jobId, claim.job.leaseToken!, 'RENDER_EXECUTION_FAILED');
      throw new Error('RENDER_EXECUTION_FAILED');
    }
  }
}
```

- [ ] **Step 4: Add the production entry point**

```ts
import {resolve} from 'node:path';
import {z} from 'zod';
import {factualityAuditDeployment} from '@/features/audit/audit-deployment';
import {RemotionFilmRenderer, FilmRenderService, PostgresFilmRepository} from '@/features/film/render-service';
import {PostgresRenderJobRepository} from '@/features/film/render-job-repository';
import {RenderWorker} from '@/features/film/render-worker';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresNarrationRepository} from '@/features/narration/narration-repository';
import {getDatabase} from '@/server/db/client';
import {parseRenderWorkerEnv} from '@/server/env';

const input = z.object({PROJECT_ID: z.string().uuid(), RENDER_JOB_ID: z.string().uuid()}).parse(process.env);
const env = parseRenderWorkerEnv(process.env);
const database = getDatabase();
const storage = new GcsMediaStorage(env.GCS_BUCKET);
const narration = new PostgresNarrationRepository(database, factualityAuditDeployment(env).contract, env.DEEPGRAM_TRANSCRIPTION_MODEL);
const films = new FilmRenderService(
  new PostgresFilmRepository(database, narration),
  storage,
  new RemotionFilmRenderer({bundlePath: resolve(env.REMOTION_BUNDLE_PATH), browserExecutable: env.REMOTION_BROWSER_EXECUTABLE, concurrency: env.REMOTION_CONCURRENCY}),
  async () => undefined
);
const worker = new RenderWorker(new PostgresRenderJobRepository(database), (projectId) => films.render(projectId));

console.info(JSON.stringify({event: 'render_job_started', projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID}));
worker.run({projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID}).then(
  () => console.info(JSON.stringify({event: 'render_job_finished', projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID})),
  () => {
    console.error(JSON.stringify({event: 'render_job_failed', projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID, code: 'RENDER_EXECUTION_FAILED'}));
    process.exitCode = 1;
  }
);
```

Add this least-privilege parser to `src/server/env.ts` and test that it succeeds in production without `PROVIDER_FINGERPRINT_SECRET`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`:

```ts
const renderWorkerSchema = z.object({
  DATABASE_URL: z.string().url(),
  GCS_BUCKET: z.string().min(1),
  FACTUALITY_AUDIT_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
  GEMINI_STORY_MODEL: z.string().min(1).default('gemini-3.1-flash-lite'),
  OPENAI_AUDIT_MODEL: z.string().min(1).default('gpt-5.6'),
  DEEPGRAM_TRANSCRIPTION_MODEL: z.string().min(1).default('nova-3'),
  REMOTION_BUNDLE_PATH: z.string().min(1).default('remotion-bundle'),
  REMOTION_BROWSER_EXECUTABLE: z.string().min(1).optional(),
  REMOTION_CONCURRENCY: z.coerce.number().int().positive().default(4)
});

export const parseRenderWorkerEnv = (input: NodeJS.ProcessEnv) => renderWorkerSchema.parse(input);
```

- [ ] **Step 5: Build the worker artifact explicitly**

Add `esbuild` as a pinned dev dependency and create:

```js
// scripts/build-worker.mjs
import {build} from 'esbuild';
await build({
  entryPoints: ['src/workers/render-film.ts'],
  outfile: 'dist/render-film.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true
});
```

Change `build` to `next build && npm run film:bundle && npm run worker:build` and add `"worker:build": "node scripts/build-worker.mjs"`.

- [ ] **Step 6: Copy and smoke-test the worker in the production image**

Add `COPY --from=builder --chown=node:node /app/dist ./dist` to the runner stage. Build with:

Run: `npm run build; Test-Path dist/render-film.mjs`  
Expected: build succeeds and prints `True`.

- [ ] **Step 7: Run worker, renderer, and type tests**

Run: `npx vitest run src/features/film/render-worker.test.ts src/features/film/render-service.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add -- src/workers/render-film.ts src/features/film/render-worker.ts src/features/film/render-worker.test.ts scripts/build-worker.mjs package.json package-lock.json Dockerfile src/server/env.ts src/server/env.test.ts
git commit -m "feat: run film rendering as a compiled worker"
```

### Task 8: Refresh-safe browser polling

**Files:**
- Modify: `src/features/film/film-ui-state.ts`
- Modify: `src/features/film/film-ui-state.test.ts`
- Create: `src/features/film/render-polling.ts`
- Test: `src/features/film/render-polling.test.ts`
- Modify: `src/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Produces: UI statuses `idle|pending|processing|ready|failed|superseded`, `applyRenderStatus()`, and `pollRenderStatus()` with `AbortSignal`.
- Consumes: POST/GET render API and the existing download API.

- [ ] **Step 1: Expand the failing UI-state tests**

```ts
expect(applyRenderStatus(initialFilmUiState, {status: 'pending', jobId: 'job'}))
  .toEqual({status: 'pending', jobId: 'job', downloadUrl: null, error: null});
expect(applyRenderStatus(initialFilmUiState, {status: 'failed', jobId: 'job', error: 'RENDER_EXECUTION_FAILED'}))
  .toEqual({status: 'failed', jobId: 'job', downloadUrl: null, error: 'RENDER_EXECUTION_FAILED'});
expect(applyRenderStatus(initialFilmUiState, {status: 'superseded', jobId: 'job', error: 'RENDER_SUPERSEDED'}))
  .toEqual({status: 'superseded', jobId: 'job', downloadUrl: null, error: 'RENDER_SUPERSEDED'});
```

- [ ] **Step 2: Write failing polling tests**

Use fake timers and a mocked fetch to prove pending → processing → completed stops polling, failed and superseded stop polling, `AbortController.abort()` cancels the delay, and 401/403 stops without retry.

- [ ] **Step 3: Run state/polling tests and verify RED**

Run: `npx vitest run src/features/film/film-ui-state.test.ts src/features/film/render-polling.test.ts`  
Expected: FAIL because the new status reducer and polling module do not exist.

- [ ] **Step 4: Implement normalized state and bounded polling**

```ts
export type RenderStatus = {status: 'idle'|'pending'|'processing'|'completed'|'failed'|'superseded'; jobId?: string; error?: string};

export const pollRenderStatus = async ({load, signal, wait}: {
  load: () => Promise<RenderStatus>;
  signal: AbortSignal;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}) => {
  for (const delay of [1_000, 1_500, 2_000, 3_000, 5_000]) {
    const status = await load();
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'superseded' || status.status === 'idle') return status;
    await wait(delay, signal);
  }
  while (!signal.aborted) {
    const status = await load();
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'superseded') return status;
    await wait(5_000, signal);
  }
  throw new DOMException('Aborted', 'AbortError');
};
```

- [ ] **Step 5: Integrate page load, enqueue, polling, and download**

Add these callbacks and effect to `page.tsx`:

```tsx
const renderAbort = useRef<AbortController|null>(null);
const loadRenderStatus = useCallback(async (): Promise<RenderStatus> => {
  const response = await fetch(`/api/projects/${projectId}/render`);
  if (response.status === 401 || response.status === 403) throw new Error('PROJECT_FORBIDDEN');
  if (!response.ok) throw new Error('RENDER_STATUS_FAILED');
  return response.json() as Promise<RenderStatus>;
}, [projectId]);

const finishRender = useCallback(async (status: RenderStatus) => {
  setFilmUi((current) => applyRenderStatus(current, status));
  if (status.status === 'failed') {
    setMessage('The film could not be prepared. Try again.');
    return;
  }
  if (status.status === 'superseded') {
    setMessage('Newer edits replaced this render. Prepare the gift again when you are ready.');
    return;
  }
  if (status.status !== 'completed') return;
  const response = await fetch(`/api/projects/${projectId}/download`);
  if (!response.ok) throw new Error('DOWNLOAD_FAILED');
  const {url} = await response.json() as {url: string};
  setFilmUi(completeFilmPreparation(url));
  setMessage('Your private film is ready. The download link lasts fifteen minutes.');
}, [projectId]);

const watchRender = useCallback((initial: RenderStatus) => {
  renderAbort.current?.abort();
  const controller = new AbortController();
  renderAbort.current = controller;
  setFilmUi((current) => applyRenderStatus(current, initial));
  if (initial.status !== 'pending' && initial.status !== 'processing') return void finishRender(initial);
  void pollRenderStatus({load: loadRenderStatus, signal: controller.signal, wait: abortableWait})
    .then(finishRender)
    .catch((error) => { if (error instanceof Error && error.name !== 'AbortError') setMessage('Render status could not be refreshed yet.'); });
}, [finishRender, loadRenderStatus]);

useEffect(() => {
  void loadRenderStatus().then(watchRender).catch(() => undefined);
  return () => renderAbort.current?.abort();
}, [loadRenderStatus, watchRender]);

const prepareFilm = async () => {
  setFilmUi(beginFilmPreparation(initialFilmUiState));
  setMessage('Your film is queued on private rendering hardware.');
  const response = await fetch(`/api/projects/${projectId}/render`, {method: 'POST'});
  if (!response.ok) {
    setFilmUi(failFilmPreparation('RENDER_JOB_LAUNCH_FAILED'));
    return setMessage('The film could not be queued. Try again.');
  }
  watchRender(await response.json() as RenderStatus);
};
```

Implement `abortableWait(ms, signal)` with a timer that rejects `AbortError` when aborted. On failed state, `failFilmPreparation()` must restore an enabled action button.

Render button text as “Render queued…” for pending and “Preparing your film…” for processing; keep the existing download link for ready.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run src/features/film/film-ui-state.test.ts src/features/film/render-polling.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/features/film/film-ui-state.ts src/features/film/film-ui-state.test.ts src/features/film/render-polling.ts src/features/film/render-polling.test.ts 'src/app/projects/[projectId]/page.tsx'
git commit -m "feat: resume asynchronous renders in the browser"
```

### Task 9: Cloud Run Job deployment

**Files:**
- Modify: `scripts/deploy.ps1`
- Modify: `README.md`
- Create: `scripts/deploy.test.ts`

**Interfaces:**
- Produces: a named Cloud Run Job compatible with `CloudRunRenderJobLauncher` and the service env `RENDER_JOB_NAME`.
- Consumes: the same image, runtime identity, Cloud SQL instance, database secret, bucket, and Remotion configuration.

- [ ] **Step 1: Write a failing deployment contract test**

```ts
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

it('deploys the render job before the web service with bounded resources', () => {
  const script = readFileSync('scripts/deploy.ps1', 'utf8');
  const job = script.indexOf('gcloud run jobs deploy $RenderJob');
  const service = script.indexOf('gcloud run deploy $Service');
  expect(job).toBeGreaterThan(-1);
  expect(job).toBeLessThan(service);
  for (const value of ['--tasks 1', '--parallelism 1', '--max-retries 1', '--task-timeout 3600s', '--cpu 8', '--memory 16Gi', 'node /app/dist/render-film.mjs']) {
    expect(script).toContain(value);
  }
  expect(script).toContain('RENDER_JOB_NAME=$RenderJob');
});
```

- [ ] **Step 2: Run the deployment test and verify RED**

Run: `npx vitest run scripts/deploy.test.ts`  
Expected: FAIL because the script does not deploy a job.

- [ ] **Step 3: Add the render-job deployment**

Add `[string]$RenderJob = 'legacy-studio-render'`. After image publication and before service deployment, run `gcloud run jobs deploy $RenderJob` with:

```powershell
--image "$image`:latest" `
--region $Region `
--service-account $RuntimeServiceAccount `
--set-cloudsql-instances $CloudSqlInstance `
--tasks 1 `
--parallelism 1 `
--max-retries 1 `
--task-timeout 3600s `
--cpu 8 `
--memory 16Gi `
--command node `
--args /app/dist/render-film.mjs `
--set-env-vars "GCP_PROJECT_ID=$ProjectId,GCP_LOCATION=$Region,GCS_BUCKET=$Bucket,FACTUALITY_AUDIT_PROVIDER=gemini,GEMINI_STORY_MODEL=gemini-3.1-flash-lite,DEEPGRAM_TRANSCRIPTION_MODEL=nova-3,REMOTION_BUNDLE_PATH=/app/remotion-bundle,REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium,REMOTION_CONCURRENCY=4" `
--set-secrets "DATABASE_URL=$DatabaseSecret`:latest"
```

Add `RENDER_JOB_NAME=$RenderJob` to service environment. Use `gcloud run jobs add-iam-policy-binding $RenderJob --member "serviceAccount:$RuntimeServiceAccount" --role roles/run.invoker` so the web identity can execute only the named job. Do not add unauthenticated access or minimum instances.

- [ ] **Step 4: Update deployment documentation**

Replace the README statement that Jobs are deferred. Document the on-demand job, 8 vCPU/16 GiB/3600-second maximum, scale-to-zero cost behavior, `roles/run.invoker` requirement, and the compiled worker artifact.

- [ ] **Step 5: Run deployment contract and build**

Run: `npx vitest run scripts/deploy.test.ts && npm run build`  
Expected: PASS and production build succeeds.

- [ ] **Step 6: Commit**

```powershell
git add -- scripts/deploy.ps1 scripts/deploy.test.ts README.md
git commit -m "deploy: add scale-to-zero render job"
```

### Task 10: Full local and deployed verification

**Files:**
- Modify only if a verification failure exposes a defect; use a new failing regression test before any repair.

**Interfaces:**
- Consumes: all tasks above.
- Produces: evidence that the repaired workflow passes locally and on GCP hardware.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```powershell
npm test
npm run typecheck
npx eslint . --ignore-pattern remotion-bundle/**
npm run build
git diff --check
```

Expected: all tests and typecheck pass; ESLint has no errors; build succeeds; `git diff --check` emits no output.

- [ ] **Step 2: Build the deployment image locally**

Run: `docker build -t legacy-studio:workflow-repairs .`  
Expected: image builds with Chromium, FFmpeg, `/app/remotion-bundle`, and `/app/dist/render-film.mjs`.

- [ ] **Step 3: Deploy through the reviewed script**

Run the repository's `scripts/deploy.ps1` with the same explicit project, region, service accounts, bucket, Cloud SQL instance, queue, and secret arguments used by the current deployment.  
Expected: build succeeds; job is updated before the service; health endpoint returns successfully.

- [ ] **Step 4: Verify GCP configuration read-only**

Run:

```powershell
gcloud run jobs describe legacy-studio-render --region us-central1 --format yaml
gcloud run services describe legacy-studio --region us-central1 --format yaml
```

Expected: job has one task, parallelism one, 8 CPU, 16 GiB, 3600-second timeout, no public endpoint/minimum instance; service has the fully qualified render job configuration.

- [ ] **Step 5: Repeat the full browser workflow**

In the deployed Cloud Run URL: create a project; verify the URL never becomes localhost; accept storage/processing consent; upload three photographs and source material; refresh and verify saved slots remain populated; analyze and approve evidence; generate questions/storyboard; run factuality review and verify neutral copy; approve/generate narration; enqueue render; refresh while pending/processing; wait for completion; download and play the MP4.

Expected: every step completes, the render request returns promptly, refresh restores progress, and the MP4 downloads from a short-lived signed URL.

- [ ] **Step 6: Inspect logs and storage without exposing private data**

Run filtered `gcloud logging read` queries for the render job execution and confirm lifecycle codes, manifest hash, duration, and successful exit. Verify the GCS render object remains private.  
Expected: no owner token, signed URL, narration text, raw provider content, internal localhost redirect, 504, or `Target closed` error.

- [ ] **Step 7: Record final repository state**

Run: `git status --short; git log --oneline -12`  
Expected: clean working tree and the task commits listed above.
