type EvidenceLocator<T> = {findById(id: string): Promise<T | undefined>};

export const authorizeEvidenceAccess = async <T extends {projectId: string}>(
  projectId: string,
  evidenceId: string,
  authorize: (projectId: string) => Promise<void>,
  repository: EvidenceLocator<T>
) => {
  await authorize(projectId);
  const item = await repository.findById(evidenceId);
  if (!item || item.projectId !== projectId) throw new Error('EVIDENCE_NOT_FOUND');
  return item;
};
