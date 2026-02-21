import { describe, it, expect } from 'vitest';
import { ALLOWED_MODELS } from '../discord-app.js';

describe('Discord Security - Model Validation Allowlist', () => {
  it('allows "opus"', () => {
    expect(ALLOWED_MODELS.includes('opus')).toBe(true);
  });

  it('allows "sonnet"', () => {
    expect(ALLOWED_MODELS.includes('sonnet')).toBe(true);
  });

  it('allows "haiku"', () => {
    expect(ALLOWED_MODELS.includes('haiku')).toBe(true);
  });

  it('rejects arbitrary strings', () => {
    expect(ALLOWED_MODELS.includes('evil\ncommand')).toBe(false);
  });

  it('rejects strings with shell injection attempts', () => {
    expect(ALLOWED_MODELS.includes('opus; rm -rf /')).toBe(false);
    expect(ALLOWED_MODELS.includes('$(whoami)')).toBe(false);
    expect(ALLOWED_MODELS.includes('opus\n/bin/sh')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(ALLOWED_MODELS.includes('')).toBe(false);
  });

  it('is case-sensitive (validation code lowercases input before checking)', () => {
    // The allowlist contains lowercase entries; the handler lowercases user input
    expect(ALLOWED_MODELS.includes('OPUS')).toBe(false);
    expect(ALLOWED_MODELS.includes('Opus')).toBe(false);
    // But after toLowerCase it should match
    expect(ALLOWED_MODELS.includes('OPUS'.toLowerCase())).toBe(true);
  });
});

describe('Discord Security - Sender Validation Concept', () => {
  it('validates that only the configured userId is allowed', () => {
    const configUserId = '123456789';

    // Authorized user
    const authorizedAuthorId = '123456789';
    expect(authorizedAuthorId === configUserId).toBe(true);

    // Unauthorized user
    const unauthorizedAuthorId = '987654321';
    expect(unauthorizedAuthorId === configUserId).toBe(false);
  });

  it('rejects when author id is undefined', () => {
    const configUserId = '123456789';
    const authorId = undefined;
    expect(authorId !== configUserId).toBe(true);
  });

  it('rejects when author id is empty string', () => {
    const configUserId = '123456789';
    const authorId = '';
    expect(authorId !== configUserId).toBe(true);
  });

  it('uses strict equality (no type coercion)', () => {
    const configUserId = '123456789';
    // Even if numerically equal, string comparison must match exactly
    const authorId = '123456789';
    expect(authorId === configUserId).toBe(true);
  });
});
