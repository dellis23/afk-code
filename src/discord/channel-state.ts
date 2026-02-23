/**
 * Persistent channel state — survives bot restarts.
 * Stores the mapping from Discord channel ID to the Claude session UUID
 * (from the JSONL filename) so we can --resume the correct conversation.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.afk-code');
const STATE_FILE = join(STATE_DIR, 'discord-channels.json');

export interface ChannelState {
  channelId: string;
  channelName: string;
  cwd: string;
  claudeSessionId: string; // UUID from the JSONL filename
  sessionId?: string;      // internal 8-char ID (tmux name = afk-<sessionId>)
}

interface StateFile {
  channels: Record<string, ChannelState>; // keyed by channelId
}

export async function loadChannelState(): Promise<Map<string, ChannelState>> {
  try {
    const data = await readFile(STATE_FILE, 'utf-8');
    const parsed: StateFile = JSON.parse(data);
    return new Map(Object.entries(parsed.channels || {}));
  } catch {
    return new Map();
  }
}

export async function saveChannelState(channels: Map<string, ChannelState>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const data: StateFile = {
    channels: Object.fromEntries(channels),
  };
  await writeFile(STATE_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
