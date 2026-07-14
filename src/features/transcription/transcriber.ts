import {z} from 'zod';

export const transcriptSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1),
  speaker: z.number().int().nonnegative().nullable()
}).strict();

export const transcriptSchema = z.object({
  text: z.string().trim().min(1),
  language: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  durationMs: z.number().int().positive(),
  segments: z.array(transcriptSegmentSchema).min(1)
}).strict().superRefine((value, context) => {
  let previousEnd = 0;
  for (const [index, segment] of value.segments.entries()) {
    if (segment.startMs >= segment.endMs || segment.startMs < previousEnd || segment.endMs > value.durationMs) {
      context.addIssue({code: 'custom', path: ['segments', index], message: 'TRANSCRIPT_INVALID'});
    }
    previousEnd = segment.endMs;
  }
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;

export interface Transcriber {
  transcribe(input: {bytes: Uint8Array; mimeType: string; signal?: AbortSignal}): Promise<Transcript>;
}
