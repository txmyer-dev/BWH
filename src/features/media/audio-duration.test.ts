import {describe, expect, it} from 'vitest';
import {durationSecondsToMs} from './audio-duration';

describe('durationSecondsToMs', () => {
  it('normalizes finite browser audio duration to positive integer milliseconds', () => {
    expect(durationSecondsToMs(1.2346)).toBe(1235);
    expect(() => durationSecondsToMs(Number.NaN)).toThrow('AUDIO_DURATION_INVALID');
    expect(() => durationSecondsToMs(0)).toThrow('AUDIO_DURATION_INVALID');
  });
});
