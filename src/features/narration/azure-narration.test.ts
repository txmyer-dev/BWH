import {describe, expect, it, vi} from 'vitest';

import {AzureNarration, azureNarrationPricing} from './azure-narration';

describe('AzureNarration configuration', () => {
  it('rejects malformed audio even when a provider reports a duration', async () => {
    const provider = new AzureNarration({synthesize: async () => ({bytes: new Uint8Array([82, 73, 70, 70]), durationMs: 400}), stop: vi.fn()}, {voice: 'voice'});
    await expect(provider.synthesize({text: 'Approved.', voice: 'voice', requestId: 'request'})).rejects.toThrow('NARRATION_AUDIO_INVALID');
  });
  it('fails closed when an explicit positive price is absent', () => {
    expect(() => azureNarrationPricing(50, 0)).toThrow('AZURE_TTS_PRICING_REQUIRED');
  });

  it('returns PCM WAV bytes and cancels synthesis on abort', async () => {
    const stop = vi.fn();
    const bytes = Buffer.alloc(44 + 3200); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
    const synthesize = vi.fn(async () => ({bytes, durationMs: 100}));
    const provider = new AzureNarration({synthesize, stop}, {voice: 'en-US-Ava:DragonHDLatestNeural'});
    const controller = new AbortController();
    const promise = provider.synthesize({text: 'Approved narration.', voice: 'en-US-Ava:DragonHDLatestNeural', requestId: 'request', signal: controller.signal});
    controller.abort();
    await promise;
    expect(stop).toHaveBeenCalled();
  });
});
