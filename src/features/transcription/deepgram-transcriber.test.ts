import {describe, expect, it} from 'vitest';

import {DeepgramTranscriber} from './deepgram-transcriber';
const config = {model: 'nova-3'};

const response = (words: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  result: {
    metadata: {duration: 2, ...extra},
    results: {channels: [{alternatives: [{transcript: 'A family memory.', confidence: 0.9, languages: ['en'], words}]}]}
  },
  error: null
});

describe('DeepgramTranscriber', () => {
  it('sends private bytes with mandatory Nova-3 privacy and formatting options', async () => {
    let received: unknown;
    const bytes = Buffer.from('private family audio');
    const client = {listen: {prerecorded: {transcribeFile: async (...args: unknown[]) => {
      received = args;
      return response([{word: 'Hello', start: 0.1254, end: 0.7656, speaker: 0}]);
    }}}};

    await new DeepgramTranscriber(client, config).transcribe({bytes, mimeType: 'audio/wav'});

    expect(received).toEqual([bytes, {
      model: 'nova-3', smart_format: true, diarize: true, mip_opt_out: true,
      utterances: true, punctuate: true, language: 'en', multichannel: false
    }]);
    expect(JSON.stringify(received)).not.toContain('http');
  });

  it('passes lease cancellation through and disables request-level retries', async () => {
    let received: unknown[] = []; const controller = new AbortController();
    const client = {listen: {prerecorded: {transcribeFile: async (...args: unknown[]) => {received = args; return response([{word: 'Hi', start: 0, end: 1, speaker: 0}]);}}}};
    await new DeepgramTranscriber(client, config).transcribe({bytes: new Uint8Array([1]), mimeType: 'audio/wav', signal: controller.signal});
    expect(received[2]).toEqual({abortSignal: controller.signal, maxRetries: 0});
  });

  it('normalizes seconds to integer milliseconds and ordered utterance segments', async () => {
    const client = {listen: {prerecorded: {transcribeFile: async () => response([
      {punctuated_word: 'Hello', start: 0.1254, end: 0.7656, speaker: 0},
      {punctuated_word: 'there.', start: 0.8, end: 1.25, speaker: 0}
    ])}}};
    const transcript = await new DeepgramTranscriber(client, config).transcribe({bytes: new Uint8Array([1]), mimeType: 'audio/wav'});
    expect(transcript).toEqual({
      text: 'A family memory.', language: 'en', confidence: 0.9,
      durationMs: 2000,
      segments: [
        {startMs: 125, endMs: 766, text: 'Hello', speaker: 0},
        {startMs: 800, endMs: 1250, text: 'there.', speaker: 0}
      ]
    });
  });

  it('prefers timestamped utterances over individual words for meaningful clip evidence', async () => {
    const client = {listen: {prerecorded: {transcribeFile: async () => ({result: {
      metadata: {duration: 2}, results: {
        channels: [{alternatives: [{transcript: 'We took the train.', confidence: 0.9, words: [{word: 'We', start: 0, end: 0.2, speaker: 1}]}]}],
        utterances: [{transcript: 'We took the train.', start: 0, end: 1.8, speaker: 1, confidence: 0.88}]
      }
    }, error: null})}}};
    const transcript = await new DeepgramTranscriber(client, config).transcribe({bytes: new Uint8Array([1]), mimeType: 'audio/wav'});
    expect(transcript.segments).toEqual([{startMs: 0, endMs: 1800, text: 'We took the train.', speaker: 1}]);
  });

  it.each([
    {words: [{word: 'bad', start: 1, end: 0.5, speaker: 0}]},
    {words: [{word: 'one', start: 0, end: 1, speaker: 0}, {word: 'two', start: 0.9, end: 1.5, speaker: 1}]},
    {words: [{word: 'late', start: 1.5, end: 2.5, speaker: 0}]}
  ])('rejects invalid or out-of-bounds timestamps', async ({words}) => {
    const client = {listen: {prerecorded: {transcribeFile: async () => response(words)}}};
    await expect(new DeepgramTranscriber(client, config).transcribe({bytes: new Uint8Array([1]), mimeType: 'audio/wav'}))
      .rejects.toThrow('TRANSCRIPT_INVALID');
  });

  it('converts provider failures to a safe code', async () => {
    const client = {listen: {prerecorded: {transcribeFile: async () => ({
      result: null, error: new Error('secret transcript and signed URL https://storage.test/private')
    })}}};
    await expect(new DeepgramTranscriber(client, config).transcribe({bytes: new Uint8Array([1]), mimeType: 'audio/wav'}))
      .rejects.toThrow(/^DEEPGRAM_TRANSCRIPTION_FAILED$/);
  });
});
