import {randomUUID} from 'node:crypto';
import {and, eq, inArray, lte, or, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {processingJobs} from '../../server/db/schema';

export type RenderJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'superseded';

export type RenderJobRecord = {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  attemptCount: number;
  processingStartedAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
  lastError: string | null;
};

export type RenderJobClaim =
  | {outcome: 'claimed'; job: RenderJobRecord}
  | {outcome: 'busy' | 'missing'};

export interface RenderJobRepository {
  request(projectId: string): Promise<{job: RenderJobRecord; created: boolean}>;
  latest(projectId: string): Promise<RenderJobRecord | undefined>;
  claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim>;
  complete(jobId: string, leaseToken: string): Promise<void>;
  fail(jobId: string, leaseToken: string, code: string): Promise<void>;
  failPendingLaunch(jobId: string, code: string): Promise<void>;
  supersedeProject(projectId: string): Promise<void>;
}

const mapRow = (row: typeof processingJobs.$inferSelect): RenderJobRecord => ({
  id: row.id,
  projectId: row.projectId,
  status: row.status as RenderJobStatus,
  attemptCount: row.attemptCount,
  processingStartedAt: row.processingStartedAt,
  leaseExpiresAt: row.leaseExpiresAt,
  leaseToken: row.leaseToken,
  lastError: row.lastError
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
    const findActive = () => this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: same, inArray: oneOf}) => all(
        same(table.projectId, projectId),
        same(table.jobType, 'render_film'),
        oneOf(table.status, ['pending', 'processing'])
      )
    });
    const active = await findActive();
    if (active) return {job: mapRow(active), created: false};

    const [created] = await this.database.insert(processingJobs).values({
      id: randomUUID(), projectId, jobType: 'render_film'
    }).onConflictDoNothing().returning();
    if (created) return {job: mapRow(created), created: true};

    const winner = await findActive();
    if (!winner) throw new Error('RENDER_JOB_CREATE_FAILED');
    return {job: mapRow(winner), created: false};
  }

  async claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim> {
    const leaseToken = randomUUID();
    const [claimed] = await this.database.update(processingJobs).set({
      status: 'processing',
      leaseToken,
      processingStartedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      attemptCount: sql`${processingJobs.attemptCount} + 1`,
      lastError: null,
      updatedAt: now
    }).where(and(
      eq(processingJobs.id, jobId),
      eq(processingJobs.projectId, projectId),
      eq(processingJobs.jobType, 'render_film'),
      or(
        eq(processingJobs.status, 'pending'),
        and(eq(processingJobs.status, 'processing'), lte(processingJobs.leaseExpiresAt, now))
      )
    )).returning();
    if (claimed) return {outcome: 'claimed', job: mapRow(claimed)};

    const existing = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: same}) => all(
        same(table.id, jobId),
        same(table.projectId, projectId),
        same(table.jobType, 'render_film')
      )
    });
    return existing ? {outcome: 'busy'} : {outcome: 'missing'};
  }

  async complete(jobId: string, leaseToken: string) {
    const [completed] = await this.database.update(processingJobs).set({
      status: 'completed', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()
    }).where(and(
      eq(processingJobs.id, jobId),
      eq(processingJobs.jobType, 'render_film'),
      eq(processingJobs.status, 'processing'),
      eq(processingJobs.leaseToken, leaseToken)
    )).returning({id: processingJobs.id});
    if (!completed) throw new Error('RENDER_JOB_LEASE_LOST');
  }

  async fail(jobId: string, leaseToken: string, code: string) {
    const [failed] = await this.database.update(processingJobs).set({
      status: 'failed', lastError: code, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()
    }).where(and(
      eq(processingJobs.id, jobId),
      eq(processingJobs.jobType, 'render_film'),
      eq(processingJobs.status, 'processing'),
      eq(processingJobs.leaseToken, leaseToken)
    )).returning({id: processingJobs.id});
    if (!failed) throw new Error('RENDER_JOB_LEASE_LOST');
  }

  async failPendingLaunch(jobId: string, code: string) {
    await this.database.update(processingJobs).set({
      status: 'failed', lastError: code, updatedAt: new Date()
    }).where(and(
      eq(processingJobs.id, jobId),
      eq(processingJobs.jobType, 'render_film'),
      eq(processingJobs.status, 'pending')
    ));
  }

  async supersedeProject(projectId: string) {
    await this.database.update(processingJobs).set({
      status: 'superseded',
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: 'RENDER_SUPERSEDED',
      updatedAt: new Date()
    }).where(and(
      eq(processingJobs.projectId, projectId),
      eq(processingJobs.jobType, 'render_film'),
      inArray(processingJobs.status, ['pending', 'processing', 'completed'])
    ));
  }
}

export class InMemoryRenderJobRepository implements RenderJobRepository {
  private readonly rows = new Map<string, RenderJobRecord>();

  async latest(projectId: string) {
    const job = [...this.rows.values()].filter((row) => row.projectId === projectId).at(-1);
    return job ? structuredClone(job) : undefined;
  }

  async request(projectId: string) {
    const active = [...this.rows.values()].find((row) =>
      row.projectId === projectId && (row.status === 'pending' || row.status === 'processing')
    );
    if (active) return {job: structuredClone(active), created: false};

    const job: RenderJobRecord = {
      id: randomUUID(), projectId, status: 'pending', attemptCount: 0,
      processingStartedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: null
    };
    this.rows.set(job.id, job);
    return {job: structuredClone(job), created: true};
  }

  async claim(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<RenderJobClaim> {
    const row = this.rows.get(jobId);
    if (!row || row.projectId !== projectId) return {outcome: 'missing'};
    const leaseIsActive = row.status === 'processing' && (row.leaseExpiresAt === null || row.leaseExpiresAt > now);
    if (leaseIsActive || (row.status !== 'pending' && row.status !== 'processing')) return {outcome: 'busy'};

    const claimed: RenderJobRecord = {
      ...row,
      status: 'processing',
      attemptCount: row.attemptCount + 1,
      processingStartedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leaseToken: randomUUID(),
      lastError: null
    };
    this.rows.set(jobId, claimed);
    return {outcome: 'claimed', job: structuredClone(claimed)};
  }

  async complete(jobId: string, leaseToken: string) {
    this.transition(jobId, leaseToken, 'completed', null);
  }

  async fail(jobId: string, leaseToken: string, code: string) {
    this.transition(jobId, leaseToken, 'failed', code);
  }

  async failPendingLaunch(jobId: string, code: string) {
    const row = this.rows.get(jobId);
    if (row?.status === 'pending') this.rows.set(jobId, {...row, status: 'failed', lastError: code});
  }

  async supersedeProject(projectId: string) {
    for (const [id, row] of this.rows) {
      if (row.projectId === projectId && (row.status === 'pending' || row.status === 'processing' || row.status === 'completed')) {
        this.rows.set(id, {
          ...row, status: 'superseded', leaseToken: null, leaseExpiresAt: null, lastError: 'RENDER_SUPERSEDED'
        });
      }
    }
  }

  private transition(jobId: string, leaseToken: string, status: 'completed' | 'failed', lastError: string | null) {
    const row = this.rows.get(jobId);
    if (!row || row.status !== 'processing' || row.leaseToken !== leaseToken) throw new Error('RENDER_JOB_LEASE_LOST');
    this.rows.set(jobId, {...row, status, lastError, leaseToken: null, leaseExpiresAt: null});
  }
}
