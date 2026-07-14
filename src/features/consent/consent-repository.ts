import {and, desc, eq, isNull, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {projectConsents} from '../../server/db/schema';
import type {ConsentPurpose, ConsentSnapshot} from './schemas';

type StoredConsent = ConsentSnapshot & {permissionConfirmed: true};

export interface ConsentRepository {
  accept(input: StoredConsent): Promise<ConsentSnapshot>;
  findValid(projectId: string, purpose: ConsentPurpose): Promise<ConsentSnapshot | undefined>;
  invalidate(id: string, at: Date): Promise<void>;
}

const clone = (snapshot: ConsentSnapshot): ConsentSnapshot => ({
  ...snapshot,
  providers: [...snapshot.providers],
  dataCategories: [...snapshot.dataCategories],
  acceptedAt: new Date(snapshot.acceptedAt),
  invalidatedAt: snapshot.invalidatedAt ? new Date(snapshot.invalidatedAt) : null
});

const mapRow = (row: typeof projectConsents.$inferSelect): ConsentSnapshot => ({
  id: row.id,
  projectId: row.projectId,
  purpose: row.purpose as ConsentPurpose,
  documentVersion: row.documentVersion,
  providers: row.providers as string[],
  dataCategories: row.dataCategories as string[],
  snapshotHash: row.snapshotHash,
  acceptedAt: row.acceptedAt,
  invalidatedAt: row.invalidatedAt
});

export class InMemoryConsentRepository implements ConsentRepository {
  private readonly snapshots = new Map<string, StoredConsent>();

  async accept(input: StoredConsent) {
    for (const snapshot of this.snapshots.values()) {
      if (
        snapshot.projectId === input.projectId &&
        snapshot.purpose === input.purpose &&
        snapshot.invalidatedAt === null
      ) {
        snapshot.invalidatedAt = new Date(input.acceptedAt);
      }
    }
    this.snapshots.set(input.id, clone(input) as StoredConsent);
    return clone(input);
  }

  async findValid(projectId: string, purpose: ConsentPurpose) {
    return [...this.snapshots.values()]
      .filter((item) => item.projectId === projectId && item.purpose === purpose && item.invalidatedAt === null)
      .sort((left, right) => right.acceptedAt.getTime() - left.acceptedAt.getTime())
      .map(clone)[0];
  }

  async invalidate(id: string, at: Date) {
    const snapshot = this.snapshots.get(id);
    if (snapshot && snapshot.invalidatedAt === null) snapshot.invalidatedAt = new Date(at);
  }
}

export class PostgresConsentRepository implements ConsentRepository {
  constructor(private readonly database: Database) {}

  async accept(input: StoredConsent) {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.projectId}), hashtext(${input.purpose}))`
      );
      await transaction
        .update(projectConsents)
        .set({invalidatedAt: input.acceptedAt})
        .where(and(
          eq(projectConsents.projectId, input.projectId),
          eq(projectConsents.purpose, input.purpose),
          isNull(projectConsents.invalidatedAt)
        ));
      const [created] = await transaction.insert(projectConsents).values(input).returning();
      return mapRow(created);
    });
  }

  async findValid(projectId: string, purpose: ConsentPurpose) {
    const row = await this.database.query.projectConsents.findFirst({
      where: (table, {and: all, eq: equals, isNull: nullValue}) =>
        all(equals(table.projectId, projectId), equals(table.purpose, purpose), nullValue(table.invalidatedAt)),
      orderBy: (table) => desc(table.acceptedAt)
    });
    return row ? mapRow(row) : undefined;
  }

  async invalidate(id: string, at: Date) {
    await this.database.transaction(async (transaction) => {
      const [snapshot] = await transaction.select({projectId: projectConsents.projectId, purpose: projectConsents.purpose}).from(projectConsents).where(eq(projectConsents.id, id)).limit(1);
      if (!snapshot) return;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${snapshot.projectId}), hashtext(${snapshot.purpose}))`);
      await transaction.update(projectConsents).set({invalidatedAt: at}).where(and(eq(projectConsents.id, id), isNull(projectConsents.invalidatedAt)));
    });
  }
}
