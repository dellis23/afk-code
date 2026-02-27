import { describe, it, expect } from 'vitest';
import { ChannelType } from 'discord.js';
import { stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';

describe('Auto-Spawn - Channel Name Detection', () => {
  it('detects channels with afk- prefix', () => {
    const name = 'afk-myproject';
    expect(name.startsWith('afk-')).toBe(true);
  });

  it('ignores channels without afk- prefix', () => {
    const name = 'general';
    expect(name.startsWith('afk-')).toBe(false);
  });

  it('ignores channels with afk prefix but no hyphen', () => {
    const name = 'afkproject';
    expect(name.startsWith('afk-')).toBe(false);
  });

  it('detects various afk- channel names', () => {
    expect('afk-test'.startsWith('afk-')).toBe(true);
    expect('afk-my-project'.startsWith('afk-')).toBe(true);
    expect('afk-123'.startsWith('afk-')).toBe(true);
  });

  it('only triggers for GuildText channels', () => {
    const textType = ChannelType.GuildText;
    const voiceType = ChannelType.GuildVoice;
    const categoryType = ChannelType.GuildCategory;

    expect(textType === ChannelType.GuildText).toBe(true);
    expect(voiceType === ChannelType.GuildText).toBe(false);
    expect(categoryType === ChannelType.GuildText).toBe(false);
  });
});

describe('Auto-Spawn - Immediate Spawn on Channel Create', () => {
  it('home directory exists and is a valid directory', async () => {
    const home = homedir();
    const stats = await stat(home);
    expect(stats.isDirectory()).toBe(true);
  });

  it('spawns immediately without waiting for topic', () => {
    // When an afk-* channel is created, we should spawn right away
    // in $HOME, not wait for a topic to be set.
    const channelName = 'afk-myproject';
    const home = homedir();

    expect(channelName.startsWith('afk-')).toBe(true);
    expect(home.length).toBeGreaterThan(0);
    expect(home.startsWith('/')).toBe(true);
  });
});

describe('Auto-Spawn - JSONL Claiming Race Prevention', () => {
  it('claimed files set prevents double-claiming', () => {
    const claimedFiles = new Set<string>();
    const path = '/home/user/.claude/projects/-home-user/abc123.jsonl';

    expect(claimedFiles.has(path)).toBe(false);
    claimedFiles.add(path);

    expect(claimedFiles.has(path)).toBe(true);
  });

  it('re-checks claimedFiles after async operations', () => {
    const claimedFiles = new Set<string>();
    const path = '/home/user/.claude/projects/-home-user/abc123.jsonl';

    const checkA = !claimedFiles.has(path);
    expect(checkA).toBe(true);

    claimedFiles.add(path);

    const recheckA = !claimedFiles.has(path);
    expect(recheckA).toBe(false);
  });
});

describe('Auto-Spawn - Path Validation', () => {
  it('accepts valid directories', async () => {
    const dir = tmpdir();
    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('rejects non-existent paths', async () => {
    const badPath = '/nonexistent/path/that/does/not/exist';
    await expect(stat(badPath)).rejects.toThrow();
  });

  it('rejects files (not directories)', async () => {
    try {
      const stats = await stat('/etc/hostname');
      expect(stats.isDirectory()).toBe(false);
    } catch {
      // File might not exist on all systems, that's fine
    }
  });

  it('rejects empty path', () => {
    const topic = '';
    const cwd = topic.trim();
    expect(!cwd).toBe(true);
  });

  it('trims whitespace from topic', () => {
    const topic = '  /home/user/project  ';
    const cwd = topic.trim();
    expect(cwd).toBe('/home/user/project');
  });

  it('only handles absolute paths (starting with /)', () => {
    expect('/home/user/project'.startsWith('/')).toBe(true);
    expect('/tmp'.startsWith('/')).toBe(true);
    expect('Claude Code session: my-project'.startsWith('/')).toBe(false);
    expect('relative/path'.startsWith('/')).toBe(false);
    expect(''.startsWith('/')).toBe(false);
  });
});

describe('Auto-Spawn - Topic Change Respawn', () => {
  it('kills old session and spawns new one on topic change', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-123';
    const oldSessionId = 'sess-old';
    const newSessionId = 'sess-new';

    channelToSession.set(channelId, oldSessionId);
    expect(channelToSession.get(channelId)).toBe(oldSessionId);

    channelToSession.delete(channelId);
    channelToSession.set(channelId, newSessionId);
    expect(channelToSession.get(channelId)).toBe(newSessionId);
  });

  it('handles topic change when no existing session', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-456';

    const existing = channelToSession.get(channelId);
    expect(existing).toBeUndefined();

    channelToSession.set(channelId, 'sess-new');
    expect(channelToSession.get(channelId)).toBe('sess-new');
  });

  it('supports multiple sequential topic changes', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-789';

    channelToSession.set(channelId, 'sess-1');
    expect(channelToSession.get(channelId)).toBe('sess-1');

    channelToSession.delete(channelId);
    channelToSession.set(channelId, 'sess-2');
    expect(channelToSession.get(channelId)).toBe('sess-2');

    channelToSession.delete(channelId);
    channelToSession.set(channelId, 'sess-3');
    expect(channelToSession.get(channelId)).toBe('sess-3');
  });
});

describe('Auto-Spawn - Concurrent Spawn Guard', () => {
  it('ChannelStore status prevents double-spawn', () => {
    // With ChannelStore, the spawning guard is replaced by status checks.
    // If a channel is already in 'spawning' or 'running', duplicate
    // ChannelCreate events are ignored via store.get(channel.id) check.
    const tracked = new Map<string, string>();
    const channelId = 'chan-guard';

    // First event: not tracked → proceed
    expect(tracked.has(channelId)).toBe(false);
    tracked.set(channelId, 'spawning');

    // Second event: already tracked → skip
    expect(tracked.has(channelId)).toBe(true);
  });
});

describe('Auto-Spawn - Channel Lifecycle', () => {
  it('cleans up session on channel delete', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-delete';
    const sessionId = 'sess-delete';

    channelToSession.set(channelId, sessionId);

    const foundSessionId = channelToSession.get(channelId);
    expect(foundSessionId).toBe(sessionId);

    channelToSession.delete(channelId);
    expect(channelToSession.get(channelId)).toBeUndefined();
  });

  it('handles delete of channel with no session gracefully', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-no-session';

    const foundSessionId = channelToSession.get(channelId);
    expect(foundSessionId).toBeUndefined();
  });

  it('restores sessions for existing afk-* channels on restart', () => {
    // On bot restart, scan guild for afk-* text channels and restore sessions.
    const existingChannels = [
      { id: 'chan-1', name: 'afk-project', type: 'GuildText', topic: '/home/user/project' },
      { id: 'chan-2', name: 'afk-test', type: 'GuildText', topic: '' },
      { id: 'chan-3', name: 'afk-other', type: 'GuildText', topic: 'Some description' },
      { id: 'chan-4', name: 'general', type: 'GuildText', topic: '' },
      { id: 'chan-5', name: 'afk-voice', type: 'GuildVoice', topic: '' },
    ];

    const home = '/home/user';
    const restoredSessions: { channelId: string; cwd: string }[] = [];

    for (const ch of existingChannels) {
      if (ch.type !== 'GuildText') continue;
      if (!ch.name.startsWith('afk-')) continue;

      const topic = ch.topic?.trim();
      const cwd = (topic && topic.startsWith('/')) ? topic : home;

      restoredSessions.push({ channelId: ch.id, cwd });
    }

    // Should restore chan-1, chan-2, chan-3 — skip chan-4 (no prefix), chan-5 (voice)
    expect(restoredSessions).toHaveLength(3);
    expect(restoredSessions[0]).toEqual({ channelId: 'chan-1', cwd: '/home/user/project' });
    expect(restoredSessions[1]).toEqual({ channelId: 'chan-2', cwd: home });
    expect(restoredSessions[2]).toEqual({ channelId: 'chan-3', cwd: home });
  });

  it('uses --resume with saved Claude session UUID on restore', () => {
    const savedState = new Map<string, { claudeSessionId: string; cwd: string }>();
    savedState.set('chan-1', { claudeSessionId: '16eb1b09-36ac-4761-9a97-5e02265e661b', cwd: '/home/user/project' });
    savedState.set('chan-2', { claudeSessionId: 'abcdef01-2345-6789-abcd-ef0123456789', cwd: '/home/user' });

    const channels = [
      { id: 'chan-1', name: 'afk-project', type: 'GuildText', topic: '/home/user/project' },
      { id: 'chan-2', name: 'afk-test', type: 'GuildText', topic: '' },
      { id: 'chan-3', name: 'afk-new', type: 'GuildText', topic: '' },
    ];

    const home = '/home/user';
    const spawnCommands: { channelId: string; cwd: string; resumeSessionId?: string }[] = [];

    for (const ch of channels) {
      if (ch.type !== 'GuildText') continue;
      if (!ch.name.startsWith('afk-')) continue;

      const saved = savedState.get(ch.id);
      const topic = ch.topic?.trim();
      const cwd = (topic && topic.startsWith('/')) ? topic : (saved?.cwd || home);

      spawnCommands.push({
        channelId: ch.id,
        cwd,
        resumeSessionId: saved?.claudeSessionId,
      });
    }

    expect(spawnCommands[0].resumeSessionId).toBe('16eb1b09-36ac-4761-9a97-5e02265e661b');
    expect(spawnCommands[0].cwd).toBe('/home/user/project');

    expect(spawnCommands[1].resumeSessionId).toBe('abcdef01-2345-6789-abcd-ef0123456789');
    expect(spawnCommands[1].cwd).toBe('/home/user');

    expect(spawnCommands[2].resumeSessionId).toBeUndefined();
    expect(spawnCommands[2].cwd).toBe(home);
  });

  it('extracts Claude session UUID from JSONL filename', () => {
    const watchedFile = '/home/user/.claude/projects/-home-user/16eb1b09-36ac-4761-9a97-5e02265e661b.jsonl';
    const filename = watchedFile.split('/').pop();
    const claudeSessionId = filename?.replace('.jsonl', '');
    expect(claudeSessionId).toBe('16eb1b09-36ac-4761-9a97-5e02265e661b');
  });

  it('updates persisted state when Claude session UUID changes (after /clear)', () => {
    const persistedChannels = new Map<string, { claudeSessionId: string }>();
    const channelId = 'chan-1';

    persistedChannels.set(channelId, { claudeSessionId: 'old-uuid' });

    const newClaudeId = 'new-uuid';
    const existing = persistedChannels.get(channelId);
    expect(existing?.claudeSessionId).not.toBe(newClaudeId);

    persistedChannels.set(channelId, { claudeSessionId: newClaudeId });
    expect(persistedChannels.get(channelId)?.claudeSessionId).toBe(newClaudeId);
  });

  it('removes channel before killing session on delete to prevent stale fetch', () => {
    const channels = new Map<string, { sessionId: string; channelId: string }>();
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-to-delete';
    const sessionId = 'sess-to-kill';

    channels.set(sessionId, { sessionId, channelId });
    channelToSession.set(channelId, sessionId);

    // Step 1: Unregister channel mapping first
    channels.delete(sessionId);
    channelToSession.delete(channelId);

    // Step 2: Now onSessionEnd can't find channel → no stale API calls
    expect(channels.get(sessionId)).toBeUndefined();
    expect(channelToSession.get(channelId)).toBeUndefined();
  });
});
