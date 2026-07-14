import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const credentialRules = ['.env', '.env.*', '!.env.example'];

function rulesFrom(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('credential ignore rules', () => {
  it.each(['.gitignore', '.dockerignore'])('%s protects environment credentials', (file) => {
    const rules = rulesFrom(file);

    expect(rules).toEqual(expect.arrayContaining(credentialRules));
    expect(rules.indexOf('!.env.example')).toBeGreaterThan(rules.indexOf('.env.*'));
  });

  it('makes Git ignore environment credentials but keep the safe example', () => {
    const candidates = ['.env', '.env.local', '.env.production', '.env.example'];
    const result = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `${candidates.join('\n')}\n`
    });

    expect(result.stdout.trim().split(/\r?\n/)).toEqual(candidates.slice(0, 3));
  });
});
