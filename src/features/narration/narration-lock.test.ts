import {describe, expect, it, vi} from 'vitest';

import {lockNarrationProject} from './narration-lock';

describe('canonical narration mutation lock', () => {
  it('issues the project narration advisory lock as the caller first transaction action', async () => {
    const events: string[] = [];
    const transaction = {execute: vi.fn(async () => { events.push('narration'); })};

    await lockNarrationProject(transaction as never, crypto.randomUUID());
    events.push('domain-row');

    expect(events).toEqual(['narration', 'domain-row']);
  });
});
