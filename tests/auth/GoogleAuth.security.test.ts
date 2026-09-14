import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('GoogleAuth diagnostics', () => {
  it('never serializes the OAuth callback parameters containing tokens to logs', () => {
    const source = readFileSync(join(process.cwd(), 'src/auth/GoogleAuth.ts'), 'utf8');
    expect(source).not.toContain('JSON.stringify(params)');
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).not.toContain('JSON.stringify(params)');
  });
});
