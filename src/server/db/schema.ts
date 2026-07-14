import {
  boolean,
  check,
  integer,
  jsonb,
  bigint,
  index,
  foreignKey,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';

const timestamps = {
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
};

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  title: varchar('title', {length: 160}).notNull(),
  creatorName: varchar('creator_name', {length: 120}).notNull(),
  creatorRelationship: varchar('creator_relationship', {length: 120}).notNull(),
  giftIntention: text('gift_intention'),
  status: varchar('status', {length: 40}).default('gathering').notNull(),
  ownerTokenHash: varchar('owner_token_hash', {length: 64}).notNull(),
  renderedFilmObjectKey: text('rendered_film_object_key'),
  renderedAt: timestamp('rendered_at', {withTimezone: true}),
  ...timestamps
});

export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    name: varchar('name', {length: 120}).notNull(),
    livingStatus: varchar('living_status', {length: 20})
      .default('unspecified')
      .notNull(),
    consentNotes: text('consent_notes'),
    ...timestamps
  },
  (table) => [uniqueIndex('subjects_project_id_unique').on(table.projectId)]
);

export const projectConsents = pgTable(
  'project_consents',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    purpose: varchar('purpose', {length: 20}).notNull(),
    documentVersion: varchar('document_version', {length: 80}).notNull(),
    providers: jsonb('providers').notNull(),
    dataCategories: jsonb('data_categories').notNull(),
    permissionConfirmed: boolean('permission_confirmed').notNull(),
    acceptedAt: timestamp('accepted_at', {withTimezone: true}).notNull(),
    invalidatedAt: timestamp('invalidated_at', {withTimezone: true}),
    snapshotHash: varchar('snapshot_hash', {length: 64}).notNull()
  },
  (table) => [
    check(
      'project_consents_purpose_check',
      sql`${table.purpose} IN ('storage', 'processing')`
    ),
    check(
      'project_consents_permission_confirmed_check',
      sql`${table.permissionConfirmed} = true`
    ),
    uniqueIndex('project_consents_valid_project_purpose_unique')
      .on(table.projectId, table.purpose)
      .where(sql`${table.invalidatedAt} IS NULL`)
  ]
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    type: varchar('type', {length: 20}).notNull(),
    assetKind: varchar('asset_kind', {length: 30}).notNull(),
    mimeType: varchar('mime_type', {length: 120}).notNull(),
    originalObjectKey: text('original_object_key').notNull(),
    derivativeObjectKey: text('derivative_object_key'),
    processingStatus: varchar('processing_status', {length: 30})
      .default('pending')
      .notNull(),
    processingError: text('processing_error'),
    caption: text('caption'),
    capturedAtText: text('captured_at_text'),
    sequenceOrder: integer('sequence_order').notNull(),
    reservationExpiresAt: timestamp('reservation_expires_at', {
      withTimezone: true
    }),
    metadata: jsonb('metadata').default({}).notNull(),
    ...timestamps
  },
  (table) => [
    check(
      'assets_kind_sequence_check',
      sql`(${table.assetKind} = 'image' AND ${table.sequenceOrder} BETWEEN 0 AND 6) OR (${table.assetKind} IN ('text', 'source_audio', 'creator_narration') AND ${table.sequenceOrder} = 0)`
    ),
    check(
      'assets_pending_expiry_check',
      sql`${table.processingStatus} <> 'pending' OR ${table.reservationExpiresAt} IS NOT NULL`
    ),
    uniqueIndex('assets_project_kind_sequence_unique')
      .on(table.projectId, table.assetKind, table.sequenceOrder)
      .where(sql`${table.processingStatus} <> 'cleanup_pending'`),
    uniqueIndex('assets_original_object_key_unique').on(table.originalObjectKey)
  ]
);

export const interviewQuestions = pgTable('interview_questions', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, {onDelete: 'cascade'}),
  question: text('question').notNull(),
  reason: text('reason').notNull(),
  sequenceOrder: integer('sequence_order').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
});

export const interviewAnswers = pgTable('interview_answers', {
  id: uuid('id').primaryKey(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => interviewQuestions.id, {onDelete: 'cascade'}),
  answer: text('answer').notNull(),
  ...timestamps
});

export const evidenceItems = pgTable('evidence_items', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, {onDelete: 'cascade'}),
  assetId: uuid('asset_id').references(() => assets.id, {onDelete: 'cascade'}),
  creatorAnswerId: uuid('creator_answer_id').references(
    () => interviewAnswers.id,
    {onDelete: 'cascade'}
  ),
  type: varchar('type', {length: 40}).notNull(),
  claim: text('claim').notNull(),
  originalClaim: text('original_claim').notNull(),
  sourceAssetIds: jsonb('source_asset_ids').default([]).notNull(),
  sourceExcerpt: text('source_excerpt').notNull(),
  confidence: real('confidence'),
  verificationStatus: varchar('verification_status', {length: 20})
    .default('proposed')
    .notNull(),
  correction: text('correction'),
  ...timestamps
});

export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    profile: jsonb('profile').notNull(),
    evidenceItemIds: jsonb('evidence_item_ids').notNull(),
    approvedAt: timestamp('approved_at', {withTimezone: true}),
    ...timestamps
  },
  (table) => [uniqueIndex('voice_profiles_project_id_unique').on(table.projectId)]
);

export const storyboards = pgTable(
  'storyboards',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    title: varchar('title', {length: 160}).notNull(),
    theme: text('theme').notNull(),
    timeRangeText: text('time_range_text'),
    status: varchar('status', {length: 30}).default('draft').notNull(),
    dedication: text('dedication'),
    narrationSource: varchar('narration_source', {length: 20})
      .default('openai')
      .notNull(),
    narratorVoice: varchar('narrator_voice', {length: 80}),
    creatorNarrationAssetId: uuid('creator_narration_asset_id').references(
      () => assets.id,
      {onDelete: 'set null'}
    ),
    targetDurationSeconds: integer('target_duration_seconds').default(180).notNull(),
    revision: integer('revision').default(0).notNull(),
    renderManifest: jsonb('render_manifest'),
    ...timestamps
  },
  (table) => [uniqueIndex('storyboards_project_id_unique').on(table.projectId)]
);

export const filmScenes = pgTable('film_scenes', {
  id: uuid('id').primaryKey(),
  storyboardId: uuid('storyboard_id')
    .notNull()
    .references(() => storyboards.id, {onDelete: 'cascade'}),
  sceneType: varchar('scene_type', {length: 30}).notNull(),
  title: text('title'),
  narrationText: text('narration_text'),
  captionText: text('caption_text'),
  durationSeconds: real('duration_seconds').notNull(),
  sequenceOrder: integer('sequence_order').notNull(),
  assetIds: jsonb('asset_ids').default([]).notNull(),
  evidenceItemIds: jsonb('evidence_item_ids').default([]).notNull(),
  authenticClip: jsonb('authentic_clip'),
  generatedNarrationObjectKey: text('generated_narration_object_key'),
  motionPreset: varchar('motion_preset', {length: 40}).notNull(),
  transitionPreset: varchar('transition_preset', {length: 40}).notNull(),
  ...timestamps
});

export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
    assetId: uuid('asset_id').references(() => assets.id, {onDelete: 'cascade'}),
    providerRunId: uuid('provider_run_id').references(() => providerRuns.id, {onDelete: 'cascade'}),
    jobType: varchar('job_type', {length: 40}).notNull(),
    status: varchar('status', {length: 30}).default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    processingStartedAt: timestamp('processing_started_at', {withTimezone: true}),
    leaseExpiresAt: timestamp('lease_expires_at', {withTimezone: true}),
    leaseToken: uuid('lease_token'),
    lastError: text('last_error'),
    ...timestamps
  },
  (table) => [
    uniqueIndex('processing_jobs_active_analysis_unique')
      .on(table.projectId, table.jobType)
      .where(sql`${table.status} IN ('pending', 'processing')`),
    uniqueIndex('processing_jobs_active_transcription_asset_unique')
      .on(table.projectId, table.assetId, table.jobType)
      .where(sql`${table.jobType} = 'transcribe_asset' AND ${table.status} IN ('pending', 'processing')`)
  ]
);

export const projectProviderBudgets = pgTable('project_provider_budgets', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, {onDelete: 'cascade'}),
  limitMicros: bigint('limit_micros', {mode: 'number'}).notNull(),
  reservedMicros: bigint('reserved_micros', {mode: 'number'}).default(0).notNull(),
  settledMicros: bigint('settled_micros', {mode: 'number'}).default(0).notNull(),
  requestLimit: integer('request_limit').notNull(),
  reservedRequests: integer('reserved_requests').default(0).notNull(),
  settledRequests: integer('settled_requests').default(0).notNull(),
  pricingVersion: varchar('pricing_version', {length: 40}).notNull(),
  ...timestamps
}, (table) => [
  check('project_provider_budgets_nonnegative_check', sql`${table.limitMicros} >= 0 AND ${table.reservedMicros} >= 0 AND ${table.settledMicros} >= 0`),
  check('project_provider_request_budgets_nonnegative_check', sql`${table.requestLimit} >= 0 AND ${table.reservedRequests} >= 0 AND ${table.settledRequests} >= 0`)
]);

export const providerRuns = pgTable('provider_runs', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
  consentId: uuid('consent_id').notNull().references(() => projectConsents.id, {onDelete: 'restrict'}),
  consentSnapshotHash: varchar('consent_snapshot_hash', {length: 64}).notNull(),
  dataCategories: jsonb('data_categories').notNull(),
  provider: varchar('provider', {length: 80}).notNull(),
  model: varchar('model', {length: 120}).notNull(),
  operation: varchar('operation', {length: 40}).notNull(),
  inputFingerprint: varchar('input_fingerprint', {length: 64}).notNull(),
  status: varchar('status', {length: 30}).notNull(),
  estimatedCostMicros: bigint('estimated_cost_micros', {mode: 'number'}).notNull(),
  reservedCostMicros: bigint('reserved_cost_micros', {mode: 'number'}).notNull(),
  settledCostMicros: bigint('settled_cost_micros', {mode: 'number'}),
  pricingVersion: varchar('pricing_version', {length: 40}).notNull(),
  requestCount: integer('request_count').default(0).notNull(),
  cacheHitCount: integer('cache_hit_count').default(0).notNull(),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', {withTimezone: true}),
  dispatchDeadlineAt: timestamp('dispatch_deadline_at', {withTimezone: true}),
  providerIdempotencyKey: varchar('provider_idempotency_key', {length: 120}).notNull(),
  retryOfRunId: uuid('retry_of_run_id'),
  activeResult: boolean('active_result').default(true).notNull(),
  lastError: text('last_error'),
  usageMetadata: jsonb('usage_metadata'),
  ...timestamps
}, (table) => [
  check('provider_runs_status_check', sql`${table.status} IN ('reserved','processing','dispatching','completed','failed','ambiguous','superseded_ambiguous','late_completed')`),
  check('provider_runs_cost_nonnegative_check', sql`${table.estimatedCostMicros} >= 0 AND ${table.reservedCostMicros} >= 0 AND (${table.settledCostMicros} IS NULL OR ${table.settledCostMicros} >= 0)`),
  uniqueIndex('provider_runs_active_success_fingerprint_unique').on(table.projectId, table.provider, table.model, table.operation, table.inputFingerprint).where(sql`${table.status} IN ('reserved','processing','dispatching','completed','ambiguous') AND ${table.activeResult} = true`),
  index('provider_runs_project_created_idx').on(table.projectId, table.createdAt),
  index('provider_runs_dispatch_deadline_idx').on(table.dispatchDeadlineAt).where(sql`${table.status} = 'dispatching'`),
  foreignKey({name: 'provider_runs_retry_of_run_id_provider_runs_id_fk', columns: [table.retryOfRunId], foreignColumns: [table.id]}).onDelete('set null'),
  index('provider_runs_retry_of_run_idx').on(table.retryOfRunId)
]);

export const providerRunResults = pgTable('provider_run_results', {
  providerRunId: uuid('provider_run_id').primaryKey().references(() => providerRuns.id, {onDelete: 'cascade'}),
  projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
  structuredResult: jsonb('structured_result').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [index('provider_run_results_project_idx').on(table.projectId)]);

export const assetTranscripts = pgTable('asset_transcripts', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
  assetId: uuid('asset_id').notNull().references(() => assets.id, {onDelete: 'cascade'}),
  providerRunId: uuid('provider_run_id').notNull().references(() => providerRuns.id, {onDelete: 'cascade'}),
  text: text('text').notNull(),
  language: varchar('language', {length: 40}),
  confidence: real('confidence'),
  durationMs: integer('duration_ms').notNull(),
  segments: jsonb('segments').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [
  uniqueIndex('asset_transcripts_asset_unique').on(table.assetId),
  uniqueIndex('asset_transcripts_provider_run_unique').on(table.providerRunId),
  index('asset_transcripts_project_idx').on(table.projectId),
  check('asset_transcripts_duration_positive_check', sql`${table.durationMs} > 0`),
  check('asset_transcripts_confidence_check', sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`)
]);

export const transcriptEvidenceSegments = pgTable('transcript_evidence_segments', {
  evidenceItemId: uuid('evidence_item_id').primaryKey().references(() => evidenceItems.id, {onDelete: 'cascade'}),
  transcriptId: uuid('transcript_id').notNull().references(() => assetTranscripts.id, {onDelete: 'cascade'}),
  projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
  assetId: uuid('asset_id').notNull().references(() => assets.id, {onDelete: 'cascade'}),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull()
}, (table) => [
  check('transcript_evidence_segments_bounds_check', sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`),
  index('transcript_evidence_segments_project_asset_idx').on(table.projectId, table.assetId)
]);

export const providerArtifacts = pgTable('provider_artifacts', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  providerRunId: uuid('provider_run_id'),
  provider: varchar('provider', {length: 80}).notNull(),
  providerArtifactId: text('provider_artifact_id').notNull(),
  status: varchar('status', {length: 30}).default('active').notNull(),
  expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  cleanupAttempts: integer('cleanup_attempts').default(0).notNull(),
  cleanupClaimToken: uuid('cleanup_claim_token'),
  cleanupLeaseExpiresAt: timestamp('cleanup_lease_expires_at', {withTimezone: true}),
  lastCleanupError: text('last_cleanup_error'),
  ...timestamps
}, (table) => [
  check('provider_artifacts_status_check', sql`${table.status} IN ('active','cleanup_pending','deletion_pending','cleanup_processing','deletion_processing','deleted','expired_confirmed')`),
  uniqueIndex('provider_artifacts_provider_identifier_unique').on(table.provider, table.providerArtifactId),
  index('provider_artifacts_cleanup_due_idx').on(table.status, table.expiresAt)
]);
