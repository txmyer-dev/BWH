export interface AnalysisTask {
  type: 'analyze_collection';
  projectId: string;
  jobId: string;
}

export interface TaskQueue {
  enqueue(task: AnalysisTask): Promise<void>;
}
