# The Legacy Studio Provider Pivot Design

**Date:** July 14, 2026

**Status:** Approved

**Scope:** Provider architecture, consent, cost controls, and migration of the
existing Memory Film MVP

## 1. Decision summary

The Legacy Studio keeps the product definition, evidence-first workflow, private
media model, storyboard editor, and downloadable Memory Film described in
`2026-07-14-legacy-studio-mvp-design.md`. This document supersedes that design
wherever it assigns AI or speech providers.

The approved provider allocation is:

| Capability | Primary provider and model | Secondary path |
| --- | --- | --- |
| Media understanding and story composition | Google Gemini `gemini-3.1-flash-lite` | Model is configurable for a later Gemini quality upgrade |
| Source-audio transcription | Deepgram Nova-3 | Creator-entered transcript after a recoverable failure |
| Final evidence and factuality audit | OpenAI GPT-5.6 | No automatic substitute |
| Generated narration | Deepgram Aura-2 `aura-2-arcas-en` | Microsoft Azure Speech, only after explicit creator selection |
| Creator narration | Uploaded creator recording | Independent of generated narration providers |

Fish Audio is not part of the MVP. It must not appear in application code,
configuration, user-facing provider disclosures, consent records, or operating
documentation. Historical decision records may name it to explain its removal.

External photo restoration is also deferred from the seven-day MVP. Originals
are preserved and may have local presentation derivatives, but no additional
restoration provider receives family media under this design.

All provider model identifiers are configuration values. The defaults above are
the approved MVP choices, not hard-coded assumptions inside domain services.

## 2. Provider boundaries

### Gemini story agent

Gemini receives selected photos, creator captions, supporting text, Deepgram
transcripts, approved evidence, interview answers, and approved story context.
It produces schema-validated collection analysis, question candidates, voice
profile traits, and provenance-linked storyboard drafts.

Gemini is the only external model that receives selected original images. Uploaded material is
always delimited as untrusted evidence and can never override system or
developer instructions. The initial model is `gemini-3.1-flash-lite`. The
provider adapter must allow a later move to `gemini-3.5-flash` through
configuration and evaluation rather than a domain-layer rewrite.

The MVP uses the Gemini Developer API through a Cloud project associated with
the creator's active Cloud Billing account; it does not use Vertex AI. The
deployment must verify that the API key's project is shown as a paid project
before enabling real media processing. Under Google's paid-service terms,
prompts, responses, and files are not used to improve Google products, although
Google may temporarily log them for abuse prevention and may process that data
in countries where Google or its agents maintain facilities. The product makes
no regional data-residency promise for Gemini processing.

Images within the inline-request limit are sent inline. If the Gemini Files API
is required, the adapter persists each provider file name before using it and
attempts immediate deletion after processing. A durable cleanup reconciler
retries records left behind by process termination or provider failure, and
project deletion also schedules outstanding provider artifacts for cleanup.
Google's documented 48-hour automatic deletion is a backstop, not the
application's cleanup strategy. The MVP does not use Gemini File Search or
create persistent Google-side indexes.

### Deepgram transcription

Deepgram Nova-3 receives only the audio stream needed for transcription. It
returns normalized transcript text, timestamped segments, speaker information
when available, and metadata needed to select authentic clips. Transcript
claims enter the evidence ledger as proposed evidence and require the same
creator confirmation rules as other model-extracted facts.

Every supported Deepgram STT and TTS request must include `mip_opt_out=true`.
The adapters must centralize this setting so a caller cannot accidentally omit
it.

### GPT-5.6 factuality auditor

GPT-5.6 is a separate final-review service, not the storyteller. It receives
only the approved or corrected evidence ledger, evidence-to-source references,
and the final narration text. It never receives original images, source audio,
video, generated narration audio, or storage URLs.

The audit returns a schema-validated list of supported claims, unsupported or
overstated claims, missing citations, and required corrections. A film cannot
advance to narration-text approval, synthesis, or rendering while blocking
findings remain.
The audit is cached by the hash of the approved evidence snapshot, narration,
prompt version, and configured model.

This narrow but consequential runtime use demonstrates GPT-5.6 as the film's
final evidence safeguard while Codex remains the primary development workflow.

### Deepgram narration

Deepgram Aura-2 with `aura-2-arcas-en` is the default generated narrator. It
receives only creator-approved narration text and synthesis settings. The MVP
uses a standard provider voice and does not clone or imitate the subject.

Narration is generated per scene or reusable chapter segment. The creator must
hear and approve a short Arcas sample before full narration generation. Changing
the narration text invalidates only the affected segment and downstream render,
not the entire project.

When generated narration is used, the film includes a restrained end-credit
disclosure naming Deepgram or Microsoft as the generated-voice provider. Creator
narration is labeled as creator-provided rather than AI-generated.

### Azure narration

Azure Speech is an explicitly selected backup, never an automatic failover.
After a Deepgram failure, the interface may offer Retry, Hear Azure alternative,
or Upload my narration. Azure can be selected only after the creator plays a
sample and confirms the change. Azure receives only approved narration text and
voice settings.

## 3. Consent and data routing

Consent has two explicit stages. Before the first upload, the creator accepts a
baseline storage disclosure explaining that private originals and derivatives
are stored in Google Cloud Storage. Before the first external AI or speech API
request, the creator separately accepts a versioned processing disclosure
containing this required statement:

> This project sends selected information to third-party processors. By
> continuing, you confirm that you have permission to submit this material.

The interface then identifies each enabled provider, its purpose, the exact data
categories it receives, and a link to its current privacy information:

- Google receives selected photos, captions, written artifacts, transcripts,
  and approved story context for analysis and story composition.
- Deepgram receives uploaded audio for transcription. For
  narration it receives only approved narration text and the Arcas voice
  setting.
- OpenAI receives only the approved evidence ledger, source references, and
  final narration text for factuality review.
- Microsoft receives only approved narration text and voice settings when the
  creator explicitly selects Azure.

Both consents are project-scoped and record their purpose (`storage` or
`processing`), document version, timestamp, enabled providers, approved data
categories, and the creator's permission assertion. A signed upload URL cannot
be issued without valid storage consent. Adding an AI or speech provider or
broadening its data categories invalidates processing consent and requires
renewed approval.
An Azure sample is itself a provider request, so Microsoft must be present in a
still-valid consent snapshot before even the sample text is sent.

Every provider run references the exact consent record and a canonical hash of
its provider/data-category snapshot. Enqueue and execution each verify, in the
same database transaction used to reserve the run, that consent remains valid
for that provider and operation. Invalidating consent prevents unclaimed work
from being sent and causes an already claimed worker to recheck before external
I/O.

Original media stays in private Google Cloud Storage. Provider adapters send
bytes or authenticated provider uploads; they do not expose permanent public
media URLs. Logs, error reports, and analytics exclude captions, transcripts,
narration text, signed URLs, API credentials, and raw provider payloads that may
contain family data.

Project deletion removes originals, derivatives, transcripts, narration,
provider results, manifests, and rendered films under The Legacy Studio's
control. The deletion interface explains that third-party handling follows each
provider's disclosed retention terms.

## 4. Cost and reliability controls

Processing is always initiated by an explicit creator action. Upload completion
does not automatically trigger analysis, transcription, auditing, narration, or
rendering.

Each provider result is cached by a deterministic input hash that includes the
source content or approved evidence snapshot, operation, model, relevant
settings, and prompt/schema version. An identical retry reuses the prior
successful result. Scene-level narration permits a single edited passage to be
regenerated without paying to regenerate the whole film.

Input fingerprints are project-scoped HMAC-SHA-256 values computed with a
server-side secret and the project ID. Cache lookup is prohibited across
projects, preventing low-entropy narration or evidence text from being probed by
raw digest comparison.

Each project records provider, model, operation, status, request identifier when
safe, input/output usage where available, estimated cost, cache status, and
timestamps. Configurable request-count and estimated-cost limits stop accidental
loops and oversized jobs. The interface must not promise that provider estimates
are final billing amounts.

Provider errors remain recoverable. Retries use capped exponential backoff and
idempotency guards. There is no silent provider failover, model upgrade, or full
story regeneration. A provider selection or model change that can alter the
approved output requires a new sample or review as appropriate.

Before enqueue, one transaction locks the project budget row, validates current
consent, checks request and cost limits, creates or reuses the idempotent run,
and reserves its estimated request count and cost. Completion settles the
reservation against observed usage; terminal failure releases unused reserved
cost. Estimates use a stored pricing-version identifier and never claim to be a
provider invoice.

Runs are claimed with a lease token and expiry. A transient failure increments
the attempt count and schedules `next_attempt_at` while retaining the same run
identity. A terminal failure remains immutable; an explicit creator retry makes
a new run linked to the failed run. Expired leases may be reclaimed, and lease
tokens plus heartbeats fence stale workers from persisting results.

Immediately before external I/O, the worker atomically revalidates consent and
its lease, assigns a provider idempotency key where supported, and marks the run
`dispatching` with a conservative `dispatch_deadline_at` beyond the provider
timeout. Consent invalidation prevents any run that has not reached that state,
but cannot recall data already dispatched. A dispatching run is never reclaimed
for another provider call. The worker renews its lease throughout the call; if
it disappears, a reconciler waits for the dispatch deadline and uses the safe
provider request ID or status API where available. If completion cannot be
proven, the reconciler marks the run `ambiguous` and requires an explicit
creator retry rather than issuing another call automatically.

If a provider times out after accepting a request and offers no idempotency key,
the outcome is `ambiguous`, not an automatic transient retry, because a retry
could duplicate cost or processing. `ambiguous` is a terminal unresolved state,
not active or successful. The reservation is conservatively settled as though
the full request and estimated cost were consumed.

To retry, the creator must acknowledge the risk of duplicate processing and
cost. In one transaction the ambiguous run becomes
`superseded_ambiguous`, records the acknowledgment, and links to a newly reserved
run through retry lineage. This transition permits the new run under the partial
uniqueness constraint. A late completion from the superseded run is recorded as
`late_completed`, can adjust settled usage only when authoritative provider
usage is available, and may never overwrite or become the active project result.
Any late provider artifact is quarantined for cleanup.

Only one active or successful run may exist for the same project, operation,
model, and input fingerprint.

## 5. Data-model amendments

The implementation plan may adapt names to the existing Drizzle schema, but it
must represent these concepts:

### `project_consents`

- `id`
- `project_id`
- `purpose` (`storage` or `processing`)
- `document_version`
- `providers` (`jsonb`)
- `data_categories` (`jsonb`)
- `permission_confirmed`
- `accepted_at`
- `invalidated_at` (nullable)
- `snapshot_hash`

### `provider_runs`

- `id`
- `project_id`
- `asset_id` (nullable)
- `storyboard_id` (nullable)
- `consent_id`
- `consent_snapshot_hash`
- `provider`
- `model`
- `operation`
- `input_hash`
- `prompt_version` (nullable)
- `status`
- `cache_hit`
- `attempt_count`
- `lease_token` (nullable)
- `lease_expires_at` (nullable)
- `next_attempt_at` (nullable)
- `provider_idempotency_key` (nullable)
- `dispatch_started_at` (nullable)
- `dispatch_deadline_at` (nullable)
- `previous_run_id` (nullable)
- `superseded_by_run_id` (nullable)
- `duplicate_risk_acknowledged_at` (nullable)
- `late_result_status` (nullable)
- `input_usage` (nullable)
- `output_usage` (nullable)
- `estimated_cost_micros` (nullable)
- `reserved_cost_micros`
- `settled_cost_micros` (nullable)
- `reserved_request_count`
- `settled_request_count` (nullable)
- `pricing_version`
- `safe_request_id` (nullable)
- `error_code` (nullable)
- `created_at`
- `completed_at` (nullable)

A partial uniqueness constraint must prevent simultaneous active or successful
runs for the same project, operation, model, and input hash. Failed explicit
retries use `previous_run_id` and a new run ID while preserving the lineage.

### `project_provider_budgets`

- `project_id`
- `request_limit`
- `reserved_requests`
- `settled_requests`
- `cost_limit_micros`
- `reserved_cost_micros`
- `settled_cost_micros`
- `updated_at`

### `provider_artifacts`

- `id`
- `project_id`
- `provider_run_id`
- `provider`
- `provider_artifact_id`
- `artifact_type`
- `cleanup_status`
- `cleanup_attempt_count`
- `next_cleanup_at` (nullable)
- `provider_expires_at` (nullable)
- `deleted_at` (nullable)
- `last_error_code` (nullable)
- `created_at`

Provider-artifact cleanup records must survive until cleanup succeeds. Project
deletion first revokes access and enters `deletion_pending`, then cleans provider
artifacts before deleting the project row and cascading its cleanup records. If
the provider is unavailable, the tombstoned project and cleanup rows remain for
the reconciler rather than losing the only provider artifact identifier.

### `factuality_audits`

- `id`
- `project_id`
- `storyboard_id`
- `evidence_snapshot_hash`
- `narration_hash`
- `model`
- `prompt_version`
- `status`
- `findings` (`jsonb`)
- `blocking_finding_count`
- `resolution_status`
- `resolved_at` (nullable)
- `created_at`
- `completed_at` (nullable)

Existing storyboard narration-source values change from OpenAI-first semantics
to `deepgram`, `azure`, or `creator`. Existing generated narration records must
store the provider, model, voice, source-text hash, audio object key, duration,
and approval timestamp.

The storyboard also stores `audited_evidence_hash`, `audited_narration_hash`,
`approved_narration_hash`, `narration_text_approved_at`,
`audio_selection_approved_at`, and the passing `factuality_audit_id`. The state
machine is:

`draft -> audit_pending -> audit_blocked|audit_passed -> narration_text_approved -> audio_selection_approved -> synthesized -> renderable`

Only the exact narration hash from a passing audit can receive narration-text
approval. Audio-selection approval separately records the chosen provider,
model, voice or creator asset, sample approval when generated speech is used,
and the approved narration hash. Any evidence or narration edit invalidates the
audit, narration-text approval, audio-selection approval, synthesized audio, and
render manifest as applicable, returning the storyboard to `draft`.

## 6. Revised processing flow

1. The creator creates a project, accepts storage consent, and uploads private
   family media.
2. Before external AI or speech processing, the creator reviews and accepts the
   current provider disclosure.
3. The creator explicitly requests media processing.
4. Deepgram Nova-3 transcribes source audio with model-improvement opt-out.
5. Gemini Flash-Lite analyzes the selected collection and proposes evidence and
   chapter framing.
6. The creator confirms, corrects, or rejects evidence and answers guided
   questions.
7. Gemini composes the evidence-linked voice profile and storyboard.
8. The creator edits the final narration draft.
9. GPT-5.6 audits that draft against the approved evidence snapshot.
10. The creator resolves all blocking findings and reruns the hash-aware audit
    whenever evidence or narration changes.
11. The creator approves the exact narration text hash from the passing audit.
12. For generated narration, the creator hears an Arcas sample or renews
    consent and hears an Azure sample, then grants audio-selection approval for
    that provider, model, voice, and audited narration hash.
13. For creator narration, the creator uploads the recording before audio-
    selection approval. Deepgram transcribes it through the disclosed STT route;
    that actual transcript becomes the final narration draft and passes through
    audit, resolution, and exact transcript-hash text approval. Only then can the
    creator grant audio-selection approval to the uploaded recording. This
    catches spoken additions absent from the previously audited script.
14. The narration service generates only missing or invalidated generated
    segments; creator audio is reused from its approved private asset.
15. The creator previews the immutable render manifest.
16. Cloud Run renders and privately stores the downloadable Memory Film.

## 7. Migration from completed Tasks 4 and 5

The existing evidence ledger, verification states, `StoryAgent` abstraction,
guided questions, voice profiles, and storyboard domain rules remain valuable.
The migration must preserve them while changing provider responsibilities:

1. Replace `OpenAIStoryAgent` with a Gemini adapter behind the existing
   provider-neutral story interface.
2. Remove `gpt-5.6` assumptions from story-agent schemas, fixtures, and tests.
3. Introduce a distinct GPT-5.6 auditor interface before approval of the exact
   final narration hash.
4. Add project consent gating before any provider queue operation.
5. Add provider-run recording, hashing, cache reuse, and budget enforcement.
6. Update storyboard narration-source semantics and UI copy.
7. Continue Task 6 with Deepgram Nova-3 rather than OpenAI transcription.
8. Continue Task 7 with Deepgram Arcas rather than OpenAI or Fish narration.

No migration may silently discard creator edits or already approved evidence.
Provider-specific persisted fields should be migrated or replaced deliberately,
with a test covering existing project records.

The original implementation plan is superseded wherever it conflicts with this
specification and must not be executed further until a revised plan is written
and approved. That plan must sequence consent and provider-run infrastructure
before the first Gemini or Deepgram integration, then migrate completed Tasks 4
and 5 before continuing transcription and narration work.

## 8. Verification strategy

Automated tests use dependency injection and mocked provider responses; routine
test runs never spend API credit or submit family media.

Required coverage includes:

- Gemini structured-output validation and prompt-injection boundaries.
- Deepgram transcript normalization, timestamps, speakers, and the mandatory
  `mip_opt_out=true` parameter.
- Deepgram Aura narration requests also carrying mandatory
  `mip_opt_out=true`.
- Evidence extracted from transcripts remaining proposed until creator review.
- GPT-5.6 receiving only the approved evidence snapshot and narration text.
- Rendering blocked while a factuality audit has unresolved blocking findings.
- Deepgram and Azure narration requests containing narration text but no source
  media, evidence ledger, or unrelated project data.
- Azure being impossible to activate through automatic failover.
- Consent gating, version invalidation, and provider/data-category snapshots.
- Atomic consent-to-run binding, including renewed Microsoft consent before an
  Azure sample.
- Hash-based cache hits and duplicate in-flight request prevention.
- Lease expiry/reclaim, stale-worker fencing, retry lineage, atomic budget
  reservation/settlement, and project-scoped HMAC fingerprints.
- Lease expiry during provider I/O, dispatch-deadline reconciliation, provider
  idempotency keys where supported, and ambiguous outcomes never auto-retrying.
- Ambiguous-run acknowledgment, conservative settlement, superseding retry
  lineage, and late completions never overwriting the active result.
- Gemini paid-project verification, inline-versus-Files routing, provider-file
  cleanup records/reconciliation, project-deletion cleanup, and prohibition of
  File Search.
- Storage consent before upload and separate processing consent before AI or
  speech requests.
- Creator narration transcription and re-audit before its audio selection can
  be approved.
- Provider timeout, malformed output, retry exhaustion, and safe error logging.
- Existing project migration without loss of evidence or storyboard edits.
- A fixture evaluation comparing generated claims with known source evidence.
- One manual Arcas sample approval and one end-to-end downloadable Memory Film.

## 9. Configuration contract

The application reads secrets from environment variables populated by Secret
Manager in production. Repository files contain names and safe defaults only:

```text
GEMINI_API_KEY
GEMINI_STORY_MODEL=gemini-3.1-flash-lite
GEMINI_REQUIRE_PAID_PROJECT=true
DEEPGRAM_API_KEY
DEEPGRAM_TRANSCRIPTION_MODEL=nova-3
DEEPGRAM_NARRATION_MODEL=aura-2-arcas-en
OPENAI_API_KEY
OPENAI_AUDIT_MODEL=gpt-5.6
AZURE_SPEECH_KEY
AZURE_SPEECH_REGION
AZURE_SPEECH_VOICE
PROVIDER_CONSENT_VERSION
PROJECT_PROVIDER_REQUEST_LIMIT
PROJECT_PROVIDER_COST_LIMIT_MICROS
PROVIDER_INPUT_HMAC_SECRET
```

No key may be logged, committed, stored in LifeOS Markdown, or returned to the
browser. Provider adapters fail fast with a safe configuration error when a
required primary key is missing. Azure variables are optional: when they are
absent, primary Gemini, Deepgram, and OpenAI paths remain healthy, Azure is
omitted from enabled-provider consent choices, and Azure sample or selection
returns a safe unavailable response rather than failing application startup.

## 10. Acceptance criteria

This pivot is complete when:

- Fish and OpenAI storytelling/transcription/narration assumptions are absent.
- Gemini Flash-Lite produces the structured story workflow behind the existing
  domain interface.
- Deepgram Nova-3 produces timestamped transcript evidence with opt-out enabled.
- GPT-5.6 blocks unsupported final narration claims without receiving raw media.
- Arcas is the default generated narrator and Azure requires explicit approval.
- Provider consent is recorded before any external processing.
- Storage consent is recorded before any signed upload is issued.
- Every provider run is atomically bound to valid consent and a reserved budget.
- Only an exact GPT-5.6-audited narration hash can be approved and synthesized.
- Cache, usage, lease, budget, retry, and safe-logging controls have automated
  tests.
- The representative fixture produces a reviewed, narrated, rendered, private,
  downloadable Memory Film.
