export type RenderStatus = {
  status: 'idle'|'pending'|'processing'|'completed'|'failed'|'superseded';
  jobId?: string;
  error?: string;
};

const abortError = () => new DOMException('Aborted', 'AbortError');

export const abortableWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });

const isTerminal = (status: RenderStatus) =>
  status.status === 'completed' ||
  status.status === 'failed' ||
  status.status === 'superseded' ||
  status.status === 'idle';

export const pollRenderStatus = async ({
  load,
  signal,
  wait
}: {
  load: () => Promise<RenderStatus>;
  signal: AbortSignal;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}) => {
  for (const delay of [1_000, 1_500, 2_000, 3_000, 5_000]) {
    if (signal.aborted) throw abortError();
    const status = await load();
    if (signal.aborted) throw abortError();
    if (isTerminal(status)) return status;
    await wait(delay, signal);
  }
  while (!signal.aborted) {
    const status = await load();
    if (signal.aborted) throw abortError();
    if (isTerminal(status)) return status;
    await wait(5_000, signal);
  }
  throw abortError();
};
