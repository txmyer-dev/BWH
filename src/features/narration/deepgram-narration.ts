import {inspectPcmWav, type NarrationProvider} from './narration-provider';

export const DEEPGRAM_NARRATION_MODEL = 'aura-2-arcas-en';
export const deepgramNarrationPricing = (characters: number) => {
  if (!Number.isSafeInteger(characters) || characters <= 0) throw new Error('NARRATION_TEXT_REQUIRED');
  return {estimatedCostMicros: Math.ceil(characters * 30_000 / 1_000), pricingVersion: 'deepgram-aura-2-2026-07'};
};

export class DeepgramNarration implements NarrationProvider {
  readonly id = 'deepgram' as const;
  readonly model: string;
  constructor(private readonly apiKey: string, private readonly options: {model?: string; request?: (url: string, init: RequestInit) => Promise<Response>} = {}) {
    this.model = options.model ?? DEEPGRAM_NARRATION_MODEL;
  }
  async synthesize(input: Parameters<NarrationProvider['synthesize']>[0]) {
    if (!input.text.trim()) throw new Error('NARRATION_TEXT_REQUIRED');
    if (input.voice !== this.model) throw new Error('NARRATION_VOICE_INVALID');
    const request = this.options.request ?? fetch;
    const query = new URLSearchParams({model: this.model, mip_opt_out: 'true', encoding: 'linear16', container: 'wav'});
    let response: Response;
    try {
      response = await request(`https://api.deepgram.com/v1/speak?${query.toString()}`, {method: 'POST', headers: {Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json'}, body: JSON.stringify({text: input.text}), signal: input.signal});
    } catch { throw new Error('NARRATION_PROVIDER_UNAVAILABLE'); }
    if (!response.ok) throw new Error('NARRATION_PROVIDER_UNAVAILABLE');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const {durationMs} = inspectPcmWav(bytes);
    return {bytes, mimeType: 'audio/wav' as const, durationMs, safeRequestId: input.requestId};
  }
}
