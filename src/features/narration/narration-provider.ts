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
  if (view.readUInt32LE(4) !== view.length - 8) throw new Error('NARRATION_AUDIO_INVALID');
  let offset = 12; let format: {audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number}|undefined; let dataBytes: number|undefined;
  while (offset + 8 <= view.length) {
    const id = view.toString('ascii', offset, offset + 4); const size = view.readUInt32LE(offset + 4); const start = offset + 8;
    const paddedEnd = start + size + (size & 1); if (start + size > view.length || paddedEnd > view.length) throw new Error('NARRATION_AUDIO_INVALID');
    if (id === 'fmt ') { if (format || size !== 16) throw new Error('NARRATION_AUDIO_INVALID'); format = {audioFormat: view.readUInt16LE(start), channels: view.readUInt16LE(start + 2), sampleRate: view.readUInt32LE(start + 4), byteRate: view.readUInt32LE(start + 8), blockAlign: view.readUInt16LE(start + 12), bits: view.readUInt16LE(start + 14)}; }
    if (id === 'data') { if (dataBytes !== undefined) throw new Error('NARRATION_AUDIO_INVALID'); dataBytes = size; }
    offset = paddedEnd;
  }
  if (offset !== view.length || !format || dataBytes === undefined || format.audioFormat !== 1 || ![1, 2].includes(format.channels) || ![8, 16, 24, 32].includes(format.bits) || format.sampleRate < 8_000 || !dataBytes) throw new Error('NARRATION_AUDIO_INVALID');
  const blockAlign = format.channels * format.bits / 8; const byteRate = format.sampleRate * blockAlign;
  if (!Number.isInteger(blockAlign) || format.blockAlign !== blockAlign || format.byteRate !== byteRate || dataBytes % blockAlign !== 0) throw new Error('NARRATION_AUDIO_INVALID');
  const frames = dataBytes / blockAlign; const durationMs = Math.ceil(frames / format.sampleRate * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > maximumDurationMs) throw new Error('NARRATION_AUDIO_INVALID');
  return {durationMs};
};
