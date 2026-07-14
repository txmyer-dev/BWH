import {createHmac} from 'node:crypto';

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('PROVIDER_INPUT_NOT_CANONICAL');
    return {$date: value.toISOString()};
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('PROVIDER_INPUT_NOT_CANONICAL');
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error('PROVIDER_INPUT_NOT_CANONICAL');
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('PROVIDER_INPUT_NOT_CANONICAL');
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
};

export const canonicalJson = (value: unknown) => JSON.stringify(normalize(value));

export const fingerprintInput = (secret: string, projectId: string, value: unknown) =>
  createHmac('sha256', secret).update(projectId).update('\0').update(canonicalJson(value)).digest('hex');
