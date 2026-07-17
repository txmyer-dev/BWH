import {describe, expect, it} from 'vitest';
import {CREATOR_AUDIO_REVIEW_COPY, FACTUALITY_REVIEW_COPY} from './audit-copy';

describe('factuality workflow copy', () => {
  it('does not hardcode a provider outside consent disclosure', () => {
    const copy = `${FACTUALITY_REVIEW_COPY} ${CREATOR_AUDIO_REVIEW_COPY}`;
    expect(copy).toContain('configured factuality reviewer');
    expect(copy).not.toMatch(/OpenAI|Gemini/);
  });
});
