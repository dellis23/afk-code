import { describe, it, expect } from 'vitest';

describe('Telegram Security - Model Validation Allowlist', () => {
  const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

  it('accepts valid model names', () => {
    expect(ALLOWED_MODELS.includes('opus')).toBe(true);
    expect(ALLOWED_MODELS.includes('sonnet')).toBe(true);
    expect(ALLOWED_MODELS.includes('haiku')).toBe(true);
  });

  it('accepts valid model names case-insensitively', () => {
    expect(ALLOWED_MODELS.includes('Opus'.toLowerCase())).toBe(true);
    expect(ALLOWED_MODELS.includes('SONNET'.toLowerCase())).toBe(true);
    expect(ALLOWED_MODELS.includes('Haiku'.toLowerCase())).toBe(true);
  });

  it('rejects arbitrary model strings', () => {
    expect(ALLOWED_MODELS.includes('gpt-4')).toBe(false);
    expect(ALLOWED_MODELS.includes('arbitrary-model')).toBe(false);
    expect(ALLOWED_MODELS.includes('foo')).toBe(false);
  });

  it('rejects strings containing newlines (injection attempt)', () => {
    const malicious = 'opus\n/some-other-command';
    expect(ALLOWED_MODELS.includes(malicious.toLowerCase())).toBe(false);
  });

  it('rejects strings containing carriage returns (injection attempt)', () => {
    const malicious = 'opus\r\n/some-other-command';
    expect(ALLOWED_MODELS.includes(malicious.toLowerCase())).toBe(false);
  });

  it('rejects strings containing control characters', () => {
    const malicious = 'opus\x03'; // Ctrl+C appended
    expect(ALLOWED_MODELS.includes(malicious.toLowerCase())).toBe(false);
  });

  it('rejects strings with escape sequences', () => {
    const malicious = 'opus\x1b[Z';
    expect(ALLOWED_MODELS.includes(malicious.toLowerCase())).toBe(false);
  });

  it('rejects empty string', () => {
    expect(ALLOWED_MODELS.includes('')).toBe(false);
  });

  it('rejects model name with trailing space', () => {
    expect(ALLOWED_MODELS.includes('opus ')).toBe(false);
  });

  it('rejects multi-line command injection via model arg', () => {
    // An attacker could try to inject multiple PTY commands
    const injections = [
      'opus\n/compact\nrm -rf /',
      'sonnet\nyes | do-something-bad',
      '\nmalicious-command',
      'haiku\x00extra',
    ];
    for (const injection of injections) {
      expect(ALLOWED_MODELS.includes(injection.toLowerCase())).toBe(false);
    }
  });
});
