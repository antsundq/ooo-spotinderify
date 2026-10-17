import { describe, expect, it } from 'vitest';
import { codeChallenge, randomString } from '../src/auth/pkce';

describe('pkce', () => {
  // Expected value from: node -e "crypto.createHash('sha256').update(v).digest('base64url')"
  it('computes the S256 challenge as base64url(sha256(verifier))', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K1uhbF2NyY4zWjDVvbvP2dI1eM')).toBe(
      '4Rivd3SPIYZEYM96EoBQUOgsrExZ__YVrMeQBxY4zGk',
    );
  });

  it('generates verifiers with only allowed characters', () => {
    const v = randomString(128);
    expect(v).toHaveLength(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});
