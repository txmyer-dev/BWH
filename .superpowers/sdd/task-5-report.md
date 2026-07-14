# Task 5 implementation report

## Outcome

Implemented owner-scoped guided questions, explicit creator answers and evidence review, evidence-linked voice profiles, and a transactional storyboard workflow with explicit scene editing, ordering, and single-scene regeneration.

## TDD evidence

- Initial RED: `npm test -- src/features/story/story-service.test.ts` failed because `story-service` and its orchestration methods did not exist.
- First GREEN: 5/5 focused guardrail tests passed.
- Edge-case RED: narration edits without provenance were accepted; model-hypothesis-only input was also specified as non-factual.
- Structured-output RED: OpenAI's strict structured-output helper rejected an array root for guided questions.
- Final initial GREEN: 17/17 focused story tests passed without network access or credential access.

## Guardrails and behavior

- Questions are ranked, non-leading, derived from material gaps, persisted idempotently, and capped at five.
- Storyboards fail closed without confirmed/corrected non-hypothesis evidence.
- Generated factual narration sentences and written-voice traits require project-owned approved evidence IDs.
- Proposed, rejected, and model-hypothesis evidence cannot become factual storyboard input.
- Scene asset/evidence references are project-bound; cross-project IDs are rejected.
- Scene and storyboard schemas accept only the approved motion and transition presets.
- Total storyboard duration remains within 120–240 seconds, including concurrent database mutations.
- Storyboard/question creation and answer/scene mutations use transactions and advisory locks where concurrent writes can collide.
- Single-scene regeneration preserves every other scene ID, order, and creator edit.
- Editing, reordering, saving, and regeneration occur only after explicit creator actions.
- Every project route checks the owner token before returning or mutating private data.
- The OpenAI story boundary retains exact model `gpt-5.6`, developer instructions before JSON-serialized untrusted evidence, and strict Zod output schemas.

## Creator experience

- Added the exact stepper: Pieces → Story → Questions → Record → Film.
- Hypotheses and proposed details appear as “Needs your help.”
- Added explicit confirm, correct, reject, save-answer, save-scene, save-order, and regenerate-one-scene controls.
- Added evidence-linked written-voice traits, draggable scene ordering, keyboard-accessible move controls, focus states, and plain-language status messages without model jargon.

## Verification

- Focused remediation suite: 27/27 passed.
- Full suite: 88/88 passed across 19 files.
- Lint: passed with zero warnings.
- Typecheck: passed.
- Production build: passed.
- Database generation: `No schema changes, nothing to migrate`.
- `git diff --check`: passed (line-ending conversion notices only).

## Self-review

Reviewed the exact diff from base `09048a46c49a8abd9aae28d8198b300ff9f0a27e`. No live provider call was made during testing, no credential value was read or logged, and no model fallback was introduced. Scope is limited to guided questions, creator record review/answers, written voice, storyboard composition/editing, supporting routes, and the project-page workflow required by Task 5.

## Review remediation

The first Task 5 review identified four Important findings and one low-risk Minor finding. Each was reproduced with a focused failing test before remediation:

- **Dirty draft preservation:** Server storyboard responses are merged by scene ID and server order while locally dirty scenes retain all unsaved fields. Saving or regenerating scene B clears only B; dirty scene A survives B's response and a reorder response.
- **Effective corrected facts:** Corrected evidence is projected into a dedicated story-input shape whose claim and source excerpt contain only the creator correction. The known-wrong original remains in the evidence ledger for audit but is absent from question, storyboard, voice-profile, and OpenAI inputs. The editor displays the correction as current truth and labels the original separately.
- **Optimistic concurrency:** Storyboards now persist an integer revision in the squashed initial migration. Every scene save, add, reorder, and regeneration requires an expected revision. PostgreSQL checks it under the storyboard advisory lock and atomically increments it with the mutation. Stale requests return `STORYBOARD_CONFLICT` / HTTP 409. A delayed regeneration cannot overwrite an intervening edit.
- **Complete explicit editor:** The accessible scene editor exposes and explicitly saves scene type, title, narration, caption, duration, asset IDs, evidence IDs, motion preset, and transition preset. Strict schemas, project ownership, approved evidence, factual provenance, approved enums, and the 120–240 second total are revalidated on every mutation.
- **Authorization order:** Evidence mutation authorizes the requested project before evidence lookup, preventing evidence-ID association probing.

Remediation gates:

- Focused story/API suite: 27/27 passed.
- Full suite: 88/88 passed across 19 files.
- Lint, typecheck, and production build: passed.
- Database generation after squashing `revision` into migration `0000`: `No schema changes, nothing to migrate`.
- Original-base `git diff --check`: passed (line-ending conversion notices only).
