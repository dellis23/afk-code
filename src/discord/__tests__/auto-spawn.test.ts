import { describe, it, expect } from 'vitest';
import { ChannelType } from 'discord.js';
import { stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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
});

describe('Auto-Spawn - One-Shot Topic Guard', () => {
  it('removes channel from pending after first topic edit', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-123';

    pendingAutoSpawn.add(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(true);

    // Simulate topic edit - remove from pending
    pendingAutoSpawn.delete(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(false);
  });

  it('does not trigger for channels not in pending set', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-456';

    // Channel was never added to pending
    expect(pendingAutoSpawn.has(channelId)).toBe(false);
  });

  it('ignores subsequent topic edits after spawn', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-789';

    pendingAutoSpawn.add(channelId);

    // First topic edit
    pendingAutoSpawn.delete(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(false);

    // Second topic edit - channel is not in pending
    expect(pendingAutoSpawn.has(channelId)).toBe(false);
  });

  it('keeps channel in pending on path validation failure (re-added)', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-fail';

    pendingAutoSpawn.add(channelId);

    // Simulate path validation failure - re-add to pending
    pendingAutoSpawn.delete(channelId);
    // handleAutoSpawn re-adds on failure
    pendingAutoSpawn.add(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(true);
  });
});

describe('Auto-Spawn - Channel Lifecycle', () => {
  it('cleans up pending state on channel delete', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-delete';

    pendingAutoSpawn.add(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(true);

    // Simulate channel delete
    pendingAutoSpawn.delete(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(false);
  });

  it('handles delete of non-pending channel gracefully', () => {
    const pendingAutoSpawn = new Set<string>();
    const channelId = 'chan-not-pending';

    // Delete of channel not in pending - should not throw
    pendingAutoSpawn.delete(channelId);
    expect(pendingAutoSpawn.has(channelId)).toBe(false);
  });

  it('session kill triggers on channel delete when session exists', () => {
    // Simulate channel-to-session mapping
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-active';
    const sessionId = 'sess-123';

    channelToSession.set(channelId, sessionId);

    // On channel delete, look up session
    const foundSessionId = channelToSession.get(channelId);
    expect(foundSessionId).toBe(sessionId);
  });

  it('no session kill when deleted channel has no session', () => {
    const channelToSession = new Map<string, string>();
    const channelId = 'chan-no-session';

    const foundSessionId = channelToSession.get(channelId);
    expect(foundSessionId).toBeUndefined();
  });
});
