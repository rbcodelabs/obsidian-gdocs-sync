import { describe, expect, it } from 'vitest';
import { statusText } from '../../src/api/httpStatus';

describe('statusText', () => {
  it.each([
    [405, 'Method Not Allowed'],
    [408, 'Request Timeout'],
    [410, 'Gone'],
    [412, 'Precondition Failed'],
    [415, 'Unsupported Media Type'],
    [422, 'Unprocessable Entity'],
  ])('returns the standard reason phrase for HTTP %i', (status, reason) => {
    expect(statusText(status)).toBe(reason);
  });

  it('returns an empty phrase for an unregistered status', () => {
    expect(statusText(799)).toBe('');
  });
});
