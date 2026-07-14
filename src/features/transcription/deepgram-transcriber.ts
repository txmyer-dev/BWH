import {transcriptSchema, type Transcript, type Transcriber} from './transcriber';

type DeepgramWord = {word?: string; punctuated_word?: string; start?: number; end?: number; speaker?: number};
type DeepgramUtterance = {transcript?: string; start?: number; end?: number; speaker?: number; confidence?: number};
export type DeepgramResponse = {
  result?: {
    metadata?: {duration?: number};
    results?: {channels?: Array<{alternatives?: Array<{
      transcript?: string; confidence?: number; languages?: string[]; words?: DeepgramWord[]
    }>}>, utterances?: DeepgramUtterance[]};
  } | null;
  error?: unknown;
};

export interface DeepgramClient {
  listen: {prerecorded: {transcribeFile(bytes: Uint8Array, options: Record<string, unknown>, requestOptions?: {abortSignal: AbortSignal; maxRetries: number}): Promise<DeepgramResponse>}};
}

const milliseconds = (seconds: number) => Math.round(seconds * 1_000);

export class DeepgramTranscriber implements Transcriber {
  constructor(private readonly client: DeepgramClient, private readonly config: {model: string}) {}

  async transcribe(input: {bytes: Uint8Array; mimeType: string; signal?: AbortSignal}): Promise<Transcript> {
    void input.mimeType;
    try {
      const request = this.client.listen.prerecorded.transcribeFile(input.bytes, {
        model: this.config.model, smart_format: true, diarize: true, mip_opt_out: true,
        utterances: true, punctuate: true, language: 'en', multichannel: false
      }, ...(input.signal ? [{abortSignal: input.signal, maxRetries: 0}] : []));
      const response = await request;
      if (response.error) throw new Error('provider');
      const alternative = response.result?.results?.channels?.[0]?.alternatives?.[0];
      const duration = response.result?.metadata?.duration;
      if (!alternative || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('invalid');
      }
      const timed = response.result?.results?.utterances?.length ? response.result.results.utterances.map((utterance) => ({
        startMs: milliseconds(utterance.start as number), endMs: milliseconds(utterance.end as number),
        text: utterance.transcript, speaker: typeof utterance.speaker === 'number' ? utterance.speaker : null
      })) : (alternative.words ?? []).map((word) => ({
        startMs: milliseconds(word.start as number), endMs: milliseconds(word.end as number),
        text: word.punctuated_word ?? word.word, speaker: typeof word.speaker === 'number' ? word.speaker : null
      }));
      const value = {
        text: alternative.transcript,
        language: alternative.languages?.[0] ?? 'en',
        confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null,
        durationMs: milliseconds(duration),
        segments: timed
      };
      const parsed = transcriptSchema.safeParse(value);
      if (!parsed.success) throw new Error('invalid');
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && error.message === 'TRANSCRIPT_INVALID') throw error;
      if (error instanceof Error && error.message === 'invalid') throw new Error('TRANSCRIPT_INVALID');
      throw new Error('DEEPGRAM_TRANSCRIPTION_FAILED');
    }
  }
}
