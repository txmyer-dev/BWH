export type FilmUiState = {status: 'idle'|'preparing'|'ready'; downloadUrl: string|null};

export const initialFilmUiState: FilmUiState = {status: 'idle', downloadUrl: null};
export const beginFilmPreparation = (_current: FilmUiState): FilmUiState => ({status: 'preparing', downloadUrl: null});
export const completeFilmPreparation = (downloadUrl: string): FilmUiState => ({status: 'ready', downloadUrl});
