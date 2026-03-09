/**
 * Unified channel state management for Discord (real and mock).
 * Single source of truth — replaces ChannelManager, channel-state persistence,
 * and ad-hoc guard sets (spawningChannels, respawningChannels, pendingMessages).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.afk-code');
const STATE_FILE = join(STATE_DIR, 'discord-channels.json');

export type ChannelStatus = 'spawning' | 'running' | 'idle' | 'archived' | 'resuming' | 'ended';

export interface Channel {
  channelId: string;        // primary key — stable across respawns
  channelName: string;
  cwd: string;
  sessionId: string | null;    // internal 8-char ID, null when archived/ended
  claudeSessionId: string;     // UUID from JSONL filename, for --resume
  status: ChannelStatus;
  pendingMessages: string[];   // queued messages during 'resuming'
}

/** Valid state transitions — enforced by transition() */
const TRANSITIONS: Record<ChannelStatus, Set<ChannelStatus>> = {
  spawning: new Set(['running', 'archived', 'ended']),
  running:  new Set(['idle', 'archived', 'ended']),
  idle:     new Set(['running', 'archived', 'ended']),
  archived: new Set(['resuming', 'ended']),
  resuming: new Set(['running', 'archived', 'ended']),
  ended:    new Set(['spawning']),
};

interface PersistedChannel {
  channelId: string;
  channelName: string;
  cwd: string;
  claudeSessionId: string;
  sessionId?: string;
  // New fields (backward-compatible — may be absent in old files)
  status?: ChannelStatus;
  pendingMessages?: string[];
}

interface StateFile {
  channels: Record<string, PersistedChannel>;
}

export class ChannelStore {
  private channels = new Map<string, Channel>();
  private sessionIndex = new Map<string, string>(); // sessionId → channelId
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {}

  /** Create an empty store (no disk load). Useful for tests. */
  static create(): ChannelStore {
    return new ChannelStore();
  }

  /** Load from ~/.afk-code/discord-channels.json, backward-compatible */
  static async load(): Promise<ChannelStore> {
    const store = new ChannelStore();
    try {
      const data = await readFile(STATE_FILE, 'utf-8');
      const parsed: StateFile = JSON.parse(data);
      for (const [id, entry] of Object.entries(parsed.channels || {})) {
        const channel: Channel = {
          channelId: entry.channelId || id,
          channelName: entry.channelName,
          cwd: entry.cwd,
          sessionId: entry.sessionId || null,
          claudeSessionId: entry.claudeSessionId || '',
          status: entry.status || 'idle',
          pendingMessages: entry.pendingMessages || [],
        };
        store.channels.set(channel.channelId, channel);
        if (channel.sessionId) {
          store.sessionIndex.set(channel.sessionId, channel.channelId);
        }
      }
      console.log(`[ChannelStore] Loaded ${store.channels.size} channel(s) from disk`);
    } catch {
      // No file or invalid — start empty
      console.log('[ChannelStore] No saved state found, starting fresh');
    }
    return store;
  }

  /** Direct lookup by channelId */
  get(channelId: string): Channel | undefined {
    return this.channels.get(channelId);
  }

  /** Lookup via sessionIndex, self-healing (verifies match, cleans stale entries) */
  getBySession(sessionId: string): Channel | undefined {
    const channelId = this.sessionIndex.get(sessionId);
    if (!channelId) return undefined;

    const channel = this.channels.get(channelId);
    if (!channel || channel.sessionId !== sessionId) {
      // Stale index entry — clean it up
      this.sessionIndex.delete(sessionId);
      return undefined;
    }
    return channel;
  }

  /** All channels including ended */
  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** All channels excluding 'ended' */
  getAllActive(): Channel[] {
    return Array.from(this.channels.values()).filter(c => c.status !== 'ended');
  }

  /** Creates a channel with status='spawning', persists */
  register(channelId: string, channelName: string, cwd: string): Channel {
    const existing = this.channels.get(channelId);
    if (existing) {
      // Update name/cwd if re-registering
      existing.channelName = channelName;
      existing.cwd = cwd;
      this.schedulePersist();
      return existing;
    }

    const channel: Channel = {
      channelId,
      channelName,
      cwd,
      sessionId: null,
      claudeSessionId: '',
      status: 'spawning',
      pendingMessages: [],
    };
    this.channels.set(channelId, channel);
    this.schedulePersist();
    console.log(`[ChannelStore] Registered #${channelName} (${channelId}) status=spawning`);
    return channel;
  }

  /** Sets sessionId, updates sessionIndex, transitions to 'running', persists */
  bindSession(channelId: string, sessionId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) {
      console.warn(`[ChannelStore] bindSession: unknown channel ${channelId}`);
      return;
    }

    // Clean up old session index entry if any
    if (channel.sessionId && channel.sessionId !== sessionId) {
      this.sessionIndex.delete(channel.sessionId);
    }

    channel.sessionId = sessionId;
    this.sessionIndex.set(sessionId, channelId);
    channel.status = 'running';
    this.schedulePersist();
    console.log(`[ChannelStore] Bound session ${sessionId} to #${channel.channelName}, status=running`);
  }

  /** Clears sessionId + sessionIndex entry, persists */
  unbindSession(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    if (channel.sessionId) {
      this.sessionIndex.delete(channel.sessionId);
      channel.sessionId = null;
      this.schedulePersist();
    }
  }

  /** Validates against transition map, logs warning if invalid, returns success, persists */
  transition(channelId: string, to: ChannelStatus): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) {
      console.warn(`[ChannelStore] transition: unknown channel ${channelId}`);
      return false;
    }

    const allowed = TRANSITIONS[channel.status];
    if (!allowed.has(to)) {
      console.warn(`[ChannelStore] Invalid transition: ${channel.status} → ${to} for #${channel.channelName}`);
      return false;
    }

    const from = channel.status;
    channel.status = to;
    this.schedulePersist();
    console.log(`[ChannelStore] #${channel.channelName}: ${from} → ${to}`);
    return true;
  }

  /** Force status without transition validation — test only */
  forceStatus(channelId: string, status: ChannelStatus): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.status = status;
    this.schedulePersist();
  }

  /** Updates claudeSessionId (UUID from JSONL), persists */
  setClaudeSessionId(channelId: string, id: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.claudeSessionId = id;
    this.schedulePersist();
  }

  /** Updates channel name, persists */
  setChannelName(channelId: string, name: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.channelName = name;
    this.schedulePersist();
  }

  /** Pushes a message to pendingMessages queue */
  queueMessage(channelId: string, msg: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.pendingMessages.push(msg);
  }

  /** Returns and clears pendingMessages */
  drainMessages(channelId: string): string[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    const msgs = channel.pendingMessages.splice(0);
    return msgs;
  }

  /** Unbinds session, deletes from map, persists */
  remove(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      if (channel.sessionId) {
        this.sessionIndex.delete(channel.sessionId);
      }
      this.channels.delete(channelId);
      this.schedulePersist();
      console.log(`[ChannelStore] Removed #${channel.channelName} (${channelId})`);
    }
  }

  /** Debounced disk write (100ms) */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow().catch(err => {
        console.error('[ChannelStore] Failed to persist:', err);
      });
    }, 100);
  }

  private async persistNow(): Promise<void> {
    const channels: Record<string, PersistedChannel> = {};
    for (const [id, ch] of this.channels) {
      channels[id] = {
        channelId: ch.channelId,
        channelName: ch.channelName,
        cwd: ch.cwd,
        claudeSessionId: ch.claudeSessionId,
        ...(ch.sessionId ? { sessionId: ch.sessionId } : {}),
        status: ch.status,
        pendingMessages: ch.pendingMessages.length > 0 ? ch.pendingMessages : undefined,
      };
    }
    await mkdir(STATE_DIR, { recursive: true });
    const data: StateFile = { channels };
    await writeFile(STATE_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
}
