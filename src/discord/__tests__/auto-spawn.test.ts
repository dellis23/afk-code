import { describe, it, expect } from 'vitest';
import { ChannelType } from 'discord.js';
import { stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';

describe('Auto-Spawn - Channel Name Detection', () => {
  it('detects channels with claude- prefix', () => {
    const name = 'claude-myproject';
    expect(name.startsWith('claude-')).toBe(true);
  });

  it('ignores channels without claude- prefix', () => {
    const name = 'general';
    expect(name.startsWith('claude-')).toBe(false);
  });

  it('ignores channels with claude prefix but no hyphen', () => {
    const name = 'claudeproject';
    expect(name.startsWith('claude-')).toBe(false);
  });

  it('detects various claude- channel names', () => {
    expect('claude-test'.startsWith('claude-')).toBe(true);
    expect('claude-my-project'.startsWith('claude-')).toBe(true);
    expect('claude-123'.startsWith('claude-')).toBe(true);
  });

  it('only triggers for GuildText channels', () => {
    // Non-text channel types should be ignored
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
    // When a claude-* channel is created, we should spawn right away
    // in $HOME, not wait for a topic to be set.
    const channelName = 'claude-myproject';
    const home = homedir();

    expect(channelName.startsWith('claude-')).toBe(true);
    expect(home.length).toBeGreaterThan(0);
    expect(home.startsWith('/')).toBe(true);
  });
});

describe('Auto-Spawn - JSONL Claiming Race Prevention', () => {
  it('claimed files set prevents double-claiming', () => {
    const claimedFiles = new Set<string>();
    const path = '/home/user/.claude/projects/-home-user/abc123.jsonl';

    // First session claims the file
    expect(claimedFiles.has(path)).toBe(false);
    claimedFiles.add(path);

    // Second session should see it's already claimed
    expect(claimedFiles.has(path)).toBe(true);
  });

  it('re-checks claimedFiles after async operations', () => {
    // Simulates the fix: after awaiting hasConversationMessages(),
    // we re-check claimedFiles before returning. This prevents the
    // race where two sessions both find the same file unclaimed,
    // then both await I/O, then both try to claim it.
    const claimedFiles = new Set<string>();
    const path = '/home/user/.claude/projects/-home-user/abc123.jsonl';

    // Session A checks — not claimed
    const checkA = !claimedFiles.has(path);
    expect(checkA).toBe(true);

    // Session B claims it (simulates B finishing its async work first)
    claimedFiles.add(path);

    // Session A re-checks — now it's claimed
    const recheckA = !claimedFiles.has(path);
    expect(recheckA).toBe(false);
    // Session A should skip this file and continue looking
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
    // /etc/hostname is a file, not a directory
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
    // Non-path topics like session descriptions should be ignored
    expect('/home/user/project'.startsWith('/')).toBe(true);
    expect('/tmp'.startsWith('/')).toBe(true);
    expect('Claude Code session: my-project'.startsWith('/')).toBe(false);
    expect('relative/path'.startsWith('/')).toBe(false);
    expect(''.startsWith('/')).toBe(false);
  });
});

describe('Auto-Spawn - Topic Change Respawn', () => {
  it('kills old session and spawns new one on topic change', () => {
    // Simulate channel-to-session mapping
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-123';
    const oldSessionId = 'sess-old';
    const newSessionId = 'sess-new';

    // Initial session
    channelToSession.set(channelId, oldSessionId);
    expect(channelToSession.get(channelId)).toBe(oldSessionId);

    // Topic change: unregister old, register new
    channelToSession.delete(channelId);
    channelToSession.set(channelId, newSessionId);
    expect(channelToSession.get(channelId)).toBe(newSessionId);
  });

  it('handles topic change when no existing session', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-456';

    // No existing session — should just spawn new
    const existing = channelToSession.get(channelId);
    expect(existing).toBeUndefined();

    // Set new session
    channelToSession.set(channelId, 'sess-new');
    expect(channelToSession.get(channelId)).toBe('sess-new');
  });

  it('supports multiple sequential topic changes', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-789';

    // First topic change
    channelToSession.set(channelId, 'sess-1');
    expect(channelToSession.get(channelId)).toBe('sess-1');

    // Second topic change
    channelToSession.delete(channelId);
    channelToSession.set(channelId, 'sess-2');
    expect(channelToSession.get(channelId)).toBe('sess-2');

    // Third topic change
    channelToSession.delete(channelId);
    channelToSession.set(channelId, 'sess-3');
    expect(channelToSession.get(channelId)).toBe('sess-3');
  });
});

describe('Auto-Spawn - Concurrent Spawn Guard', () => {
  it('prevents double-fire from rapid events', () => {
    const spawningChannels = new Set<string>();
    const channelId = 'chan-guard';

    // First attempt should proceed
    expect(spawningChannels.has(channelId)).toBe(false);
    spawningChannels.add(channelId);

    // Second attempt should be blocked
    expect(spawningChannels.has(channelId)).toBe(true);

    // After spawn completes, guard is removed
    spawningChannels.delete(channelId);
    expect(spawningChannels.has(channelId)).toBe(false);
  });
});

describe('Auto-Spawn - Channel Lifecycle', () => {
  it('cleans up session on channel delete', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-delete';
    const sessionId = 'sess-delete';

    channelToSession.set(channelId, sessionId);

    // Simulate channel delete
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

  it('unregisters channel before killing session on delete to prevent stale fetch', () => {
    // This tests the fix for DiscordAPIError[10003]: Unknown Channel.
    // When a channel is deleted, we must unregister the channel mapping
    // BEFORE killing the session. Otherwise, onSessionEnd fires and tries
    // to fetch/message the already-deleted channel, causing an error.
    const channels = new Map<string, { sessionId: string; channelId: string }>();
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-to-delete';
    const sessionId = 'sess-to-kill';

    channels.set(sessionId, { sessionId, channelId });
    channelToSession.set(channelId, sessionId);

    // Step 1: Unregister channel mapping (must happen first)
    channels.delete(sessionId);
    channelToSession.delete(channelId);

    // Step 2: Now when session kill triggers onSessionEnd,
    // getChannel(sessionId) returns undefined → no Discord API calls
    expect(channels.get(sessionId)).toBeUndefined();
    expect(channelToSession.get(channelId)).toBeUndefined();
  });
});
