import {expect, it} from 'vitest';

import {storyboardErrorStatus} from './response-status';

it('maps stale storyboard writes to HTTP 409', () => {
  expect(storyboardErrorStatus('STORYBOARD_CONFLICT')).toBe(409);
});
