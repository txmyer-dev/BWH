import type {CollectionAnalysis, CollectionAnalysisInput} from './schemas';

export interface StoryAgent {
  analyzeCollection(input: CollectionAnalysisInput): Promise<CollectionAnalysis>;
}
