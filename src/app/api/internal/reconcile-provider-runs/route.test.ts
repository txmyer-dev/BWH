import {describe, expect, it, vi} from 'vitest';

import {removeProviderArtifact, reconcileProviderRuns} from './route';

describe('provider reconciliation route', () => {
  it('deletes retired private media from GCS without calling a provider API', async () => {
    const gcs = {deleteMany: vi.fn().mockResolvedValue(undefined)};
    const fetchImpl = vi.fn();
    const deactivateProviderRun = vi.fn().mockResolvedValue(undefined);
    const projectId = crypto.randomUUID(); const runId = crypto.randomUUID(); const sceneId = crypto.randomUUID();

    for (const providerArtifactId of [
      `projects/${projectId}/narration/${runId}/sample.wav`,
      `projects/${projectId}/narration/${runId}/scenes/${sceneId}.wav`
    ]) await removeProviderArtifact(
      {projectId, providerRunId: runId, provider: 'google_cloud_storage', providerArtifactId},
      {gcs, fetchImpl, deactivateProviderRun}
    );

    expect(deactivateProviderRun).toHaveBeenCalledTimes(2);
    expect(deactivateProviderRun.mock.invocationCallOrder[0]).toBeLessThan(gcs.deleteMany.mock.invocationCallOrder[0]);
    expect(gcs.deleteMany).toHaveBeenCalledWith([`projects/${projectId}/narration/${runId}/sample.wav`]);
    expect(gcs.deleteMany).toHaveBeenCalledWith([`projects/${projectId}/narration/${runId}/scenes/${sceneId}.wav`]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-project', (projectId: string, runId: string) => `projects/${crypto.randomUUID()}/narration/${runId}/sample.wav`],
    ['other-prefix', (projectId: string, runId: string) => `projects/${projectId}/uploads/${runId}/sample.wav`],
    ['traversal', (projectId: string, runId: string) => `projects/${projectId}/narration/${runId}/../sample.wav`],
    ['signed-url', (projectId: string, runId: string) => `https://storage.example/projects/${projectId}/narration/${runId}/sample.wav?signature=x`]
  ])('refuses malformed GCS cleanup rows: %s', async (_label, objectKey) => {
    const projectId = crypto.randomUUID(); const runId = crypto.randomUUID();
    const gcs = {deleteMany: vi.fn()}; const deactivateProviderRun = vi.fn();
    await expect(removeProviderArtifact(
      {projectId, providerRunId: runId, provider: 'google_cloud_storage', providerArtifactId: objectKey(projectId, runId)},
      {gcs, deactivateProviderRun}
    )).rejects.toThrow('PROVIDER_ARTIFACT_GCS_KEY_INVALID');
    expect(deactivateProviderRun).not.toHaveBeenCalled(); expect(gcs.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects unverified callers before reconciliation', async () => {
    const reconcileExpired = vi.fn(); const reconcileArtifacts = vi.fn();
    const response = await reconcileProviderRuns(new Request('https://service.example/internal'), {verifier: {verifyIdToken: vi.fn()}, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired, reconcileArtifacts});
    expect(response.status).toBe(401); expect(reconcileExpired).not.toHaveBeenCalled(); expect(reconcileArtifacts).not.toHaveBeenCalled();
  });

  it('reconciles ambiguous deadlines and artifact cleanup for verified Google OIDC', async () => {
    const verifier = {verifyIdToken: vi.fn().mockResolvedValue({getPayload: () => ({iss: 'https://accounts.google.com', aud: 'https://service.example', email: 'tasks@example.com', email_verified: true})})};
    const response = await reconcileProviderRuns(new Request('https://service.example/internal', {method: 'POST', headers: {authorization: 'Bearer token'}}), {verifier, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired: vi.fn().mockResolvedValue(2), reconcileArtifacts: vi.fn().mockResolvedValue(3)});
    expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({runs: 2, artifacts: 3});
  });

  it('does not expose internal reconciliation errors', async () => {
    const verifier = {verifyIdToken: vi.fn().mockResolvedValue({getPayload: () => ({iss: 'https://accounts.google.com', aud: 'https://service.example', email: 'tasks@example.com', email_verified: true})})};
    const response = await reconcileProviderRuns(new Request('https://service.example/internal', {method: 'POST', headers: {authorization: 'Bearer token'}}), {verifier, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired: vi.fn().mockRejectedValue(new Error('signed-url-secret')), reconcileArtifacts: vi.fn()});
    expect(response.status).toBe(500); await expect(response.json()).resolves.toEqual({error: 'PROVIDER_RECONCILIATION_FAILED'});
  });
});
