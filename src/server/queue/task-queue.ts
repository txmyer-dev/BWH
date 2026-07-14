export interface AnalysisTask {
  type: 'analyze_collection';
  projectId: string;
  jobId: string;
}

export interface ExecuteProviderRunTask {
  type: 'execute_provider_run';
  projectId: string;
  providerRunId: string;
}

export interface TranscriptionTask {
  type: 'transcribe_asset';
  projectId: string;
  assetId: string;
  jobId: string;
}

export interface CleanupProviderArtifactTask {
  type: 'cleanup_provider_artifact';
  projectId: string;
  providerRunId?: string | null;
  provider: string;
  providerArtifactId: string;
}

export type QueuedTask = AnalysisTask | TranscriptionTask | ExecuteProviderRunTask | CleanupProviderArtifactTask;

export interface TaskQueue {
  enqueue(task: QueuedTask): Promise<void>;
}
