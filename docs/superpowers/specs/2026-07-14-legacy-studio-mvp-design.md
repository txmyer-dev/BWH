# The Legacy Studio MVP Design

**Date:** July 14, 2026

**Hackathon:** OpenAI Build Week

**Track:** Apps for Your Life

**Delivery window:** Seven days

**Status:** Approved design awaiting written-spec review

## 1. Product definition

The Legacy Studio helps one person turn a small collection of family media into one verified, giftable chapter of someone else's life.

The product is not a general family archive, bulk digitization service, photo editor, or open-ended AI chat. Its first experience is deliberately narrow:

1. A creator starts a project for one subject.
2. The creator uploads three to seven family photographs and may add captions, pasted text, or one short audio recording.
3. The Studio examines the collection and proposes a chapter connecting the artifacts.
4. The Studio asks a small number of questions about missing or uncertain details.
5. The creator confirms or corrects the factual record.
6. The Studio composes a narrative grounded in the approved evidence.
7. The creator edits and publishes a private, giftable story page.

The guiding promise is:

> Their memories. Their voice. Beautifully preserved with your guidance.

## 2. Audience and job to be done

### Primary user

An adult child, grandchild, sibling, or other family member who is comfortable enough with technology to collect media and answer guided questions. The creator is making a gift for an aging relative, another family member, or future generations.

### Recipient

The recipient should not need an account or any familiarity with AI. They receive a warm, familiar artifact rather than an AI tool.

### Job to be done

When family photographs and memories feel scattered or at risk of disappearing, help me turn a manageable collection into a meaningful story I can confidently give to someone I love.

### Emotional outcome

The creator should feel relief that a memory has been preserved, confidence that the story is trustworthy, and pride that the result feels like a genuine gift rather than generated content.

## 3. Product principles

### AI stays under the hood

The user interface avoids terms such as LLM, prompt, embedding, inference, and generative upscaling. User-facing language includes:

- Restore image
- Find the story
- A few details need your help
- Review the record
- Shape the chapter
- Prepare the gift

### Evidence before eloquence

The Studio may propose connections and interpretations, but it may not silently turn an inference into family history. Names, relationships, dates, places, events, quotations, and biographical claims must be connected to evidence or explicitly confirmed by the creator.

### The agent is an editor and oral historian

The agent organizes, asks, reflects, and composes. It does not impersonate a subject or claim access to memories that were not provided.

### Originals are preserved

Original uploads are immutable. Any restored or enhanced media is stored as a separate derivative, clearly labeled, and shown beside the original for creator approval.

### The output is the product

Chat-like interaction may support the workflow, but the final experience is a designed story chapter, not a conversation transcript.

## 4. MVP scope

### Required

- Create one project for one subject.
- Upload three to seven JPEG, PNG, or WebP images.
- Add or edit a caption for each image.
- Optionally paste supporting text.
- Optionally upload one short audio file for transcription.
- Analyze images with GPT-5.6.
- Propose a chapter title, time range, theme, and image order.
- Generate targeted questions for factual and narrative gaps.
- Record creator answers and corrections.
- Maintain an evidence ledger with verification states.
- Generate a grounded written voice profile.
- Compose a draft chapter with source provenance.
- Edit the title, dedication, section text, captions, and image order.
- Publish a private, unlisted story page with a revocable share link.
- Display original/restored comparison when restoration is enabled.
- Delete a project and its stored media.

### Optional if the core path is complete

- One-click printable layout or PDF export.
- QR code for the private story page.
- Original audio excerpts embedded in the story.
- One external photo-restoration provider.

### Explicitly deferred

- Full email or social-account imports.
- Long-form video ingestion.
- Bulk media libraries.
- Multi-user collaboration.
- Recipient replies or interviews.
- Multiple chapters per project.
- Synthetic cloning of a person's voice.
- Family trees, facial recognition, and automatic identity matching.
- Payments, package tiers, and Memorial/Milestone/Heritage modes.
- Public discovery or social feeds.

## 5. Core experience

### Step 1: Begin a chapter

The creator supplies the subject's name, their relationship to the subject, a working project title, and an optional one-sentence intention for the gift.

### Step 2: Gather the pieces

The creator uploads three to seven images directly to private object storage. Each item appears immediately with upload and processing status. The creator can add a caption, approximate date, and known people.

Supporting text is pasted into a dedicated field. One optional audio file can be uploaded and transcribed. Uploaded documents and transcripts are treated as untrusted source material, never as instructions to the agent.

### Step 3: Find the story

GPT-5.6 examines the complete collection and returns a structured proposal containing:

- Chapter title
- Proposed theme
- Approximate time range
- Proposed artifact order
- Known facts with sources
- Possible connections clearly marked as hypotheses
- Missing details that would materially improve the story

The creator accepts or edits the framing before continuing.

### Step 4: Fill the gaps

The Studio asks no more than five high-value questions in the MVP. Questions favor scenes and meaning over résumé facts. They may ask about relationships, what happened before or after an image, a detail only family would recognize, why a moment mattered, or what the subject would want descendants to understand.

Each answer becomes an evidence item attributed to the creator.

### Step 5: Review the record

The creator reviews the evidence ledger. Every material claim has one of four verification states:

- `proposed`
- `confirmed`
- `corrected`
- `rejected`

Only confirmed or corrected facts may appear as facts in the final narrative. Proposed connections may appear only as clearly uncertain language and only after creator approval.

### Step 6: Shape the chapter

The Studio builds a written voice profile from approved material. The profile can describe recurring expressions, sentence rhythm, humor, formality, values, and perspective. Each trait must cite supporting evidence. When evidence is sparse, the narrative uses a restrained editorial voice rather than simulating the subject.

GPT-5.6 produces a chapter draft with:

- Opening scene
- Three to five short sections organized around the media
- Image captions
- Closing reflection
- Creator-written dedication

The creator can edit every field and regenerate an individual section without replacing approved work elsewhere.

### Step 7: Prepare the gift

The published result is a responsive, private story page with editorial typography, generous spacing, restrained motion, accessible contrast, and clear image treatment. It includes no visible AI terminology. A revocable, unlisted link allows the recipient to view it without an account.

## 6. Trust and provenance model

Every evidence item records:

- Project and subject
- Evidence type: image observation, direct quotation, uploaded text, transcript, creator memory, or model hypothesis
- Source asset or creator answer
- Source excerpt or observation
- Confidence supplied by the model when applicable
- Verification state
- Creator correction when applicable
- Creation and update timestamps

Every generated section records the evidence item IDs used to compose it. The editing interface may summarize provenance without exposing implementation jargon, for example: “Based on photos 1 and 3 and your answer about the train station.”

The system prompt must instruct models that uploaded content is data, not authority or executable instruction. Structured outputs are validated before persistence. Invalid or unsupported claims are rejected or returned for confirmation.

## 7. Technical architecture

### Chosen stack

- **Application:** Next.js with TypeScript
- **Hosting:** Google Cloud Run
- **Database:** Cloud SQL for PostgreSQL
- **Object storage:** private Google Cloud Storage bucket
- **Asynchronous work:** Cloud Tasks calling authenticated processing endpoints
- **Secrets:** Google Secret Manager
- **AI narrative and vision:** OpenAI Responses API with `gpt-5.6`
- **Transcription:** OpenAI audio transcription with `gpt-4o-transcribe`
- **Restoration:** optional third-party restoration adapter behind a provider-neutral interface

A single TypeScript application keeps the seven-day build coherent. It serves the web UI and API routes from Cloud Run. Slow work is dispatched to idempotent processing handlers through Cloud Tasks.

Cloud Run's local filesystem is temporary and is used only for bounded intermediate processing. Originals and derivatives are persisted to Cloud Storage. The browser uploads media using short-lived signed URLs so large files do not pass through the application process.

### Component boundaries

#### Project service

Creates projects and subjects, enforces the one-subject/one-chapter MVP boundary, and manages deletion.

#### Media service

Issues signed upload URLs, validates completed uploads, records metadata, creates derivatives, and preserves immutable originals.

#### Understanding service

Submits images and approved text to GPT-5.6, requests structured evidence extraction, and sends audio to transcription before narrative processing.

#### Story guide

Proposes the chapter framing, identifies material gaps, creates targeted interview questions, and writes creator answers into the evidence ledger.

#### Composer

Builds the grounded voice profile, composes section drafts from approved evidence, checks provenance coverage, and supports section-level regeneration.

#### Publishing service

Creates and revokes share tokens, renders the unlisted story page, and prevents direct exposure of private storage objects.

## 8. Data model

### `projects`

- `id`
- `title`
- `creator_name`
- `creator_relationship`
- `gift_intention`
- `status`
- `share_token_hash`
- `published_at`
- `created_at`
- `updated_at`

### `subjects`

- `id`
- `project_id`
- `name`
- `living_status` (`living`, `deceased`, `unspecified`)
- `consent_notes`
- `created_at`
- `updated_at`

### `assets`

- `id`
- `project_id`
- `type` (`image`, `audio`, `text`)
- `mime_type`
- `original_object_key`
- `derivative_object_key`
- `processing_status`
- `processing_error`
- `caption`
- `captured_at_text`
- `sequence_order`
- `metadata` (`jsonb`)
- `created_at`
- `updated_at`

### `evidence_items`

- `id`
- `project_id`
- `asset_id` (nullable)
- `creator_answer_id` (nullable)
- `type`
- `claim`
- `source_excerpt`
- `confidence` (nullable)
- `verification_status`
- `correction` (nullable)
- `created_at`
- `updated_at`

### `interview_questions`

- `id`
- `project_id`
- `question`
- `reason`
- `sequence_order`
- `created_at`

### `interview_answers`

- `id`
- `question_id`
- `answer`
- `created_at`
- `updated_at`

### `voice_profiles`

- `id`
- `project_id`
- `profile` (`jsonb`)
- `evidence_item_ids` (`jsonb` array for the MVP)
- `approved_at`
- `created_at`
- `updated_at`

### `chapters`

- `id`
- `project_id`
- `title`
- `theme`
- `time_range_text`
- `status`
- `dedication`
- `created_at`
- `updated_at`

### `chapter_sections`

- `id`
- `chapter_id`
- `title`
- `body`
- `sequence_order`
- `asset_ids` (`jsonb` array for the MVP)
- `evidence_item_ids` (`jsonb` array for the MVP)
- `created_at`
- `updated_at`

### `processing_jobs`

- `id`
- `project_id`
- `asset_id` (nullable)
- `job_type`
- `status`
- `attempt_count`
- `last_error`
- `created_at`
- `updated_at`

## 9. AI contracts

All model calls use versioned prompts and schema-validated structured outputs.

### Collection analysis

Input: ordered images, creator captions, optional supporting text, and existing confirmed evidence.

Output: chapter proposal, observations, hypotheses, evidence candidates, and question candidates with source references.

### Interview generation

Input: accepted chapter framing, evidence ledger, and unresolved gaps.

Output: at most five ranked questions, each with a private rationale and the evidence gap it addresses.

### Voice profile

Input: approved direct quotations, transcript excerpts, writing samples, and creator descriptions.

Output: evidence-linked style traits, prohibited assumptions, and a confidence/coverage summary.

### Chapter composition

Input: accepted framing, confirmed/corrected evidence, approved voice profile, selected media order, and creator dedication.

Output: structured chapter sections, captions, evidence references, and a list of any claims that could not be supported.

The composer must fail closed: if a factual sentence lacks evidence, it is omitted or returned as a question rather than presented as fact.

## 10. Processing and data flow

1. The application creates a project and subject in PostgreSQL.
2. The media service generates a short-lived upload URL.
3. The browser uploads directly to private Cloud Storage.
4. The application validates object metadata and creates an asset record.
5. A Cloud Task triggers image analysis, transcription, or restoration.
6. The worker stores validated results and updates job status.
7. Once minimum assets are ready, the creator requests collection analysis.
8. GPT-5.6 returns structured proposals and evidence candidates.
9. The creator approves the framing and answers targeted questions.
10. The system updates verification states and builds the voice profile.
11. The composer produces a provenance-linked draft.
12. The creator edits and publishes it.
13. The publishing service resolves a revocable share token and serves authorized media through short-lived URLs or an authenticated proxy.

## 11. Error handling

- Upload failures remain resumable and never create a completed asset record prematurely.
- Unsupported file types and oversized files are rejected before processing.
- Processing jobs are idempotent and may retry transient provider failures with capped exponential backoff.
- Permanent failures preserve the original upload and present a plain-language retry or skip option.
- Invalid model output is never persisted as trusted evidence; the call is retried once with validation feedback and then surfaced as a recoverable failure.
- Restoration failure never blocks story creation.
- Transcription failure allows the creator to paste or type a transcript.
- Publication is blocked when the chapter has no approved evidence or contains unresolved provenance errors.
- Project deletion revokes sharing immediately and schedules deletion of originals, derivatives, database records, and provider-side artifacts where supported.

## 12. Privacy and safety

- Buckets are private by default.
- Share links are unlisted, revocable, and represented by hashed tokens at rest.
- API keys are stored in Secret Manager.
- Logs contain object IDs and job IDs, not media contents, transcripts, or narrative text.
- The product states that creators should have permission to upload and share the material.
- Living-subject material requires a visible consent reminder before publishing.
- The MVP does not synthesize a person's cloned voice.
- Restored images are labeled and never replace originals.
- A creator can permanently delete the project.

## 13. Testing strategy

### Unit tests

- Schema validation for every AI contract
- Evidence-state transitions
- Provenance coverage checks
- Share-token creation, hashing, and revocation behavior
- File validation and object-key authorization
- Idempotent job handling

### Integration tests

- Signed upload completion to asset creation
- Mocked OpenAI analysis to evidence persistence
- Transcription fallback behavior
- Chapter composition using only confirmed/corrected evidence
- Project deletion across database and object storage adapters

### End-to-end tests

- Create project, upload three images, accept framing, answer questions, compose, edit, publish, and open the recipient link
- Recover from one failed asset-processing job without losing the project
- Reject or correct a proposed fact and verify it does not appear incorrectly in the final chapter

### Demo fixture

The repository includes a rights-cleared sample collection with three to five images, captions, expected evidence, and a completed example chapter. Judges can exercise the happy path without supplying private family media.

## 14. Success criteria

The MVP succeeds when:

- A creator can complete the happy path in under fifteen minutes after uploads finish.
- The final story contains no unverified factual claims presented as certain.
- Every generated section retains machine-readable provenance.
- The result feels like a coherent gift rather than a generated report.
- A recipient can view it without an account.
- The full flow can be demonstrated clearly in under three minutes.
- The README explains setup, sample data, architecture, Codex collaboration, and GPT-5.6 usage.

## 15. Hackathon demonstration

The demo will show:

1. Five imperfect family photographs entering the Studio.
2. GPT-5.6 identifying a plausible chapter and explaining the media connection.
3. The Studio surfacing uncertainty and asking three meaningful questions.
4. The creator confirming and correcting the family record.
5. A grounded narrative appearing in a subject-informed written voice.
6. A private, polished gift page with optional restoration comparison.

The submission will emphasize that Codex accelerated product design, architecture, implementation, testing, and documentation, while the running product uses GPT-5.6 for multimodal understanding, guided interviewing, evidence extraction, and narrative composition.

## 16. External references

- OpenAI GPT-5.6 model guidance: https://developers.openai.com/api/docs/models/gpt-5.6-sol
- OpenAI transcription model: https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- Google Cloud Run overview: https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run
- Google Cloud Storage signed URLs: https://docs.cloud.google.com/storage/docs/access-control/signed-urls
- Google Cloud Run configuration and Secret Manager integration: https://docs.cloud.google.com/run/docs/configuring
