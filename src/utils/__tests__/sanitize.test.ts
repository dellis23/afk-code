import { describe, it, expect } from 'vitest';
import { sanitizePtyInput, isRawControlSequence } from '../sanitize.js';

describe('sanitizePtyInput', () => {
  it('passes normal text through unchanged', () => {
    expect(sanitizePtyInput('hello world')).toBe('hello world');
    expect(sanitizePtyInput('Hello, World! 123')).toBe('Hello, World! 123');
    expect(sanitizePtyInput('/compact')).toBe('/compact');
    expect(sanitizePtyInput('/model opus')).toBe('/model opus');
  });

  it('strips null bytes (0x00)', () => {
    expect(sanitizePtyInput('hello\x00world')).toBe('helloworld');
  });

  it('strips control characters 0x01-0x09', () => {
    expect(sanitizePtyInput('a\x01b\x02c\x03d')).toBe('abcd');
    expect(sanitizePtyInput('\x04\x05\x06\x07\x08\x09')).toBe('');
  });

  it('preserves newline (0x0a)', () => {
    expect(sanitizePtyInput('hello\nworld')).toBe('hello\nworld');
    expect(sanitizePtyInput('/compact\n')).toBe('/compact\n');
  });

  it('strips vertical tab (0x0b) and form feed (0x0c)', () => {
    expect(sanitizePtyInput('a\x0bb\x0cc')).toBe('abc');
  });

  it('preserves carriage return (0x0d)', () => {
    expect(sanitizePtyInput('hello\rworld')).toBe('hello\rworld');
    expect(sanitizePtyInput('\r')).toBe('\r');
  });

  it('strips control characters 0x0e-0x1f', () => {
    let input = '';
    for (let i = 0x0e; i <= 0x1f; i++) {
      input += String.fromCharCode(i);
    }
    expect(sanitizePtyInput(input)).toBe('');
  });

  it('strips DEL character (0x7f)', () => {
    expect(sanitizePtyInput('hello\x7fworld')).toBe('helloworld');
  });

  it('handles mixed text with control characters', () => {
    expect(sanitizePtyInput('he\x00ll\x01o \x02wo\x1frld\n')).toBe('hello world\n');
  });

  it('handles empty string', () => {
    expect(sanitizePtyInput('')).toBe('');
  });

  it('preserves unicode characters', () => {
    expect(sanitizePtyInput('hello \u{1F600} world')).toBe('hello \u{1F600} world');
  });

  it('strips escape character (0x1b) which is used in ANSI sequences', () => {
    expect(sanitizePtyInput('\x1b[Z')).toBe('[Z');
    expect(sanitizePtyInput('\x1b')).toBe('');
  });
});

describe('isRawControlSequence', () => {
  it('returns true for escape sequences', () => {
    expect(isRawControlSequence('\x1b')).toBe(true);
    expect(isRawControlSequence('\x1b[Z')).toBe(true);
  });

  it('returns true for single control characters (not \\n or \\r)', () => {
    expect(isRawControlSequence('\x02')).toBe(true); // Ctrl+B
    expect(isRawControlSequence('\x03')).toBe(true); // Ctrl+C
  });

  it('returns false for \\n and \\r', () => {
    expect(isRawControlSequence('\n')).toBe(false);
    expect(isRawControlSequence('\r')).toBe(false);
  });

  it('returns false for normal text', () => {
    expect(isRawControlSequence('hello')).toBe(false);
    expect(isRawControlSequence('/compact\n')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRawControlSequence('')).toBe(false);
  });
});
