import {describe, expect, it} from 'vitest';

import {safeFilmRouteError} from './route-errors';

describe('safeFilmRouteError', () => {
  it('keeps approval and not-rendered failures recoverable without leaking internals', () => {
    expect(safeFilmRouteError(new Error('FILM_APPROVAL_REQUIRED'))).toEqual({code: 'FILM_APPROVAL_REQUIRED', status: 409});
    expect(safeFilmRouteError(new Error('FILM_NOT_RENDERED'))).toEqual({code: 'FILM_NOT_RENDERED', status: 409});
    expect(safeFilmRouteError(new Error('secret signed url https://example.test'))).toEqual({code: 'FILM_PREPARATION_FAILED', status: 500});
  });
});
