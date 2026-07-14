import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const hexadecimalToken = /^[0-9a-f]{64}$/;

export const createOwnerToken = () => randomBytes(32).toString('hex');

export const hashOwnerToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export const tokensMatch = (token: string, hash: string) => {
  if (!hexadecimalToken.test(token) || !hexadecimalToken.test(hash)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(hashOwnerToken(token), 'hex'),
    Buffer.from(hash, 'hex')
  );
};
