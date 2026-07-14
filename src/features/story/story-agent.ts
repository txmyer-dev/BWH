import type {CollectionAnalysis, CollectionAnalysisInput} from './schemas';

export interface StoryAgent {
  /** All implementations must execute provider I/O through ProviderExecutor. */
  analyzeCollection(input: CollectionAnalysisInput): Promise<CollectionAnalysis>;
}
