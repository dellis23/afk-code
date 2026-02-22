import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizePtyInput } from '../../utils/sanitize.js';
import { getClaudeProjectDir } from '../../utils/claude-paths.js';
import { homedir } from 'os';

describe('Session Manager - getClaudeProjectDir', () => {
  it('encodes paths by replacing / with -', () => {
    const result = getClaudeProjectDir('/home/user/project');
    expect(result).toBe(`${homedir()}/.claude/projects/-home-user-project`);
  });

  it('handles root path', () => {
    const result = getClaudeProjectDir('/');
    expect(result).toBe(`${homedir()}/.claude/projects/-`);
  });

  it('handles deeply nested paths', () => {
    const result = getClaudeProjectDir('/home/user/projects/my/deep/path');
    expect(result).toBe(`${homedir()}/.claude/projects/-home-user-projects-my-deep-path`);
  });
});

describe('Session Manager - sendInput dual mode', () => {
  it('sanitizes input for socket sessions', () => {
    const input = 'hello\x00\x01\x02world';
    const sanitized = sanitizePtyInput(input);
    expect(sanitized).toBe('helloworld');
  });

  it('preserves newlines for commands', () => {
    expect(sanitizePtyInput('/compact\n')).toBe('/compact\n');
    expect(sanitizePtyInput('/model opus\n')).toBe('/model opus\n');
  });

  it('preserves carriage return for Enter', () => {
    expect(sanitizePtyInput('\r')).toBe('\r');
  });
});

describe('Session Manager - spawnSession concept', () => {
  it('generates session with correct projectDir', () => {
    const cwd = '/home/user/myproject';
    const projectDir = getClaudeProjectDir(cwd);
    expect(projectDir).toContain('.claude/projects/');
    expect(projectDir).toContain('-home-user-myproject');
  });

  it('creates session name from sessionId', () => {
    const sessionId = 'abcd1234';
    const name = `claude-${sessionId}`;
    expect(name).toBe('claude-abcd1234');
  });
});

describe('Session Manager - killSession concept', () => {
  it('kills PTY when session has pty', () => {
    const killed = { value: false };
    const mockPty = {
      kill: () => { killed.value = true; },
    };

    // Simulate killSession for PTY session
    if (mockPty) {
      try { mockPty.kill(); } catch {}
    }
    expect(killed.value).toBe(true);
  });

  it('ends socket when session has socket', () => {
    const ended = { value: false };
    const mockSocket = {
      end: () => { ended.value = true; },
    };

    // Simulate killSession for socket session
    if (mockSocket) {
      try { mockSocket.end(); } catch {}
    }
    expect(ended.value).toBe(true);
  });

  it('handles missing session gracefully', () => {
    const sessions = new Map<string, any>();
    const session = sessions.get('nonexistent');
    expect(session).toBeUndefined();
  });
});

describe('Session Manager - stop cleanup', () => {
  it('kills all PTY sessions on stop', () => {
    const killed: string[] = [];
    const sessions = new Map<string, any>([
      ['sess1', { pty: { kill: () => killed.push('sess1') } }],
      ['sess2', { pty: { kill: () => killed.push('sess2') } }],
      ['sess3', { socket: { end: () => {} } }], // socket-only, no pty
    ]);

    // Simulate stop() behavior
    for (const session of sessions.values()) {
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }

    expect(killed).toEqual(['sess1', 'sess2']);
    expect(killed).not.toContain('sess3');
  });

  it('handles PTY kill errors gracefully', () => {
    const sessions = new Map<string, any>([
      ['sess1', { pty: { kill: () => { throw new Error('already dead'); } } }],
    ]);

    // Should not throw
    expect(() => {
      for (const session of sessions.values()) {
        if (session.pty) {
          try { session.pty.kill(); } catch {}
        }
      }
    }).not.toThrow();
  });
});
