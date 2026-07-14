import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {parseEnv} from '../env';
import * as schema from './schema';

export const createDatabase = (databaseUrl: string) =>
  drizzle(postgres(databaseUrl), {schema});

export type Database = ReturnType<typeof createDatabase>;

let database: Database | undefined;

export const getDatabase = () => {
  database ??= createDatabase(parseEnv(process.env).DATABASE_URL);
  return database;
};
