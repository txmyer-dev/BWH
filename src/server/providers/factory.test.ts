import {describe, expect, it, vi} from 'vitest';

import {createProviderServices} from './factory';
import {InMemoryProviderStructuredResultStore} from '../../features/story/gemini-story-agent';

const env = {NODE_ENV: 'production' as const, GEMINI_API_KEY: 'secret', GEMINI_STORY_MODEL: 'gemini-3.1-flash-lite', GEMINI_REQUIRE_PAID_PROJECT: true, GEMINI_PAID_PROJECT_VERIFIED: true, GEMINI_PAID_PROJECT_ID: 'project-a', GCP_PROJECT_ID: 'project-a'};
const deps = {executor: {execute: vi.fn()}, resultStore: new InMemoryProviderStructuredResultStore(), createGeminiClient: vi.fn(() => ({models: {}, files: {}}))};

describe('createProviderServices', () => {
  it.each([
    [{...env, GEMINI_REQUIRE_PAID_PROJECT: false}],
    [{...env, GEMINI_PAID_PROJECT_VERIFIED: false}],
    [{...env, GEMINI_PAID_PROJECT_ID: 'other'}]
  ])('fails closed when paid-project deployment attestation is incomplete', (candidate) => {
    expect(() => createProviderServices(candidate, deps as never)).toThrow('GEMINI_PAID_PROJECT_NOT_VERIFIED');
  });

  it('constructs the live client only after attestation passes', () => {
    const services = createProviderServices(env, deps as never);
    expect(services.storyAgent).toBeTruthy();
    expect(deps.createGeminiClient).toHaveBeenCalledWith('secret');
  });

  it('allows an injected fake only outside production without an API key', () => {
    const fake = vi.fn(() => ({models: {}, files: {}}));
    expect(createProviderServices({...env, NODE_ENV: 'test', GEMINI_API_KEY: undefined}, {...deps, createGeminiClient: fake} as never).storyAgent).toBeTruthy();
    expect(fake).toHaveBeenCalledWith(undefined);
  });

  it('rejects default live construction outside production without paid-project attestation', () => {
    expect(() => createProviderServices({...env, NODE_ENV: 'development', GEMINI_REQUIRE_PAID_PROJECT: false}, {executor: deps.executor, resultStore: deps.resultStore} as never)).toThrow('GEMINI_PAID_PROJECT_NOT_VERIFIED');
  });

  it('fails closed for an unpriced configured Gemini model', () => {
    expect(() => createProviderServices({...env, GEMINI_STORY_MODEL: 'gemini-future'}, deps as never)).toThrow('GEMINI_MODEL_PRICING_UNKNOWN');
  });
});
