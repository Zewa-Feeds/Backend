import { describe, it, expect } from 'vitest';
import { seedTargetProblem, assertSeedTargetIsLocal } from './seedGuard';

const LOCAL = 'postgresql://zewa:zewa_local_dev@localhost:5433/zewa_feeds?schema=public';

describe('seed target guard', () => {
  it('allows the local docker database', () => {
    expect(seedTargetProblem({ NODE_ENV: 'development', DATABASE_URL: LOCAL })).toBeNull();
    expect(seedTargetProblem({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/x' })).toBeNull();
  });

  it('refuses when NODE_ENV is production, even on a local host', () => {
    expect(seedTargetProblem({ NODE_ENV: 'production', DATABASE_URL: LOCAL })).toMatch(/production/);
  });

  it('refuses Supabase, Neon and any other remote host', () => {
    for (const url of [
      'postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      'postgresql://u:pw@db.abc.supabase.co:5432/postgres',
      'postgresql://u:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb',
      'postgresql://u:pw@10.0.0.5:5432/zewa',
    ]) {
      expect(seedTargetProblem({ NODE_ENV: 'development', DATABASE_URL: url })).toMatch(/not a local database/);
    }
  });

  it('refuses a missing or malformed DATABASE_URL', () => {
    expect(seedTargetProblem({})).toMatch(/not set/);
    expect(seedTargetProblem({ DATABASE_URL: 'not a url' })).toMatch(/not a valid URL/);
  });

  it('throws before anything is written', () => {
    expect(() => assertSeedTargetIsLocal({ NODE_ENV: 'production', DATABASE_URL: LOCAL })).toThrow(/Refusing to seed/);
  });
});
