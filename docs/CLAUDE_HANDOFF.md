# Claude Handoff: Deployed Workflow Repairs

## Repository state

- Worktree: `C:\Users\txmye_ficivtv\Documents\Build Week Hackathon\.worktrees\legacy-studio-mvp`
- Branch: `codex/legacy-studio-mvp`
- GitHub: `txmyer-dev/BWH`
- Design: `docs/superpowers/specs/2026-07-16-deployed-workflow-repairs-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-16-deployed-workflow-repairs.md`
- SDD progress ledger: `.superpowers/sdd/progress.md` (git-ignored local coordination state)

The user explicitly stopped further Codex testing/review because inference was exhausted. Continue from the pushed branch; do not repeat completed tasks.

## User-approved behavior

The deployed workflow must:

1. keep project-create redirects on the public deployed origin;
2. show persisted uploads after refresh;
3. use provider-neutral factuality-review copy outside the explicit consent disclosure;
4. enqueue film renders onto an on-demand Cloud Run Job;
5. poll render status across browser refreshes;
6. mark old renders `superseded` after an edit so they cannot resurface or restore a stale download;
7. keep media private and expose only short-lived signed downloads.

## Completed implementation

Tasks 1–8 in the implementation plan are committed:

- `43b7320` — relative project redirect and owner cookie preservation.
- `4548cba`, `f7ddff7` — persisted asset hydration; completed local drafts yield to refreshed inventory.
- `2d80163` — canonical provider-neutral factuality copy.
- `7e89474` — durable render jobs, leases, stale recovery, and atomic `superseded` invalidation.
- `c75e43a` — Cloud Run Jobs launcher and resource-name environment contract.
- `7718aeb`, `b5b67bc`, `23391c6` — asynchronous POST/GET render API, duplicate-launch race prevention, and pending-job cleanup after completion-check errors.
- `aa3a512`, `c7baff2` — compiled one-shot render worker, least-privilege worker env, immutable-image artifact, and guaranteed Postgres client shutdown.
- `3e77a32` — abortable refresh-safe browser polling and explicit failed/superseded UI states.

Important review fixes already incorporated:

- ready local upload drafts no longer mask persisted inventory;
- active render jobs are fenced by `job_type = 'render_film'` and lease tokens;
- edits atomically supersede pending, processing, and completed renders;
- a completion/enqueue interleaving cannot launch a duplicate render;
- a failed second completion check cannot strand a pending render;
- the worker always closes `database.$client` so a Cloud Run Job can terminate.

## Verification already reported

Do not treat this as fresh verification; these are the implementers' last reported results:

- Tasks 1–7 received independent task review approval after fixes.
- Task 8 reported 9/9 focused tests passing, TypeScript typecheck passing, and focused ESLint passing.
- Task 8 did **not** receive its independent task review before Codex was stopped.
- Task 7 reported 21/21 focused tests, typecheck, and full `npm run build` passing.
- The compiled `dist/render-film.mjs` loaded in an isolated `npm ci --omit=dev` runtime with `esbuild` absent.
- Docker CLI was unavailable, so no local `docker build` was performed.
- No additional tests were run while preparing this handoff, per user instruction.

## Remaining work

### 1. Review Task 8

Review commit `3e77a32` against Task 8 in the plan. Concentrate on:

- only one active poller;
- abort on unmount, poll restart, and authentication failure;
- no stale state update after abort;
- download requested only for `completed`;
- `failed` and `superseded` never restore a download and re-enable a fresh render;
- a refresh resumes pending/processing state.

There is no DOM component harness; current coverage is reducer/poller-level plus typecheck/lint. Decide whether browser verification is sufficient or whether to add a component-level test.

### 2. Implement Task 9: deployment

`scripts/deploy.ps1` and `README.md` still need the Cloud Run Job deployment described in the plan:

- build one image;
- deploy/update `legacy-studio-render` before the web service;
- one task, parallelism one, max retries one;
- 8 vCPU, 16 GiB, 3600-second task timeout;
- command `node /app/dist/render-film.mjs`;
- same Cloud SQL attachment, private GCS bucket, required render configuration, and database secret;
- no public endpoint and no minimum instance;
- grant the web service identity permission to execute only the named job;
- set `RENDER_JOB_NAME` on the web service.

Confirm the exact `gcloud run jobs deploy` flags against the installed gcloud version before deploying.

### 3. Resolve or accept recorded minor findings

- `src/app/api/projects/[projectId]/render/route.ts`: production dependency construction occurs outside handler error normalization; GET also constructs a launcher it does not use.
- The same route uses relative imports because the Vitest configuration does not resolve `@/`; sibling routes use aliases.
- Direct fully-qualified `RENDER_JOB_NAME` passthrough has implementation coverage but no dedicated test.

### 4. Run Task 10 verification and deploy

When usage permits, run the commands in Task 10, then deploy to GCP and repeat the complete browser workflow. At minimum verify:

- project creation never redirects to localhost;
- saved upload slots survive refresh;
- generic audit copy is provider-neutral while consent remains explicit;
- render POST returns promptly;
- refresh resumes queued/processing state;
- an edit makes the old render visibly `superseded` and prevents stale download resurfacing;
- the Cloud Run Job exits, writes the private MP4, and produces a working fifteen-minute signed download;
- logs contain no owner token, signed URL, narration text, provider payload, 504, or Remotion `Target closed` failure.

## Original deployed failure evidence

- Synchronous render requests consistently reached Cloud Run's 900-second HTTP timeout and returned 504.
- Remotion logged `Protocol error (Page.bringToFront): Target closed` when the service request was terminated.
- The film was 1920×1080, 30 fps, approximately 3,600 frames.
- The current service used one-request concurrency and Chromium inside the web container.

The architectural fix is the on-demand Cloud Run Job; do not revert to a long synchronous browser request.
