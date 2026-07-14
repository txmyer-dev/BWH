# Task 5 implementation report

## Outcome

Implemented owner-scoped guided questions, explicit creator answers and evidence review, evidence-linked voice profiles, and a transactional storyboard workflow with explicit scene editing, ordering, and single-scene regeneration.

## TDD evidence

- Initial RED: `npm test -- src/features/story/story-service.test.ts` failed because `story-service` and its orchestration methods did not exist.
- First GREEN: 5/5 focused guardrail tests passed.
- Edge-case RED: narration edits without provenance were accepted; model-hypothesis-only input was also specified as non-factual.
- Structured-output RED: OpenAI's strict structured-output helper rejected an array root for guided questions.
- Final GREEN: 17/17 focused story tests pass without network access or credential access.

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

- Focused story suite: 17/17 passed.
- Full suite: 78/78 passed across 16 files.
- Lint: passed with zero warnings.
- Typecheck: passed.
- Production build: passed.
- Database generation: `No schema changes, nothing to migrate`.
- `git diff --check`: passed (line-ending conversion notices only).

## Self-review

Reviewed the exact diff from base `09048a46c49a8abd9aae28d8198b300ff9f0a27e`. No live provider call was made during testing, no credential value was read or logged, and no model fallback was introduced. Scope is limited to guided questions, creator record review/answers, written voice, storyboard composition/editing, supporting routes, and the project-page workflow required by Task 5.
