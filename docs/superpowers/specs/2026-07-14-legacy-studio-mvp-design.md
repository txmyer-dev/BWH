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
7. The creator edits a scene-by-scene storyboard, chooses narration, and renders a downloadable Memory Film.

The guiding promise is:

> Their memories. Their voice. Beautifully preserved with your guidance.

## 2. Audience and job to be done

### Primary user

An adult child, grandchild, sibling, or other family member who is comfortable enough with technology to collect media and answer guided questions. The creator is making a gift for an aging relative, another family member, or future generations.

### Recipient

The recipient should not need an account or any familiarity with AI. They receive a downloadable MP4 film that can be watched, saved, copied, and shared like a familiar family video.

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

Chat-like interaction may support the workflow, but the final experience is a finished Memory Film, not a conversation transcript or generated report.

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
- Compose a draft film storyboard with source provenance.
- Edit the title, dedication, scenes, narration text, captions, and image order.
- Generate narration with a standard OpenAI voice by default.
- Offer Azure Speech as a secondary generated-narration provider when OpenAI narration is unavailable or unsuitable.
- Allow the creator to replace generated narration with an uploaded narration recording.
- Place authentic uploaded audio clips into selected scenes.
- Preview the approved storyboard and audio plan.
- Render a 1080p, 16:9 H.264 MP4 and provide a private, time-limited download.
- Display original/restored comparison when restoration is enabled.
- Delete a project and its stored media.

### Optional if the core path is complete

- One rights-cleared background music track with automatic volume ducking.
- Additional visual themes or transition styles.
- One external photo-restoration provider.

### Explicitly deferred

- Full email or social-account imports.
- Long-form video ingestion.
- Bulk media libraries.
- Multi-user collaboration.
- Recipient replies or interviews.
- Multiple chapters per project.
- Synthetic cloning of a person's voice.
- A full nonlinear video editor or arbitrary timeline controls.
- PDF, poster, or interactive web-story output.
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

### Step 6: Shape the film

The Studio builds a written voice profile from approved material. The profile can describe recurring expressions, sentence rhythm, humor, formality, values, and perspective. Each trait must cite supporting evidence. When evidence is sparse, the narrative uses a restrained editorial voice rather than simulating the subject.

GPT-5.6 produces a film storyboard with:

- Opening title scene
- Three to seven media scenes
- Narration and on-screen captions for each scene
- Placement of authentic uploaded audio clips
- A closing reflection
- Creator-written dedication and end card

The creator can edit every field, reorder scenes, adjust scene duration, and regenerate an individual scene without replacing approved work elsewhere. The MVP is a guided storyboard editor, not a general-purpose video timeline.

### Narration model

The default path uses a standard built-in OpenAI narration voice reading the approved subject-informed script. The narrator is not presented as the subject. The creator selects from a small curated voice set and hears a short sample before rendering.

Azure Speech is the secondary generated-narration provider. A provider failure never silently changes the approved voice: the Studio explains that the preferred narrator is unavailable, offers an Azure voice sample, and requires creator approval before switching providers.

The creator-recorded path allows the creator to upload a complete narration recording instead. The recording follows the approved script, and the creator can adjust scene durations to match it. Authentic clips supplied with the source collection may replace or interrupt narration in selected scenes.

The film includes a restrained end-credit disclosure when generated narration is used: “Narration created with an AI-generated voice from OpenAI” or “Narration created with an AI-generated voice from Microsoft Azure,” according to the selected provider. The MVP never clones the subject's voice.

### Step 7: Prepare the gift

The final gift is a downloadable Memory Film: a 1080p, 16:9 H.264 MP4 intended to run approximately two to four minutes. It uses one polished visual theme, restrained pan-and-zoom movement, crossfades, readable title cards, captions, narration, and authentic audio clips where available.

The creator reviews the storyboard and audio plan before rendering. Rendering runs asynchronously and produces a private Cloud Storage object. The creator previews the completed film in the Studio and downloads it through a short-lived signed URL. Once downloaded, the MP4 itself is the gift; the recipient does not need the Studio, an account, or a share link.

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

Every generated scene records the evidence item IDs used to compose its narration and captions. The editing interface may summarize provenance without exposing implementation jargon, for example: “Based on photos 1 and 3 and your answer about the train station.”

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
- **Narration:** OpenAI Speech API with a standard built-in voice and a configurable supported speech model
- **Backup narration:** Microsoft Azure Speech with a standard neural voice
- **Film composition:** Remotion scene components rendered with an FFmpeg-capable container
- **Film rendering:** an on-demand Google Cloud Run Job
- **Restoration:** optional third-party restoration adapter behind a provider-neutral interface

A single TypeScript application keeps the seven-day build coherent. It serves the web UI and API routes from Cloud Run. Analysis and transcription work is dispatched to idempotent processing handlers through Cloud Tasks. Approved films are rendered by a separate on-demand Cloud Run Job so CPU-heavy video work cannot block the interactive application.

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

#### Storyboard composer

Builds the grounded voice profile, composes scene drafts from approved evidence, checks provenance coverage, and supports scene-level regeneration.

#### Narration service

Implements a provider-neutral narration interface with OpenAI as the default and Azure Speech as the explicit secondary provider. It stores creator narration, places authentic clips, records the required provider-specific generated-voice disclosure, and calculates audio durations for the storyboard.

#### Render service

Creates immutable render manifests, launches an on-demand Cloud Run Job, renders the Remotion composition to an H.264 MP4, stores the result privately, and issues a short-lived download URL to the creator.

## 8. Data model

### `projects`

- `id`
- `title`
- `creator_name`
- `creator_relationship`
- `gift_intention`
- `status`
- `rendered_film_object_key` (nullable)
- `rendered_at` (nullable)
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

### `storyboards`

- `id`
- `project_id`
- `title`
- `theme`
- `time_range_text`
- `status`
- `dedication`
- `narration_source` (`openai`, `azure`, `creator`)
- `narrator_voice` (nullable)
- `creator_narration_asset_id` (nullable)
- `target_duration_seconds`
- `render_manifest` (`jsonb`, nullable)
- `created_at`
- `updated_at`

### `film_scenes`

- `id`
- `storyboard_id`
- `scene_type` (`title`, `media`, `original_audio`, `dedication`, `credits`)
- `title`
- `narration_text`
- `caption_text`
- `duration_seconds`
- `sequence_order`
- `asset_ids` (`jsonb` array for the MVP)
- `evidence_item_ids` (`jsonb` array for the MVP)
- `generated_narration_object_key` (nullable)
- `motion_preset`
- `transition_preset`
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

### Storyboard composition

Input: accepted framing, confirmed/corrected evidence, approved voice profile, selected media order, and creator dedication.

Output: ordered film scenes containing narration, captions, media references, timing guidance, transition presets, evidence references, authentic-clip placement, and a list of claims that could not be supported.

The composer must fail closed: if a factual sentence lacks evidence, it is omitted or returned as a question rather than presented as fact.

### Narration generation

Input: the creator-approved narration text for each scene, selected provider and standard voice, and restrained direction for pacing and tone.

Output: generated narration audio per scene, provider and voice metadata, duration metadata, and a provider-specific disclosure that must be represented in the film credits.

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
11. The storyboard composer produces provenance-linked scenes.
12. The creator edits the storyboard and selects OpenAI, Azure, or creator narration; OpenAI is the default.
13. The narration service generates per-scene audio through the approved provider, or validates the uploaded creator narration track.
14. The application creates an immutable render manifest from the approved storyboard and audio plan.
15. The render service starts a Cloud Run Job that renders the Remotion composition and stores the MP4 in private Cloud Storage.
16. The creator previews the completed film and downloads it through a short-lived signed URL.

## 11. Error handling

- Upload failures remain resumable and never create a completed asset record prematurely.
- Unsupported file types and oversized files are rejected before processing.
- Processing jobs are idempotent and may retry transient provider failures with capped exponential backoff.
- Permanent failures preserve the original upload and present a plain-language retry or skip option.
- Invalid model output is never persisted as trusted evidence; the call is retried once with validation feedback and then surfaced as a recoverable failure.
- Restoration failure never blocks story creation.
- Transcription failure allows the creator to paste or type a transcript.
- Narration-generation failure offers retry, an explicitly approved switch to Azure Speech, or creator-narration upload and does not discard the approved storyboard.
- Generated narration never switches providers or voices silently after the creator has approved a sample.
- Film rendering is blocked when the storyboard has no approved evidence, contains unresolved provenance errors, lacks usable narration, or exceeds the configured duration limit.
- Render jobs are idempotent. A failed render preserves its manifest and can be retried without regenerating the story or narration.
- A completed MP4 is not exposed through a permanent public URL.
- Project deletion immediately invalidates future downloads and schedules deletion of originals, derivatives, narration, rendered films, database records, and provider-side artifacts where supported.

## 12. Privacy and safety

- Buckets are private by default.
- Rendered films are available to the creator only through short-lived signed download URLs.
- API keys are stored in Secret Manager.
- Logs contain object IDs and job IDs, not media contents, transcripts, or narrative text.
- The product states that creators should have permission to upload and share the material.
- Living-subject material requires a visible consent reminder before rendering.
- The MVP does not synthesize a person's cloned voice.
- Generated narration uses a standard OpenAI or Azure voice and is clearly disclosed with its provider in the film credits.
- Restored images are labeled and never replace originals.
- A creator can permanently delete the project.

## 13. Testing strategy

### Unit tests

- Schema validation for every AI contract
- Evidence-state transitions
- Provenance coverage checks
- File validation and object-key authorization
- Idempotent job handling
- Render-manifest generation and duration calculations
- Scene-to-audio timing and disclosure-credit enforcement

### Integration tests

- Signed upload completion to asset creation
- Mocked OpenAI analysis to evidence persistence
- Transcription fallback behavior
- Storyboard composition using only confirmed/corrected evidence
- OpenAI, Azure Speech, and creator-narration adapter behavior
- Provider failure requires explicit creator approval before a voice or provider change
- Render job invocation, status updates, and signed film download
- Project deletion across database and object storage adapters

### End-to-end tests

- Create project, upload three images, accept framing, answer questions, compose scenes, generate narration, render, preview, and download the MP4
- Recover from one failed asset-processing job without losing the project
- Reject or correct a proposed fact and verify it does not appear incorrectly in the final film
- Replace generated narration with a creator-uploaded narration track and render successfully

### Demo fixture

The repository includes a rights-cleared sample collection with three to five images, one authentic audio clip, captions, expected evidence, a completed storyboard, and a short rendered example film. Judges can exercise the happy path without supplying private family media.

## 14. Success criteria

The MVP succeeds when:

- A creator can complete the happy path in under fifteen minutes after uploads finish.
- The final film contains no unverified factual claims presented as certain.
- Every generated scene retains machine-readable provenance.
- The rendered gift is a playable 1080p H.264 MP4 lasting approximately two to four minutes.
- The result feels like a coherent keepsake film rather than an automated slideshow.
- The creator can download the film, and the recipient can play the MP4 without a Legacy Studio account.
- Generated narration is disclosed with its provider in the end credits, Azure Speech can serve as the approved backup, and creator narration can replace either provider.
- The full flow can be demonstrated clearly in under three minutes.
- The README explains setup, sample data, architecture, Codex collaboration, and GPT-5.6 usage.

## 15. Hackathon demonstration

The demo will show:

1. Five imperfect family photographs entering the Studio.
2. GPT-5.6 identifying a plausible chapter and explaining the media connection.
3. The Studio surfacing uncertainty and asking three meaningful questions.
4. The creator confirming and correcting the family record.
5. A grounded storyboard appearing in a subject-informed written voice.
6. Standard OpenAI narration generated for the approved scenes, with an authentic uploaded clip placed in context.
7. A polished Memory Film rendered and downloaded as an MP4.

The submission will emphasize that Codex accelerated product design, architecture, implementation, testing, and documentation, while the running product uses GPT-5.6 for multimodal understanding, guided interviewing, evidence extraction, and narrative composition.

## 16. External references

- OpenAI GPT-5.6 model guidance: https://developers.openai.com/api/docs/models/gpt-5.6-sol
- OpenAI transcription model: https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- OpenAI speech generation and disclosure guidance: https://developers.openai.com/api/docs/guides/text-to-speech
- Microsoft Azure Speech text-to-speech overview: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
- Microsoft Azure Speech JavaScript/TypeScript quickstart: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-text-to-speech?pivots=programming-language-javascript
- Google Cloud Run overview: https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run
- Google Cloud Storage signed URLs: https://docs.cloud.google.com/storage/docs/access-control/signed-urls
- Google Cloud Run configuration and Secret Manager integration: https://docs.cloud.google.com/run/docs/configuring
