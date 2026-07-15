import {inspectPcmWav, type NarrationProvider} from './narration-provider';

export const azureNarrationPricing = (characters: number, microsPerMillionCharacters: number) => {
  if (!Number.isSafeInteger(microsPerMillionCharacters) || microsPerMillionCharacters <= 0) throw new Error('AZURE_TTS_PRICING_REQUIRED');
  if (!Number.isSafeInteger(characters) || characters <= 0) throw new Error('NARRATION_TEXT_REQUIRED');
  return {estimatedCostMicros: Math.max(1, Math.ceil(characters * microsPerMillionCharacters / 1_000_000)), pricingVersion: `azure-explicit-${microsPerMillionCharacters}`};
};

export type AzureSpeechClient = {synthesize(input: {text: string; voice: string; signal?: AbortSignal}): Promise<{bytes: Uint8Array; durationMs?: number}>; stop(): void};

export class AzureNarration implements NarrationProvider {
  readonly id = 'azure' as const; readonly model: string;
  constructor(private readonly client: AzureSpeechClient, options: {voice: string}) { this.model = options.voice; }
  async synthesize(input: Parameters<NarrationProvider['synthesize']>[0]) {
    if (!input.text.trim()) throw new Error('NARRATION_TEXT_REQUIRED');
    if (input.voice !== this.model) throw new Error('NARRATION_VOICE_INVALID');
    const abort = () => this.client.stop(); input.signal?.addEventListener('abort', abort, {once: true});
    try {
      const result = await this.client.synthesize({text: input.text, voice: input.voice, signal: input.signal});
      const durationMs = inspectPcmWav(result.bytes).durationMs;
      return {bytes: result.bytes, mimeType: 'audio/wav' as const, durationMs, safeRequestId: input.requestId};
    } catch (error) { if (error instanceof Error && error.message === 'NARRATION_AUDIO_INVALID') throw error; throw new Error('NARRATION_PROVIDER_UNAVAILABLE'); }
    finally { input.signal?.removeEventListener('abort', abort); }
  }
}
