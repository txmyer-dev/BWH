import {randomUUID} from 'node:crypto';

import {createOwnerToken, hashOwnerToken, tokensMatch} from './owner-token';
import type {ProjectRepository} from './project-repository';
import {createProjectInputSchema, type CreateProjectInput} from './types';

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async createProject(input: CreateProjectInput) {
    const validated = createProjectInputSchema.parse(input);
    const projectId = randomUUID();
    const ownerToken = createOwnerToken();

    await this.repository.createWithSubject({
      ...validated,
      id: projectId,
      subjectId: randomUUID(),
      ownerTokenHash: hashOwnerToken(ownerToken)
    });

    return {projectId, ownerToken};
  }

  async assertOwner(projectId: string, token: string) {
    const ownerTokenHash = await this.repository.findOwnerTokenHash(projectId);
    if (!ownerTokenHash || !tokensMatch(token, ownerTokenHash)) {
      throw new Error('PROJECT_FORBIDDEN');
    }
  }

  async assertProjectOwner(projectId: string, token: string) {
    return this.assertOwner(projectId, token);
  }
}

export const createProject = (
  repository: ProjectRepository,
  input: CreateProjectInput
) => new ProjectService(repository).createProject(input);

export const assertProjectOwner = (
  repository: ProjectRepository,
  projectId: string,
  token: string
) => new ProjectService(repository).assertProjectOwner(projectId, token);
