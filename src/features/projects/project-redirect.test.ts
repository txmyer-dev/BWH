import {describe, expect, it} from 'vitest';
import {projectRedirect} from './project-redirect';

describe('projectRedirect', () => {
  it('uses a relative location and preserves the owner cookie', () => {
    const id = '315c5992-2b16-4a90-9788-bfe77dc5a15d';
    const response = projectRedirect(id, 'owner-secret');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/projects/${id}`);
    expect(response.headers.get('set-cookie')).toContain(`legacy_owner_${id}=owner-secret`);
    expect(response.headers.get('location')).not.toContain('localhost');
  });
});
