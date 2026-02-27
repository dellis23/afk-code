import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelStore } from '../channel-store.js';

describe('ChannelStore — state transitions', () => {
  let store: ChannelStore;

  beforeEach(() => {
    store = ChannelStore.create();
  });

  it('register creates a channel in spawning status', () => {
    const ch = store.register('chan-1', 'afk-test', '/tmp');
    expect(ch.status).toBe('spawning');
    expect(ch.channelId).toBe('chan-1');
    expect(ch.sessionId).toBeNull();
  });

  it('bindSession sets sessionId and transitions to running', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');
    const ch = store.get('chan-1');
    expect(ch?.sessionId).toBe('sess-1');
    expect(ch?.status).toBe('running');
  });

  it('getBySession finds channel via session index', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');
    const ch = store.getBySession('sess-1');
    expect(ch?.channelId).toBe('chan-1');
  });

  it('getBySession self-heals stale index entries', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');

    // Manually clear the sessionId to simulate stale state
    const ch = store.get('chan-1')!;
    ch.sessionId = null;

    // getBySession should detect mismatch and clean up
    const result = store.getBySession('sess-1');
    expect(result).toBeUndefined();
  });

  it('unbindSession clears sessionId and session index', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');
    store.unbindSession('chan-1');

    const ch = store.get('chan-1');
    expect(ch?.sessionId).toBeNull();
    expect(store.getBySession('sess-1')).toBeUndefined();
  });

  it('valid transitions succeed', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    // spawning → running
    expect(store.transition('chan-1', 'running')).toBe(true);
    // running → idle
    expect(store.transition('chan-1', 'idle')).toBe(true);
    // idle → archived
    expect(store.transition('chan-1', 'archived')).toBe(true);
    // archived → resuming
    expect(store.transition('chan-1', 'resuming')).toBe(true);
    // resuming → running
    expect(store.transition('chan-1', 'running')).toBe(true);
    // running → ended
    expect(store.transition('chan-1', 'ended')).toBe(true);
  });

  it('invalid transitions fail', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    // spawning → idle (not allowed)
    expect(store.transition('chan-1', 'idle')).toBe(false);
    expect(store.get('chan-1')?.status).toBe('spawning');

    // spawning → resuming (not allowed)
    expect(store.transition('chan-1', 'resuming')).toBe(false);

    // transition to running, then try ended → running (not allowed)
    store.transition('chan-1', 'running');
    store.transition('chan-1', 'ended');
    expect(store.transition('chan-1', 'running')).toBe(false);
    expect(store.get('chan-1')?.status).toBe('ended');
  });

  it('spawning → archived is valid (for restore path)', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    expect(store.transition('chan-1', 'archived')).toBe(true);
    expect(store.get('chan-1')?.status).toBe('archived');
  });

  it('remove deletes channel and cleans up session index', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');
    store.remove('chan-1');

    expect(store.get('chan-1')).toBeUndefined();
    expect(store.getBySession('sess-1')).toBeUndefined();
  });

  it('getAllActive excludes ended channels', () => {
    store.register('chan-1', 'afk-test-1', '/tmp');
    store.register('chan-2', 'afk-test-2', '/tmp');
    store.register('chan-3', 'afk-test-3', '/tmp');

    store.transition('chan-2', 'ended');

    const active = store.getAllActive();
    expect(active).toHaveLength(2);
    expect(active.map(c => c.channelId).sort()).toEqual(['chan-1', 'chan-3']);
  });
});

describe('ChannelStore — message queue', () => {
  let store: ChannelStore;

  beforeEach(() => {
    store = ChannelStore.create();
  });

  it('queueMessage and drainMessages work together', () => {
    store.register('chan-1', 'afk-test', '/tmp');
    store.queueMessage('chan-1', 'msg1');
    store.queueMessage('chan-1', 'msg2');

    const msgs = store.drainMessages('chan-1');
    expect(msgs).toEqual(['msg1', 'msg2']);

    // Drain again — should be empty
    expect(store.drainMessages('chan-1')).toEqual([]);
  });

  it('queueMessage on unknown channel is a no-op', () => {
    store.queueMessage('nonexistent', 'msg');
    expect(store.drainMessages('nonexistent')).toEqual([]);
  });
});

describe('ChannelStore — bindSession before spawnSession pattern', () => {
  it('pre-binding ensures onSessionStart finds the channel', async () => {
    const store = ChannelStore.create();

    // Simulate the correct flow:
    // 1. register channel
    store.register('chan-1', 'afk-test', '/tmp');
    // 2. bindSession BEFORE spawnSession
    store.bindSession('chan-1', 'sess-1');

    // 3. When onSessionStart fires, getBySession should find it
    const found = store.getBySession('sess-1');
    expect(found).toBeDefined();
    expect(found?.channelId).toBe('chan-1');
    expect(found?.status).toBe('running');
  });

  it('without pre-binding, onSessionStart cannot find the channel', async () => {
    const store = ChannelStore.create();

    // Simulate the OLD buggy flow:
    // 1. register channel
    store.register('chan-1', 'afk-test', '/tmp');
    // 2. spawnSession fires onSessionStart BEFORE bindSession

    // getBySession returns undefined — this was the bug
    const found = store.getBySession('sess-1');
    expect(found).toBeUndefined();
    // The old code would create a DUPLICATE channel here!
  });

  it('bindSession cleans up on spawn failure', async () => {
    const store = ChannelStore.create();

    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');

    // Simulate spawn failure
    store.unbindSession('chan-1');

    expect(store.get('chan-1')?.sessionId).toBeNull();
    expect(store.getBySession('sess-1')).toBeUndefined();
  });
});

describe('ChannelStore — setters', () => {
  it('setClaudeSessionId updates the UUID', async () => {
    const store = ChannelStore.create();
    store.register('chan-1', 'afk-test', '/tmp');
    store.setClaudeSessionId('chan-1', 'uuid-123');
    expect(store.get('chan-1')?.claudeSessionId).toBe('uuid-123');
  });

  it('setChannelName updates the name', async () => {
    const store = ChannelStore.create();
    store.register('chan-1', 'afk-test', '/tmp');
    store.setChannelName('chan-1', 'afk-test-archived');
    expect(store.get('chan-1')?.channelName).toBe('afk-test-archived');
  });
});

describe('ChannelStore — re-register existing channel', () => {
  it('re-registering updates name and cwd without resetting state', async () => {
    const store = ChannelStore.create();
    store.register('chan-1', 'afk-test', '/tmp');
    store.bindSession('chan-1', 'sess-1');

    // Re-register with new cwd
    const ch = store.register('chan-1', 'afk-test', '/home/user');
    expect(ch.cwd).toBe('/home/user');
    // Should keep existing session binding
    expect(ch.sessionId).toBe('sess-1');
    expect(ch.status).toBe('running');
  });
});
