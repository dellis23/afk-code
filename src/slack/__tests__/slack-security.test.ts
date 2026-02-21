import { describe, it, expect } from 'vitest';

/**
 * Model validation allowlist — mirrors the logic in the /model slash command handler.
 * The handler defines ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'] and checks
 * ALLOWED_MODELS.includes(modelArg.toLowerCase()).
 */
const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

function isModelAllowed(input: string): boolean {
  return ALLOWED_MODELS.includes(input.toLowerCase());
}

describe('Slack /model allowlist validation', () => {
  it('allows lowercase valid models', () => {
    expect(isModelAllowed('opus')).toBe(true);
    expect(isModelAllowed('sonnet')).toBe(true);
    expect(isModelAllowed('haiku')).toBe(true);
  });

  it('allows valid models with different casing', () => {
    expect(isModelAllowed('Opus')).toBe(true);
    expect(isModelAllowed('SONNET')).toBe(true);
    expect(isModelAllowed('Haiku')).toBe(true);
    expect(isModelAllowed('OPUS')).toBe(true);
    expect(isModelAllowed('HaIkU')).toBe(true);
  });

  it('rejects inputs containing newlines (injection attempt)', () => {
    expect(isModelAllowed('evil\ncommand')).toBe(false);
    expect(isModelAllowed('opus\nrm -rf /')).toBe(false);
    expect(isModelAllowed('\nsonnet')).toBe(false);
  });

  it('rejects inputs with extra flags (injection attempt)', () => {
    expect(isModelAllowed('opus --inject')).toBe(false);
    expect(isModelAllowed('sonnet --flag=value')).toBe(false);
    expect(isModelAllowed('haiku -x')).toBe(false);
  });

  it('rejects unknown model names', () => {
    expect(isModelAllowed('gpt-4')).toBe(false);
    expect(isModelAllowed('claude')).toBe(false);
    expect(isModelAllowed('gemini')).toBe(false);
    expect(isModelAllowed('')).toBe(false);
  });

  it('rejects models with leading/trailing spaces (not trimmed by allowlist check)', () => {
    // The handler trims command.text before passing to the check,
    // but if somehow spaces remain they should not match
    expect(isModelAllowed(' opus')).toBe(false);
    expect(isModelAllowed('opus ')).toBe(false);
    expect(isModelAllowed(' opus ')).toBe(false);
  });

  it('rejects path traversal and special characters', () => {
    expect(isModelAllowed('../../../etc/passwd')).toBe(false);
    expect(isModelAllowed('opus; rm -rf /')).toBe(false);
    expect(isModelAllowed('opus && cat /etc/shadow')).toBe(false);
    expect(isModelAllowed('$(whoami)')).toBe(false);
  });
});
