import {z} from 'zod';

import type {ProviderExecutor} from '../providers/types';
import {
  geminiPricing,
  providerResponseSchema,
  type GeminiClient,
  type ProviderStructuredResultStore
} from '../story/gemini-story-agent';
import type {AuditRepository} from './audit-repository';
import type {FactualityAuditor} from './auditor';
import {
  AUDIT_INSTRUCTIONS,
  AUDIT_PROMPT_VERSION,
  AUDIT_SCHEMA_VERSION,
  validateAuditFindings
} from './openai-factuality-auditor';
import {
  factualityAuditOutputSchema,
  type FactualityAuditInput
} from './schemas';

const cachedAuditSchema = z.object({
  contract: z.object({
    auditPromptVersion: z.string(),
    auditSchemaVersion: z.string(),
    model: z.string()
  }).strict(),
  findings: factualityAuditOutputSchema.shape.findings
}).strict();

export class GeminiFactualityAuditor implements FactualityAuditor {
  private readonly pricing;

  constructor(
    private readonly client: Pick<GeminiClient, 'models'>,
    private readonly config: {model: string},
    private readonly executor: ProviderExecutor,
    private readonly results: ProviderStructuredResultStore,
    private readonly audits: AuditRepository
  ) {
    this.pricing = geminiPricing(config.model);
  }

  async audit(input: FactualityAuditInput) {
    const contract = {
      auditPromptVersion: AUDIT_PROMPT_VERSION,
      auditSchemaVersion: AUDIT_SCHEMA_VERSION,
      model: this.config.model
    };
    const evidence = input.evidence
      .filter((item) => !('verificationStatus' in item) || ['confirmed', 'corrected'].includes(String(item.verificationStatus)))
      .map((item) => ({id: item.id, claim: item.claim, sourceExcerpt: item.sourceExcerpt, sourceAssetIds: [...item.sourceAssetIds]}));
    const narration = input.narration.map((scene) => ({sceneId: scene.sceneId, text: scene.text, evidenceItemIds: [...scene.evidenceItemIds]}));
    const boundaryInput = {...input, evidence, narration};
    const serialized = JSON.stringify({evidence, narration});
    if (serialized.length > 100_000) throw new Error('GEMINI_AUDIT_INPUT_TOO_LARGE');

    const executed = await this.executor.execute({
      projectId: input.projectId,
      provider: 'google_gemini',
      model: this.config.model,
      operation: 'audit_narration',
      dataCategories: [input.auditScope === 'creator_audio' ? 'creator_narration' : 'approved_narration_text', 'source_references'],
      canonicalInput: {
        storyboardId: input.storyboardId,
        storyboardRevision: input.storyboardRevision,
        evidenceHash: input.evidenceHash,
        narrationHash: input.narrationHash,
        ...(input.auditScope === 'creator_audio' ? {
          auditScope: input.auditScope,
          assetId: input.assetId,
          transcriptId: input.transcriptId,
          transcriptProviderRunId: input.transcriptProviderRunId
        } : {}),
        ...contract
      },
      estimatedCostMicros: this.pricing.reservationMicros,
      pricingVersion: this.pricing.pricingVersion,
      dispatch: async ({signal}) => {
        const response = await this.client.models.generateContent({
          model: this.config.model,
          contents: [{role: 'user', parts: [{text: `UNTRUSTED_APPROVED_RECORD_AND_NARRATION_JSON\n${serialized}`}]}],
          config: {
            systemInstruction: AUDIT_INSTRUCTIONS,
            responseMimeType: 'application/json',
            responseJsonSchema: providerResponseSchema(z.toJSONSchema(factualityAuditOutputSchema)),
            abortSignal: signal
          }
        });
        if (!response.text) throw new Error('GEMINI_AUDIT_OUTPUT_MISSING');
        const parsed = factualityAuditOutputSchema.parse(JSON.parse(response.text));
        const result = validateAuditFindings(parsed.findings, boundaryInput);
        const promptTokens = response.usageMetadata?.promptTokenCount;
        const outputTokens = response.usageMetadata?.candidatesTokenCount;
        const thinkingTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;
        const actualCostMicros = promptTokens === undefined || outputTokens === undefined
          ? this.pricing.reservationMicros
          : promptTokens + outputTokens + thinkingTokens === 0
            ? 0
            : Math.max(1, Math.ceil(
              promptTokens * this.pricing.inputMicrosPerToken +
              (outputTokens + thinkingTokens) * this.pricing.outputMicrosPerToken
            ));
        return {
          result,
          usage: {
            actualCostMicros,
            requestCount: 1,
            metadata: {promptTokens: promptTokens ?? 0, outputTokens: outputTokens ?? 0, thinkingTokens, pricingVersion: this.pricing.pricingVersion}
          }
        };
      },
      loadResult: async (runId) => {
        const cached = cachedAuditSchema.parse(await this.results.load(input.projectId, runId));
        if (
          cached.contract.auditPromptVersion !== contract.auditPromptVersion ||
          cached.contract.auditSchemaVersion !== contract.auditSchemaVersion ||
          cached.contract.model !== contract.model
        ) throw new Error('GEMINI_AUDIT_CACHE_CONTRACT_MISMATCH');
        return validateAuditFindings(cached.findings, boundaryInput);
      },
      persistResult: async (writer, claim, result) => {
        const validated = validateAuditFindings(factualityAuditOutputSchema.parse(result).findings, boundaryInput);
        await this.results.save(writer, input.projectId, claim.runId, {contract, ...validated});
        await this.audits.persistAudit(writer, input, claim.runId, validated.findings, contract);
      }
    });

    const audit = await this.audits.findByProviderRun(input.projectId, executed.runId);
    if (
      !audit ||
      audit.storyboardId !== input.storyboardId ||
      audit.storyboardRevision !== input.storyboardRevision ||
      audit.evidenceHash !== input.evidenceHash ||
      audit.narrationHash !== input.narrationHash ||
      audit.auditPromptVersion !== contract.auditPromptVersion ||
      audit.auditSchemaVersion !== contract.auditSchemaVersion ||
      audit.model !== contract.model
    ) throw new Error('AUDIT_RESULT_NOT_AVAILABLE');
    return audit;
  }
}
