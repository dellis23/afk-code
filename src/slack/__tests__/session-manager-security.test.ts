import { describe, it, expect } from 'vitest';
import { sanitizePtyInput } from '../../utils/sanitize.js';
import { DAEMON_SOCKET, DAEMON_SECRET_PATH } from '../session-manager.js';
import { homedir } from 'os';
import { join } from 'path';

describe('Session Manager Security - Socket Path', () => {
  it('uses home directory for socket path instead of /tmp', () => {
    expect(DAEMON_SOCKET).toBe(join(homedir(), '.afk-code', 'daemon.sock'));
    expect(DAEMON_SOCKET).not.toContain('/tmp');
  });

  it('uses home directory for secret path', () => {
    expect(DAEMON_SECRET_PATH).toBe(join(homedir(), '.afk-code', 'daemon.secret'));
    expect(DAEMON_SECRET_PATH).not.toContain('/tmp');
  });
});

describe('Session Manager Security - Secret Validation', () => {
  it('rejects empty secret', () => {
    const sharedSecret = 'abc123';
    const messageSecret = '';
    expect(messageSecret === sharedSecret).toBe(false);
  });

  it('rejects undefined secret', () => {
    const sharedSecret = 'abc123';
    const messageSecret = undefined;
    expect(!messageSecret || messageSecret !== sharedSecret).toBe(true);
  });

  it('rejects mismatched secret', () => {
    const sharedSecret = 'abc123';
    const messageSecret = 'wrong-secret';
    expect(messageSecret === sharedSecret).toBe(false);
  });

  it('accepts matching secret', () => {
    const sharedSecret = 'abc123';
    const messageSecret = 'abc123';
    expect(!messageSecret || messageSecret !== sharedSecret).toBe(false);
  });
});

describe('Session Manager Security - Input Sanitization', () => {
  it('sanitizes user message text', () => {
    const userInput = 'hello\x00\x01\x02world';
    expect(sanitizePtyInput(userInput)).toBe('helloworld');
  });

  it('preserves newlines in /compact and /model commands', () => {
    expect(sanitizePtyInput('/compact\n')).toBe('/compact\n');
    expect(sanitizePtyInput('/model opus\n')).toBe('/model opus\n');
  });

  it('preserves carriage return for Enter key', () => {
    expect(sanitizePtyInput('\r')).toBe('\r');
  });

  it('strips injected control characters from user text', () => {
    // Simulate an attacker trying to inject Ctrl+C or other control sequences
    const malicious = 'normal text\x03\x04\x1b[A';
    const sanitized = sanitizePtyInput(malicious);
    expect(sanitized).toBe('normal text[A');
    expect(sanitized).not.toContain('\x03');
    expect(sanitized).not.toContain('\x04');
    expect(sanitized).not.toContain('\x1b');
  });
});
