import type {RenderStatus} from './render-polling';

export type FilmUiState = {
  status: 'idle'|'pending'|'processing'|'ready'|'failed'|'superseded';
  jobId: string|null;
  downloadUrl: string|null;
  error: string|null;
};

export const initialFilmUiState: FilmUiState = {
  status: 'idle',
  jobId: null,
  downloadUrl: null,
  error: null
};

export const beginFilmPreparation = (current: FilmUiState): FilmUiState => {
  void current;
  return {
    status: 'pending',
    jobId: null,
    downloadUrl: null,
    error: null
  };
};

export const completeFilmPreparation = (downloadUrl: string): FilmUiState => ({
  status: 'ready',
  jobId: null,
  downloadUrl,
  error: null
});

export const failFilmPreparation = (error: string): FilmUiState => ({
  status: 'failed',
  jobId: null,
  downloadUrl: null,
  error
});

export const applyRenderStatus = (
  current: FilmUiState,
  render: RenderStatus
): FilmUiState => {
  if (render.status === 'completed') {
    return {...current, status: 'ready', jobId: render.jobId ?? null, error: null};
  }
  return {
    status: render.status,
    jobId: render.jobId ?? null,
    downloadUrl: null,
    error: render.error ?? null
  };
};
