import {describe, expect, it} from 'vitest';

import {
  applyRenderStatus,
  beginFilmPreparation,
  completeFilmPreparation,
  failFilmPreparation,
  initialFilmUiState
} from './film-ui-state';

describe('film UI state', () => {
  it('moves from a single preparation action to a private download', () => {
    expect(beginFilmPreparation(initialFilmUiState)).toEqual({
      status: 'pending',
      jobId: null,
      downloadUrl: null,
      error: null
    });
    expect(completeFilmPreparation('https://signed.example/film.mp4')).toEqual({
      status: 'ready',
      jobId: null,
      downloadUrl: 'https://signed.example/film.mp4',
      error: null
    });
  });

  it('normalizes active and terminal render API statuses', () => {
    expect(applyRenderStatus(initialFilmUiState, {status: 'pending', jobId: 'job'}))
      .toEqual({status: 'pending', jobId: 'job', downloadUrl: null, error: null});
    expect(applyRenderStatus(initialFilmUiState, {status: 'processing', jobId: 'job'}))
      .toEqual({status: 'processing', jobId: 'job', downloadUrl: null, error: null});
    expect(applyRenderStatus(initialFilmUiState, {status: 'failed', jobId: 'job', error: 'RENDER_EXECUTION_FAILED'}))
      .toEqual({status: 'failed', jobId: 'job', downloadUrl: null, error: 'RENDER_EXECUTION_FAILED'});
    expect(applyRenderStatus(initialFilmUiState, {status: 'superseded', jobId: 'job', error: 'RENDER_SUPERSEDED'}))
      .toEqual({status: 'superseded', jobId: 'job', downloadUrl: null, error: 'RENDER_SUPERSEDED'});
  });

  it('restores an enabled terminal state after a launch failure', () => {
    expect(failFilmPreparation('RENDER_JOB_LAUNCH_FAILED')).toEqual({
      status: 'failed',
      jobId: null,
      downloadUrl: null,
      error: 'RENDER_JOB_LAUNCH_FAILED'
    });
  });
});
