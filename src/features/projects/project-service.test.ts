import {describe, expect, it} from 'vitest';

import {InMemoryProjectRepository} from './project-repository';
import {ProjectService} from './project-service';

const validInput = {
  title: 'Maple Street',
  subjectName: 'Ruth',
  creatorName: 'Tom',
  creatorRelationship: 'son'
};

const createService = () => {
  const repository = new InMemoryProjectRepository();
  return {repository, service: new ProjectService(repository)};
};

describe('ProjectService', () => {
  it('creates one subject and returns a one-time owner token', async () => {
    const {repository, service} = createService();

    const result = await service.createProject(validInput);

    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.ownerToken).toHaveLength(64);
    expect(repository.subjectsFor(result.projectId)).toHaveLength(1);
    await expect(
      service.assertOwner(result.projectId, result.ownerToken)
    ).resolves.toBeUndefined();
  });

  it('rejects a bad owner token', async () => {
    const {service} = createService();
    const created = await service.createProject(validInput);

    await expect(
      service.assertOwner(created.projectId, '0'.repeat(64))
    ).rejects.toThrow('PROJECT_FORBIDDEN');
  });
});
