import {describe, expect, it} from 'vitest';

import {createWaitingUploadStatus} from './upload-ui-state';

describe('upload UI state', () => {
  it('clears progress and reservation identity when content changes', () => {
    expect(createWaitingUploadStatus()).toEqual({
      progress: 0,
      status: 'waiting'
    });
    expect(createWaitingUploadStatus()).not.toHaveProperty('reservationId');
  });
});
