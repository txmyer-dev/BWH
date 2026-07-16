import {describe, expect, it} from 'vitest';

import {beginFilmPreparation, completeFilmPreparation, initialFilmUiState} from './film-ui-state';

describe('film UI state', () => {
  it('moves from a single preparation action to a private download', () => {
    expect(beginFilmPreparation(initialFilmUiState)).toEqual({status: 'preparing', downloadUrl: null});
    expect(completeFilmPreparation('https://signed.example/film.mp4')).toEqual({status: 'ready', downloadUrl: 'https://signed.example/film.mp4'});
  });
});
