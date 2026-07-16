import {describe, expect, it} from 'vitest';

import {factualityAuditDeployment} from './audit-deployment';
import {AUDIT_PROMPT_VERSION, AUDIT_SCHEMA_VERSION} from './openai-factuality-auditor';

describe('factualityAuditDeployment', () => {
  it('resolves one provider, model, and downstream contract for the whole deployment', () => {
    expect(factualityAuditDeployment({
      FACTUALITY_AUDIT_PROVIDER: 'gemini',
      GEMINI_STORY_MODEL: 'gemini-3.1-flash-lite',
      OPENAI_AUDIT_MODEL: 'gpt-5.6'
    })).toEqual({
      provider: 'google_gemini',
      model: 'gemini-3.1-flash-lite',
      contract: {
        auditPromptVersion: AUDIT_PROMPT_VERSION,
        auditSchemaVersion: AUDIT_SCHEMA_VERSION,
        model: 'gemini-3.1-flash-lite'
      }
    });
  });
});
