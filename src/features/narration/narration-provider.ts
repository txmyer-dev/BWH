export type NarrationSynthesisInput = {
  text: string;
  voice: string;
  requestId: string;
  signal?: AbortSignal;
};

export type NarrationSynthesis = {
  bytes: Uint8Array;
  mimeType: 'audio/wav';
  durationMs: number;
  safeRequestId?: string;
};

export interface NarrationProvider {
  readonly id: 'deepgram'|'azure';
  readonly model: string;
  synthesize(input: NarrationSynthesisInput): Promise<NarrationSynthesis>;
}

export const inspectPcmWav = (bytes: Uint8Array, maximumBytes = 25 * 1024 * 1024, maximumDurationMs = 10 * 60_000) => {
  if (bytes.byteLength < 44 || bytes.byteLength > maximumBytes) throw new Error('NARRATION_AUDIO_INVALID');
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('ascii', 0, 4) !== 'RIFF' || view.toString('ascii', 8, 12) !== 'WAVE') throw new Error('NARRATION_AUDIO_INVALID');
  let offset = 12; let format: {audioFormat: number; channels: number; sampleRate: number; bits: number}|undefined; let dataBytes = 0;
  while (offset + 8 <= view.length) {
    const id = view.toString('ascii', offset, offset + 4); const size = view.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + size > view.length) throw new Error('NARRATION_AUDIO_INVALID');
    if (id === 'fmt ' && size >= 16) format = {audioFormat: view.readUInt16LE(start), channels: view.readUInt16LE(start + 2), sampleRate: view.readUInt32LE(start + 4), bits: view.readUInt16LE(start + 14)};
    if (id === 'data') dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || ![1, 2].includes(format.channels) || ![8, 16, 24, 32].includes(format.bits) || format.sampleRate < 8_000 || !dataBytes) throw new Error('NARRATION_AUDIO_INVALID');
  const bytesPerSecond = format.sampleRate * format.channels * format.bits / 8;
  const durationMs = Math.ceil(dataBytes / bytesPerSecond * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > maximumDurationMs) throw new Error('NARRATION_AUDIO_INVALID');
  return {durationMs};
};
