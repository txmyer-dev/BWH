import type {Database} from '../../server/db/client';
import {projects, subjects} from '../../server/db/schema';
import type {StoredProjectInput} from './types';

export interface ProjectRepository {
  createWithSubject(input: StoredProjectInput): Promise<void>;
  findOwnerTokenHash(projectId: string): Promise<string | undefined>;
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly database: Database) {}

  async createWithSubject(input: StoredProjectInput) {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(projects).values({
        id: input.id,
        title: input.title,
        creatorName: input.creatorName,
        creatorRelationship: input.creatorRelationship,
        giftIntention: input.giftIntention,
        ownerTokenHash: input.ownerTokenHash
      });
      await transaction.insert(subjects).values({
        id: input.subjectId,
        projectId: input.id,
        name: input.subjectName
      });
    });
  }

  async findOwnerTokenHash(projectId: string) {
    const project = await this.database.query.projects.findFirst({
      columns: {ownerTokenHash: true},
      where: (table, {eq}) => eq(table.id, projectId)
    });
    return project?.ownerTokenHash;
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, StoredProjectInput>();
  private readonly subjects = new Map<string, string[]>();

  async createWithSubject(input: StoredProjectInput) {
    this.projects.set(input.id, {...input});
    this.subjects.set(input.id, [input.subjectName]);
  }

  async findOwnerTokenHash(projectId: string) {
    return this.projects.get(projectId)?.ownerTokenHash;
  }

  subjectsFor(projectId: string) {
    return [...(this.subjects.get(projectId) ?? [])];
  }
}
