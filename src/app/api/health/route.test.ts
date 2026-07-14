import {describe, expect, it} from 'vitest';
import {GET} from './route';

describe('GET /api/health', () => {
  it('reports a healthy service', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({status: 'ok'});
  });
});
