import {describe, expect, it, vi} from 'vitest';

import {DeepgramNarration, deepgramNarrationPricing} from './deepgram-narration';

const wav = () => {
  const bytes = Buffer.alloc(44 + 32_000);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(32_000, 40); return bytes;
};

describe('DeepgramNarration', () => {
  it('sends only approved narration to the Arcas opt-out WAV endpoint with abort', async () => {
    let captured: [string, RequestInit]|undefined;
    const request = vi.fn(async (...args: [string, RequestInit]) => { captured = args; return new Response(wav(), {status: 200}); });
    const signal = new AbortController().signal;
    const provider = new DeepgramNarration('secret', {request});
    const result = await provider.synthesize({text: 'The approved words.', voice: 'aura-2-arcas-en', requestId: 'safe-id', signal});
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = captured!;
    expect(url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-arcas-en&mip_opt_out=true&encoding=linear16&container=wav');
    expect(init.signal).toBe(signal);
    expect(init.body).toBe(JSON.stringify({text: 'The approved words.'}));
    expect(String(init.body)).not.toContain('evidence');
    expect(result).toMatchObject({mimeType: 'audio/wav', durationMs: 1000, safeRequestId: 'safe-id'});
  });

  it('prices Aura 2 at the current explicit nonzero rate', () => {
    expect(deepgramNarrationPricing(1)).toEqual({estimatedCostMicros: 30, pricingVersion: 'deepgram-aura-2-2026-07'});
    expect(deepgramNarrationPricing(1001).estimatedCostMicros).toBe(30030);
  });
});
