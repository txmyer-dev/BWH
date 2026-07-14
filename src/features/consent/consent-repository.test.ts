import {describe, expect, it} from 'vitest';

import type {Database} from '../../server/db/client';
import {PostgresConsentRepository} from './consent-repository';

describe('PostgresConsentRepository consent replacement', () => {
  it('takes a transaction-scoped project-purpose lock before replacing valid consent', async () => {
    const events: string[] = [];
    const row = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      purpose: 'storage' as const,
      documentVersion: '2026-07-14.1',
      providers: ['google_cloud_storage'],
      dataCategories: ['original_media'],
      permissionConfirmed: true as const,
      acceptedAt: new Date('2026-07-14T12:00:00Z'),
      invalidatedAt: null,
      snapshotHash: 'a'.repeat(64)
    };
    const transaction = {
      execute: async () => { events.push('lock'); },
      update: () => ({
        set: () => ({where: async () => { events.push('invalidate'); }})
      }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            events.push('insert');
            return [row];
          }
        })
      })
    };
    const database = {
      transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) =>
        operation(transaction)
    } as unknown as Database;

    const repository = new PostgresConsentRepository(database);
    await expect(repository.accept(row)).resolves.toMatchObject({id: row.id});
    expect(events).toEqual(['lock', 'invalidate', 'insert']);
  });

  it('takes the same project-purpose lock before explicit invalidation', async () => {
    const events: string[] = []; const id = crypto.randomUUID();
    const transaction = {select: () => ({from: () => ({where: () => ({limit: async () => [{projectId: crypto.randomUUID(), purpose: 'processing'}]})})}), execute: async () => { events.push('lock'); }, update: () => ({set: () => ({where: async () => { events.push('invalidate'); }})})};
    const database = {transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction)} as unknown as Database;
    await new PostgresConsentRepository(database).invalidate(id, new Date());
    expect(events).toEqual(['lock', 'invalidate']);
  });
});
