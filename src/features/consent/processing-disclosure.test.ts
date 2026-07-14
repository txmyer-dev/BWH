import {describe, expect, it} from 'vitest';
import {processingConsentDataCategories} from './processing-disclosure';

describe('processing consent disclosure', () => {
  it('truthfully covers both source recordings and creator narration sent to Deepgram', () => {
    expect(processingConsentDataCategories).toContain('source_audio');
    expect(processingConsentDataCategories).toContain('creator_narration');
  });
});
