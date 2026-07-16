import type {ProcessingProvider} from '../consent/schemas';
import type {AuditContract} from './audit-repository';
import {AUDIT_PROMPT_VERSION, AUDIT_SCHEMA_VERSION} from './openai-factuality-auditor';

type AuditDeploymentEnvironment = {
  FACTUALITY_AUDIT_PROVIDER: 'openai'|'gemini';
  GEMINI_STORY_MODEL: string;
  OPENAI_AUDIT_MODEL: string;
};

export const factualityAuditDeployment = (env: AuditDeploymentEnvironment): {
  provider: ProcessingProvider;
  model: string;
  contract: AuditContract;
} => {
  const provider = env.FACTUALITY_AUDIT_PROVIDER === 'gemini' ? 'google_gemini' : 'openai';
  const model = env.FACTUALITY_AUDIT_PROVIDER === 'gemini' ? env.GEMINI_STORY_MODEL : env.OPENAI_AUDIT_MODEL;
  return {
    provider,
    model,
    contract: {
      auditPromptVersion: AUDIT_PROMPT_VERSION,
      auditSchemaVersion: AUDIT_SCHEMA_VERSION,
      model
    }
  };
};
