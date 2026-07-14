import {expect, it, vi} from 'vitest';

import {authorizeEvidenceAccess} from './authorization';

it('authorizes the requested project before looking up an evidence ID', async () => {
  const calls: string[] = [];
  const authorize = vi.fn(async () => { calls.push('authorize'); throw new Error('PROJECT_FORBIDDEN'); });
  const findById = vi.fn(async () => { calls.push('lookup'); return undefined; });
  await expect(authorizeEvidenceAccess(crypto.randomUUID(), crypto.randomUUID(), authorize, {findById})).rejects.toThrow('PROJECT_FORBIDDEN');
  expect(calls).toEqual(['authorize']);
  expect(findById).not.toHaveBeenCalled();
});
