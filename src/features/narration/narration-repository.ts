import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../../server/db/client";
import {
  assetTranscripts,
  assets,
  evidenceItems,
  factualityAudits,
  filmScenes,
  narrationSamples,
  narrationTracks,
  projectConsents,
  providerRuns,
  storyboards,
} from "../../server/db/schema";
import {
  projectApprovedEvidenceLedger,
  projectNarrationLedger,
  sha256Canonical,
  type AuditContract,
} from "../audit/audit-repository";
import {
  AUDIT_PROMPT_VERSION,
  AUDIT_SCHEMA_VERSION,
} from "../audit/openai-factuality-auditor";
import type { EvidenceItem } from "../evidence/schemas";
import type {
  ProviderDatabaseTransaction,
  ProviderResultWriter,
} from "../providers/types";

export type ApprovedNarrationSnapshot = {
  projectId: string;
  storyboardId: string;
  revision: number;
  auditId: string;
  narrationHash: string;
  scenes: { id: string; text: string }[];
};

export const narrationAuditContract = (model: string): AuditContract => ({
  auditPromptVersion: AUDIT_PROMPT_VERSION,
  auditSchemaVersion: AUDIT_SCHEMA_VERSION,
  model,
});
export type NarrationSample = {
  id: string;
  projectId: string;
  storyboardId: string;
  providerRunId: string;
  provider: "deepgram" | "azure";
  model: string;
  voice: string;
  sourceTextHash: string;
  auditId: string;
  narrationHash: string;
  objectKey: string;
  durationMs: number;
  approvedAt: Date | null;
};
export type NarrationTrack = {
  id: string;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  providerRunId: string;
  provider: "deepgram" | "azure";
  model: string;
  voice: string;
  sourceTextHash: string;
  auditId: string;
  narrationHash: string;
  objectKey: string;
  durationMs: number;
};
export type NarrationSelection =
  | {
      kind: "generated";
      provider: "deepgram" | "azure";
      sampleId: string;
      model: string;
      voice: string;
      auditId: string;
      narrationHash: string;
    }
  | {
      kind: "creator";
      assetId: string;
      transcriptId: string;
      transcriptHash: string;
      auditId: string;
    };
const narrationSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("generated"),
      provider: z.enum(["deepgram", "azure"]),
      sampleId: z.string().uuid(),
      model: z.string().min(1),
      voice: z.string().min(1),
      auditId: z.string().uuid(),
      narrationHash: z.string().length(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("creator"),
      assetId: z.string().uuid(),
      transcriptId: z.string().uuid(),
      transcriptHash: z.string().length(64),
      auditId: z.string().uuid(),
    })
    .strict(),
]);

export interface NarrationRepository {
  loadApprovedStoryboard(projectId: string): Promise<ApprovedNarrationSnapshot>;
  saveSample(
    writer: ProviderResultWriter,
    sample: Omit<NarrationSample, "id" | "approvedAt">,
  ): Promise<NarrationSample>;
  findSampleByProviderRun(
    projectId: string,
    providerRunId: string,
  ): Promise<NarrationSample | undefined>;
  findSample(
    projectId: string,
    sampleId: string,
  ): Promise<NarrationSample | undefined>;
  approveSample(projectId: string, sampleId: string): Promise<NarrationSample>;
  setSelection(
    projectId: string,
    selection: NarrationSelection,
  ): Promise<NarrationSelection>;
  getSelection(projectId: string): Promise<NarrationSelection | undefined>;
  findTrackByProviderRun(
    projectId: string,
    providerRunId: string,
  ): Promise<NarrationTrack | undefined>;
  findTrack(
    projectId: string,
    sceneId: string,
    sourceTextHash: string,
    provider: string,
    model: string,
    voice: string,
  ): Promise<NarrationTrack | undefined>;
  saveTrack(
    writer: ProviderResultWriter,
    track: Omit<NarrationTrack, "id">,
  ): Promise<NarrationTrack>;
  assertCreatorAudioApproved(
    projectId: string,
    assetId: string,
  ): Promise<{
    assetId: string;
    transcriptId: string;
    transcriptHash: string;
    auditId: string;
  }>;
}

export class PostgresNarrationRepository implements NarrationRepository {
  constructor(
    private readonly database: Database,
    private readonly expectedContract: AuditContract = {
      auditPromptVersion: AUDIT_PROMPT_VERSION,
      auditSchemaVersion: AUDIT_SCHEMA_VERSION,
      model: "gpt-5.6",
    },
  ) {}
  private async loadApprovedStoryboardLocked(
    transaction: ProviderDatabaseTransaction,
    projectId: string,
  ) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('narration'))`,
    );
    const [board] = await transaction
      .select()
      .from(storyboards)
      .where(eq(storyboards.projectId, projectId))
      .for("update");
    if (
      !board ||
      !board.currentAuditId ||
      !board.narrationApprovedAt ||
      !board.narrationApprovalAuditId ||
      !board.narrationApprovalHash ||
      board.currentAuditId !== board.narrationApprovalAuditId
    )
      throw new Error("NARRATION_TEXT_APPROVAL_REQUIRED");
    const [audit] = await transaction
      .select()
      .from(factualityAudits)
      .where(
        and(
          eq(factualityAudits.id, board.currentAuditId),
          eq(factualityAudits.projectId, projectId),
        ),
      )
      .for("share");
    const scenes = await transaction
      .select()
      .from(filmScenes)
      .where(eq(filmScenes.storyboardId, board.id))
      .orderBy(asc(filmScenes.sequenceOrder))
      .for("share");
    const evidenceRows = await transaction
      .select()
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.projectId, projectId),
          inArray(evidenceItems.verificationStatus, ["confirmed", "corrected"]),
        ),
      )
      .orderBy(asc(evidenceItems.id))
      .for("share");
    const narrationHash = sha256Canonical(projectNarrationLedger(scenes));
    const evidenceHash = sha256Canonical(
      projectApprovedEvidenceLedger(
        evidenceRows.map((row) => ({
          id: row.id,
          projectId: row.projectId,
          kind: row.type as EvidenceItem["kind"],
          claim: row.claim,
          originalClaim: row.originalClaim,
          sourceAssetIds: row.sourceAssetIds as string[],
          sourceExcerpt: row.sourceExcerpt,
          confidence: row.confidence,
          verificationStatus:
            row.verificationStatus as EvidenceItem["verificationStatus"],
          correction: row.correction,
        })),
      ),
    );
    if (
      !audit ||
      audit.auditScope !== "narration_text" ||
      audit.status !== "passed" ||
      audit.narrationHash !== narrationHash ||
      audit.evidenceHash !== evidenceHash ||
      board.narrationApprovalHash !== narrationHash ||
      board.narrationApprovalEvidenceHash !== evidenceHash ||
      audit.storyboardRevision !== board.revision ||
      audit.auditPromptVersion !== this.expectedContract.auditPromptVersion ||
      audit.auditSchemaVersion !== this.expectedContract.auditSchemaVersion ||
      audit.model !== this.expectedContract.model ||
      (audit.findings as { blocking?: boolean }[]).some((item) => item.blocking)
    )
      throw new Error("NARRATION_TEXT_APPROVAL_STALE");
    return {
      projectId,
      storyboardId: board.id,
      revision: board.revision,
      auditId: audit.id,
      narrationHash,
      scenes: scenes
        .filter((scene) => Boolean(scene.narrationText?.trim()))
        .map((scene) => ({ id: scene.id, text: scene.narrationText! })),
    };
  }
  async loadApprovedStoryboard(projectId: string) {
    return this.database.transaction((transaction) =>
      this.loadApprovedStoryboardLocked(transaction, projectId),
    );
  }
  async saveSample(
    writer: ProviderResultWriter,
    sample: Omit<NarrationSample, "id" | "approvedAt">,
  ) {
    let saved: NarrationSample | undefined;
    await writer.writeStructured(async (tx) => {
      const current = await this.loadApprovedStoryboardLocked(
        tx,
        sample.projectId,
      );
      if (
        current.storyboardId !== sample.storyboardId ||
        current.auditId !== sample.auditId ||
        current.narrationHash !== sample.narrationHash
      )
        throw new Error("NARRATION_APPROVAL_CHANGED_DURING_DISPATCH");
      const [row] = await tx
        .insert(narrationSamples)
        .values({ id: randomUUID(), ...sample })
        .returning();
      saved = { ...row, provider: row.provider as "deepgram" | "azure" };
    });
    if (!saved) throw new Error("NARRATION_SAMPLE_PERSIST_FAILED");
    return saved;
  }
  async findSampleByProviderRun(projectId: string, providerRunId: string) {
    const [row] = await this.database
      .select()
      .from(narrationSamples)
      .where(
        and(
          eq(narrationSamples.projectId, projectId),
          eq(narrationSamples.providerRunId, providerRunId),
        ),
      )
      .limit(1);
    return row
      ? { ...row, provider: row.provider as "deepgram" | "azure" }
      : undefined;
  }
  async findSample(projectId: string, sampleId: string) {
    const [row] = await this.database
      .select()
      .from(narrationSamples)
      .where(
        and(
          eq(narrationSamples.projectId, projectId),
          eq(narrationSamples.id, sampleId),
        ),
      )
      .limit(1);
    return row
      ? { ...row, provider: row.provider as "deepgram" | "azure" }
      : undefined;
  }
  private async assertRunConsent(
    transaction: ProviderDatabaseTransaction,
    projectId: string,
    providerRunId: string,
    provider: "deepgram" | "azure",
  ) {
    const [run] = await transaction
      .select()
      .from(providerRuns)
      .where(
        and(
          eq(providerRuns.id, providerRunId),
          eq(providerRuns.projectId, projectId),
        ),
      )
      .for("share");
    const [consent] = await transaction
      .select()
      .from(projectConsents)
      .where(
        and(
          eq(projectConsents.projectId, projectId),
          eq(projectConsents.purpose, "processing"),
          sql`${projectConsents.invalidatedAt} is null`,
        ),
      )
      .for("share");
    if (
      !run ||
      !run.activeResult ||
      run.status !== "completed" ||
      run.provider !==
        (provider === "azure" ? "microsoft_azure" : "deepgram") ||
      !consent ||
      run.consentId !== consent.id
    )
      throw new Error("NARRATION_SAMPLE_STALE");
  }
  async approveSample(projectId: string, sampleId: string) {
    return this.database.transaction(async (tx) => {
      const snapshot = await this.loadApprovedStoryboardLocked(tx, projectId);
      const [sample] = await tx
        .select()
        .from(narrationSamples)
        .where(
          and(
            eq(narrationSamples.id, sampleId),
            eq(narrationSamples.projectId, projectId),
          ),
        )
        .for("update");
      if (
        !sample ||
        sample.auditId !== snapshot.auditId ||
        sample.narrationHash !== snapshot.narrationHash
      )
        throw new Error("NARRATION_SAMPLE_STALE");
      await this.assertRunConsent(
        tx,
        projectId,
        sample.providerRunId,
        sample.provider as "deepgram" | "azure",
      );
      const [row] = await tx
        .update(narrationSamples)
        .set({ approvedAt: new Date() })
        .where(eq(narrationSamples.id, sample.id))
        .returning();
      return { ...row, provider: row.provider as "deepgram" | "azure" };
    });
  }
  async setSelection(projectId: string, selection: NarrationSelection) {
    const valid = narrationSelectionSchema.parse(selection);
    return this.database.transaction(async (tx) => {
      const snapshot = await this.loadApprovedStoryboardLocked(tx, projectId);
      if (valid.kind === "generated") {
        const [sample] = await tx
          .select()
          .from(narrationSamples)
          .where(
            and(
              eq(narrationSamples.id, valid.sampleId),
              eq(narrationSamples.projectId, projectId),
            ),
          )
          .for("update");
        if (
          !sample?.approvedAt ||
          sample.auditId !== snapshot.auditId ||
          sample.narrationHash !== snapshot.narrationHash ||
          sample.provider !== valid.provider ||
          sample.model !== valid.model ||
          sample.voice !== valid.voice
        )
          throw new Error("NARRATION_SAMPLE_APPROVAL_REQUIRED");
        await this.assertRunConsent(
          tx,
          projectId,
          sample.providerRunId,
          valid.provider,
        );
      } else {
        const creator = await this.assertCreatorAudioApprovedLocked(
          tx,
          projectId,
          valid.assetId,
        );
        if (
          creator.transcriptId !== valid.transcriptId ||
          creator.transcriptHash !== valid.transcriptHash ||
          creator.auditId !== valid.auditId
        )
          throw new Error("CREATOR_AUDIO_AUDIT_REQUIRED");
      }
      const [row] = await tx
        .update(storyboards)
        .set({
          narrationSource:
            valid.kind === "creator" ? "creator" : valid.provider,
          narratorVoice: valid.kind === "generated" ? valid.voice : null,
          creatorNarrationAssetId:
            valid.kind === "creator" ? valid.assetId : null,
          narrationTrackSelection: valid,
          audioApprovedAt: new Date(),
          renderManifest: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(storyboards.projectId, projectId),
            eq(storyboards.id, snapshot.storyboardId),
            eq(storyboards.revision, snapshot.revision),
          ),
        )
        .returning({ id: storyboards.id });
      if (!row) throw new Error("NARRATION_TEXT_APPROVAL_STALE");
      return valid;
    });
  }
  async getSelection(projectId: string) {
    const board = await this.database.query.storyboards.findFirst({
      where: (table, { eq: same }) => same(table.projectId, projectId),
    });
    return board?.narrationTrackSelection
      ? narrationSelectionSchema.parse(board.narrationTrackSelection)
      : undefined;
  }
  async findTrackByProviderRun(projectId: string, providerRunId: string) {
    const [row] = await this.database
      .select()
      .from(narrationTracks)
      .where(
        and(
          eq(narrationTracks.projectId, projectId),
          eq(narrationTracks.providerRunId, providerRunId),
        ),
      )
      .limit(1);
    return row
      ? { ...row, provider: row.provider as "deepgram" | "azure" }
      : undefined;
  }
  async findTrack(
    projectId: string,
    sceneId: string,
    sourceTextHash: string,
    provider: string,
    model: string,
    voice: string,
  ) {
    const [row] = await this.database
      .select()
      .from(narrationTracks)
      .where(
        and(
          eq(narrationTracks.projectId, projectId),
          eq(narrationTracks.sceneId, sceneId),
          eq(narrationTracks.sourceTextHash, sourceTextHash),
          eq(narrationTracks.provider, provider),
          eq(narrationTracks.model, model),
          eq(narrationTracks.voice, voice),
        ),
      )
      .limit(1);
    return row
      ? { ...row, provider: row.provider as "deepgram" | "azure" }
      : undefined;
  }
  async saveTrack(
    writer: ProviderResultWriter,
    track: Omit<NarrationTrack, "id">,
  ) {
    let saved: NarrationTrack | undefined;
    await writer.writeStructured(async (tx) => {
      const current = await this.loadApprovedStoryboardLocked(
        tx,
        track.projectId,
      );
      const [board] = await tx
        .select()
        .from(storyboards)
        .where(eq(storyboards.id, current.storyboardId))
        .for("update");
      const selection = board?.narrationTrackSelection
        ? narrationSelectionSchema.parse(board.narrationTrackSelection)
        : undefined;
      if (
        current.storyboardId !== track.storyboardId ||
        current.auditId !== track.auditId ||
        current.narrationHash !== track.narrationHash ||
        !selection ||
        selection.kind !== "generated" ||
        selection.provider !== track.provider ||
        selection.model !== track.model ||
        selection.voice !== track.voice ||
        selection.auditId !== current.auditId
      )
        throw new Error("NARRATION_APPROVAL_CHANGED_DURING_DISPATCH");
      const scene = current.scenes.find((item) => item.id === track.sceneId);
      if (!scene) throw new Error("NARRATION_APPROVAL_CHANGED_DURING_DISPATCH");
      const [row] = await tx
        .insert(narrationTracks)
        .values({ id: randomUUID(), ...track })
        .returning();
      saved = { ...row, provider: row.provider as "deepgram" | "azure" };
    });
    if (!saved) throw new Error("NARRATION_TRACK_PERSIST_FAILED");
    return saved;
  }
  private async assertCreatorAudioApprovedLocked(
    tx: ProviderDatabaseTransaction,
    projectId: string,
    assetId: string,
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('narration'))`,
    );
    const [row] = await tx
      .select({
        assetId: assets.id,
        kind: assets.assetKind,
        status: assets.processingStatus,
        transcriptId: assetTranscripts.id,
        transcriptText: assetTranscripts.text,
        providerRunId: assetTranscripts.providerRunId,
        transcriptAuditId: assets.creatorTranscriptAuditId,
        approvedHash: assets.creatorTranscriptApprovalHash,
        provider: providerRuns.provider,
        model: providerRuns.model,
        operation: providerRuns.operation,
        runActive: providerRuns.activeResult,
        runStatus: providerRuns.status,
      })
      .from(assets)
      .innerJoin(assetTranscripts, eq(assetTranscripts.assetId, assets.id))
      .innerJoin(
        providerRuns,
        eq(providerRuns.id, assetTranscripts.providerRunId),
      )
      .where(and(eq(assets.projectId, projectId), eq(assets.id, assetId)))
      .for("update");
    const [board] = await tx
      .select()
      .from(storyboards)
      .where(eq(storyboards.projectId, projectId))
      .for("share");
    const evidenceRows = await tx
      .select()
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.projectId, projectId),
          inArray(evidenceItems.verificationStatus, ["confirmed", "corrected"]),
        ),
      )
      .orderBy(asc(evidenceItems.id))
      .for("share");
    const ledger = projectApprovedEvidenceLedger(
      evidenceRows.map((item) => ({
        id: item.id,
        projectId: item.projectId,
        kind: item.type as EvidenceItem["kind"],
        claim: item.claim,
        originalClaim: item.originalClaim,
        sourceAssetIds: item.sourceAssetIds as string[],
        sourceExcerpt: item.sourceExcerpt,
        confidence: item.confidence,
        verificationStatus:
          item.verificationStatus as EvidenceItem["verificationStatus"],
        correction: item.correction,
      })),
    ).filter((item) => !item.sourceAssetIds.includes(assetId));
    const evidenceHash = sha256Canonical(ledger);
    const transcriptHash = row
      ? sha256Canonical({ text: row.transcriptText })
      : "";
    const [audit] = row?.transcriptAuditId
      ? await tx
          .select()
          .from(factualityAudits)
          .where(
            and(
              eq(factualityAudits.id, row.transcriptAuditId),
              eq(factualityAudits.projectId, projectId),
            ),
          )
          .for("share")
      : [];
    if (
      !row ||
      !board ||
      row.kind !== "creator_narration" ||
      row.status !== "ready" ||
      row.provider !== "deepgram" ||
      row.model !== "nova-3" ||
      row.operation !== "transcribe" ||
      !row.runActive ||
      row.runStatus !== "completed" ||
      row.approvedHash !== transcriptHash ||
      !audit ||
      audit.auditScope !== "creator_audio" ||
      audit.creatorNarrationAssetId !== assetId ||
      audit.creatorTranscriptId !== row.transcriptId ||
      audit.creatorTranscriptProviderRunId !== row.providerRunId ||
      audit.storyboardId !== board.id ||
      audit.storyboardRevision !== board.revision ||
      audit.narrationHash !== transcriptHash ||
      audit.evidenceHash !== evidenceHash ||
      audit.auditPromptVersion !== this.expectedContract.auditPromptVersion ||
      audit.auditSchemaVersion !== this.expectedContract.auditSchemaVersion ||
      audit.model !== this.expectedContract.model ||
      audit.status !== "passed" ||
      (audit.findings as { blocking?: boolean }[]).some(
        (finding) => finding.blocking,
      )
    )
      throw new Error("CREATOR_AUDIO_AUDIT_REQUIRED");
    return {
      assetId,
      transcriptId: row.transcriptId,
      transcriptHash,
      auditId: audit.id,
    };
  }
  async assertCreatorAudioApproved(projectId: string, assetId: string) {
    return this.database.transaction((tx) =>
      this.assertCreatorAudioApprovedLocked(tx, projectId, assetId),
    );
  }
}

export class InMemoryNarrationRepository implements NarrationRepository {
  private snapshot?: ApprovedNarrationSnapshot;
  private samples = new Map<string, NarrationSample>();
  private tracks = new Map<string, NarrationTrack>();
  private selection?: NarrationSelection;
  private creator = new Map<
    string,
    {
      projectId: string;
      assetId: string;
      transcriptText: string;
      transcriptId: string;
      provider: string;
      audited: boolean;
      approvedRevision?: number;
    }
  >();
  seedApprovedStoryboard(snapshot: ApprovedNarrationSnapshot) {
    if (
      this.snapshot &&
      (this.snapshot.revision !== snapshot.revision ||
        this.snapshot.auditId !== snapshot.auditId ||
        this.snapshot.narrationHash !== snapshot.narrationHash)
    ) {
      this.selection = undefined;
      for (const item of this.creator.values()) {
        item.audited = false;
        item.approvedRevision = undefined;
      }
    }
    this.snapshot = structuredClone(snapshot);
  }
  async loadApprovedStoryboard(projectId: string) {
    if (!this.snapshot || this.snapshot.projectId !== projectId)
      throw new Error("NARRATION_TEXT_APPROVAL_REQUIRED");
    return structuredClone(this.snapshot);
  }
  async saveSample(
    writer: ProviderResultWriter,
    input: Omit<NarrationSample, "id" | "approvedAt">,
  ) {
    const item = { ...input, id: randomUUID(), approvedAt: null };
    await writer.writeStructured(async () => {
      if (
        !this.snapshot ||
        this.snapshot.projectId !== input.projectId ||
        this.snapshot.storyboardId !== input.storyboardId ||
        this.snapshot.auditId !== input.auditId ||
        this.snapshot.narrationHash !== input.narrationHash
      )
        throw new Error("NARRATION_APPROVAL_CHANGED_DURING_DISPATCH");
      this.samples.set(item.id, item);
    });
    return structuredClone(item);
  }
  async findSampleByProviderRun(projectId: string, providerRunId: string) {
    const found = [...this.samples.values()].find(
      (item) =>
        item.projectId === projectId && item.providerRunId === providerRunId,
    );
    return found && structuredClone(found);
  }
  async findSample(projectId: string, id: string) {
    const found = this.samples.get(id);
    return found?.projectId === projectId ? structuredClone(found) : undefined;
  }
  async approveSample(projectId: string, id: string) {
    const sample = this.samples.get(id);
    if (
      !sample ||
      sample.projectId !== projectId ||
      !this.snapshot ||
      sample.auditId !== this.snapshot.auditId ||
      sample.narrationHash !== this.snapshot.narrationHash
    )
      throw new Error("NARRATION_SAMPLE_STALE");
    sample.approvedAt = new Date();
    return structuredClone(sample);
  }
  async setSelection(projectId: string, selection: NarrationSelection) {
    if (!this.snapshot || this.snapshot.projectId !== projectId)
      throw new Error("STORYBOARD_NOT_FOUND");
    if (selection.kind === "generated") {
      const sample = this.samples.get(selection.sampleId);
      if (
        !sample?.approvedAt ||
        sample.auditId !== this.snapshot.auditId ||
        sample.narrationHash !== this.snapshot.narrationHash
      )
        throw new Error("NARRATION_SAMPLE_APPROVAL_REQUIRED");
    } else {
      await this.assertCreatorAudioApproved(projectId, selection.assetId);
    }
    this.selection = structuredClone(selection);
    return selection;
  }
  async getSelection(projectId: string) {
    return this.snapshot?.projectId === projectId && this.selection
      ? structuredClone(this.selection)
      : undefined;
  }
  async findTrackByProviderRun(projectId: string, runId: string) {
    const found = [...this.tracks.values()].find(
      (item) => item.projectId === projectId && item.providerRunId === runId,
    );
    return found && structuredClone(found);
  }
  async findTrack(
    projectId: string,
    sceneId: string,
    hash: string,
    provider: string,
    model: string,
    voice: string,
  ) {
    const found = [...this.tracks.values()].find(
      (item) =>
        item.projectId === projectId &&
        item.sceneId === sceneId &&
        item.sourceTextHash === hash &&
        item.provider === provider &&
        item.model === model &&
        item.voice === voice,
    );
    return found && structuredClone(found);
  }
  async saveTrack(
    writer: ProviderResultWriter,
    input: Omit<NarrationTrack, "id">,
  ) {
    const item = { ...input, id: randomUUID() };
    await writer.writeStructured(async () => {
      if (
        !this.snapshot ||
        !this.selection ||
        this.snapshot.projectId !== input.projectId ||
        this.snapshot.storyboardId !== input.storyboardId ||
        this.snapshot.auditId !== input.auditId ||
        this.snapshot.narrationHash !== input.narrationHash ||
        this.selection.kind !== "generated" ||
        this.selection.provider !== input.provider ||
        this.selection.model !== input.model ||
        this.selection.voice !== input.voice
      )
        throw new Error("NARRATION_APPROVAL_CHANGED_DURING_DISPATCH");
      this.tracks.set(item.id, item);
    });
    return structuredClone(item);
  }
  seedCreatorAudio(input: {
    projectId: string;
    assetId: string;
    transcriptText: string;
    provider: string;
    audited: boolean;
  }) {
    this.creator.set(input.assetId, { ...input, transcriptId: randomUUID() });
  }
  approveCreatorTranscript(projectId: string, assetId: string) {
    const row = this.creator.get(assetId);
    if (
      row?.projectId === projectId &&
      this.snapshot?.projectId === projectId
    ) {
      row.audited = true;
      row.approvedRevision = this.snapshot.revision;
    }
  }
  async assertCreatorAudioApproved(projectId: string, assetId: string) {
    const row = this.creator.get(assetId);
    if (
      !row ||
      row.projectId !== projectId ||
      row.provider !== "deepgram" ||
      !row.audited ||
      row.approvedRevision !== this.snapshot?.revision
    )
      throw new Error("CREATOR_AUDIO_AUDIT_REQUIRED");
    return {
      assetId,
      transcriptId: row.transcriptId,
      transcriptHash: createHash("sha256")
        .update(JSON.stringify({ text: row.transcriptText }))
        .digest("hex"),
      auditId: randomUUID(),
    };
  }
}
