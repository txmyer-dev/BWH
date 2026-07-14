export const durationSecondsToMs = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) throw new Error('AUDIO_DURATION_INVALID');
  return Math.round(seconds * 1_000);
};
