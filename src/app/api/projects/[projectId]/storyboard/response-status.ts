export const storyboardErrorStatus = (code: string) => code === 'PROJECT_FORBIDDEN'
  ? 403
  : code === 'STORYBOARD_CONFLICT'
    ? 409
    : code.endsWith('NOT_FOUND')
      ? 404
      : 400;
