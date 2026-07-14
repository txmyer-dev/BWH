import {
  check,
  integer,
  jsonb,
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
      .where(sql`${table.status} IN ('pending', 'processing', 'failed')`)
  ]
);
