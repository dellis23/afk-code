import { Client, GatewayIntentBits, Events, ChannelType, AttachmentBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { TextChannel, CategoryChannel, Guild } from 'discord.js';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { stat as fsStat, mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { DiscordConfig } from './types.js';
import { SessionManager, type SessionInfo, type ToolCallInfo, type ToolResultInfo } from '../slack/session-manager.js';
import { ChannelStore } from './channel-store.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';

export const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

/**
 * Sanitize a string for use as a Discord channel name.
 */
function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

/**
 * Find (or create) the guild + category for AFK Code channels.
 * Extracted from old ChannelManager.initialize().
 */
async function initializeGuild(client: Client, userId: string): Promise<{ guild: Guild; category: CategoryChannel }> {
  const guilds = await client.guilds.fetch();
  if (guilds.size === 0) {
    throw new Error('Bot is not in any servers. Please invite the bot first.');
  }

  const guildId = guilds.first()!.id;
  const guild = await client.guilds.fetch(guildId);

  const existingCategory = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'afk code sessions'
  ) as CategoryChannel | undefined;

  const category = existingCategory || await guild.channels.create({
    name: 'AFK Code Sessions',
    type: ChannelType.GuildCategory,
  });

  console.log(`[Discord] Using guild: ${guild.name}`);
  console.log(`[Discord] Using category: ${category.name}`);
  return { guild, category };
}

/**
 * Create a Discord text channel for a CLI-started session.
 * Extracted from old ChannelManager.createChannel().
 */
async function createDiscordChannel(
  guild: Guild,
  category: CategoryChannel,
  userId: string,
  client: Client,
  session: SessionInfo
): Promise<TextChannel | null> {
  const folderName = session.cwd.split('/').filter(Boolean).pop() || 'session';
  const baseName = `afk-${sanitizeChannelName(folderName)}`;

  let channelName = baseName;
  let suffix = 1;

  while (true) {
    const nameToTry = channelName.length > 100 ? channelName.slice(0, 100) : channelName;
    const existing = guild.channels.cache.find(
      (ch) => ch.name === nameToTry && ch.parentId === category.id
    );

    if (!existing) {
      try {
        const channel = await guild.channels.create({
          name: nameToTry,
          type: ChannelType.GuildText,
          parent: category,
          topic: `Claude Code session: ${session.name}`,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
            { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            ...(client.user ? [{ id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }] : []),
          ],
        });
        console.log(`[Discord] Created channel #${nameToTry} for session ${session.id}`);
        return channel as TextChannel;
      } catch (err: any) {
        console.error('[Discord] Failed to create channel:', err.message);
        return null;
      }
    } else {
      suffix++;
      channelName = `${baseName}-${suffix}`;
    }
  }
}

export function createDiscordApp(config: DiscordConfig) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Unified channel state — replaces ChannelManager + persistedChannels + guard sets
  let store: ChannelStore;

  // Guild/category for Discord API operations
  let guild: Guild | null = null;
  let category: CategoryChannel | null = null;

  // Track messages sent from Discord to avoid re-posting
  const discordSentMessages = new Set<string>();
  // Channels being checked for early exit — suppress onSessionEnd archiving
  const suppressArchive = new Set<string>();

  // Track tool call messages for threading results
  const toolCallMessages = new Map<string, string>(); // toolUseId -> message id

  async function handleAutoSpawn(channelId: string, cwd: string, options?: { silent?: boolean; resumeSessionId?: string }): Promise<string | undefined> {
    const ch = store.get(channelId);
    const channelName = ch?.channelName || channelId;

    // Validate path exists and is a directory
    try {
      const stats = await fsStat(cwd);
      if (!stats.isDirectory()) {
        if (!options?.silent) {
          const discordChannel = await client.channels.fetch(channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(`\u26a0\ufe0f Path is not a directory: \`${cwd}\`. Update the topic to a valid directory path.`);
          }
        }
        return undefined;
      }
    } catch {
      if (!options?.silent) {
        const discordChannel = await client.channels.fetch(channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(`\u26a0\ufe0f Path does not exist: \`${cwd}\`. Update the topic to a valid directory path.`);
        }
      }
      return undefined;
    }

    const sessionId = randomUUID().slice(0, 8);

    // Bind BEFORE spawning so onSessionStart can find the channel.
    // spawnSession triggers onSessionStart synchronously during the await,
    // and if the mapping isn't set yet, onSessionStart creates a duplicate channel.
    store.bindSession(channelId, sessionId);

    try {
      await sessionManager.spawnSession(sessionId, cwd, { resumeSessionId: options?.resumeSessionId });

      // When resuming, check if Claude exited immediately (bad session ID).
      // This avoids silently failing — the caller can retry without --resume.
      if (options?.resumeSessionId) {
        suppressArchive.add(channelId);
        const alive = await sessionManager.checkAlive(sessionId);
        suppressArchive.delete(channelId);
        if (!alive) {
          console.log(`[Discord] Session ${sessionId} for #${channelName} exited immediately (likely bad --resume)`);
          store.unbindSession(channelId);
          return undefined;
        }
      }

      return sessionId;
    } catch (err: any) {
      console.error(`[Discord] Failed to spawn session for #${channelName}:`, err);
      store.unbindSession(channelId);
      if (!options?.silent) {
        const discordChannel = await client.channels.fetch(channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(`\u274c Failed to spawn Claude session: ${err.message || err}`);
        }
      }
      return undefined;
    }
  }

  // Create session manager with event handlers that post to Discord
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const existing = store?.getBySession(session.id);
      if (existing) {
        // Auto-spawn: channel already exists, just post "started" message
        try {
          const discordChannel = await client.channels.fetch(existing.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(
              `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\``
            );
          }
        } catch (err) {
          console.error(`[Discord] Error in onSessionStart:`, err);
        }
      } else if (guild && category) {
        // CLI session: create Discord channel, register, bind
        const discordChannel = await createDiscordChannel(guild, category, config.userId, client, session);
        if (discordChannel) {
          store.register(discordChannel.id, discordChannel.name, session.cwd);
          store.bindSession(discordChannel.id, session.id);
          try {
            await discordChannel.send(
              `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\``
            );
          } catch (err) {
            console.error(`[Discord] Error in onSessionStart:`, err);
          }
        }
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;
      if (channel.status !== 'running' && channel.status !== 'idle') return;

      // If this channel is being checked for early exit (resume failure),
      // just clean up state silently — the caller will handle retry
      if (suppressArchive.has(channel.channelId)) {
        store.transition(channel.channelId, 'ended');
        store.unbindSession(channel.channelId);
        return;
      }

      store.transition(channel.channelId, 'ended');
      store.unbindSession(channel.channelId);

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send('🛑 **Session ended** - this channel will be archived');

          // Rename with archived suffix
          const timestamp = Date.now().toString(36);
          const archivedName = `${channel.channelName}-archived-${timestamp}`.slice(0, 100);
          await discordChannel.setName(archivedName);
          store.setChannelName(channel.channelId, archivedName);
        }
      } catch (err: any) {
        if (err?.code === 10003) {
          console.log(`[Discord] Channel already deleted for session ${sessionId}, skipping archive`);
        } else {
          console.error('[Discord] Error in onSessionEnd:', err);
        }
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      // Note: we no longer set the channel topic here because the topic
      // is reserved for the working directory path (used for auto-spawn).
    },

    onSessionStatus: async (sessionId, status) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;
      if (channel.status !== 'running' && channel.status !== 'idle') return;
      store.transition(channel.channelId, status);
    },

    onMessage: async (sessionId, role, content) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;
      if (channel.status !== 'running' && channel.status !== 'idle') return;

      // Persist the Claude session UUID once it's known (or update if changed after /clear)
      const claudeId = sessionManager.getClaudeSessionId(sessionId);
      if (claudeId && channel.claudeSessionId !== claudeId) {
        store.setClaudeSessionId(channel.channelId, claudeId);
        console.log(`[Discord] Persisted channel state: #${channel.channelName} → Claude session ${claudeId} (internal: ${sessionId})`);
      }

      // Discord markdown is similar to Slack's mrkdwn but uses standard markdown
      const formatted = content;

      if (role === 'user') {
        // Skip messages that originated from Discord
        const contentKey = content.trim();
        if (discordSentMessages.has(contentKey)) {
          discordSentMessages.delete(contentKey);
          return;
        }

        // User message from terminal
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          const chunks = chunkMessage(formatted, 1900);
          for (const chunk of chunks) {
            await discordChannel.send(`**User:** ${chunk}`);
          }
        }
      } else {
        // Claude's response
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          const chunks = chunkMessage(formatted, 2000);
          for (const chunk of chunks) {
            await discordChannel.send(chunk);
          }

          // Extract and upload any images mentioned in the response
          const session = sessionManager.getSession(sessionId);
          const images = extractImagePaths(content, session?.cwd);
          for (const image of images) {
            try {
              console.log(`[Discord] Uploading image: ${image.resolvedPath}`);
              const attachment = new AttachmentBuilder(image.resolvedPath);
              await discordChannel.send({
                content: `📎 ${image.originalPath}`,
                files: [attachment],
              });
            } catch (err) {
              console.error('[Discord] Failed to upload image:', err);
            }
          }
        }
      }
    },

    onTodos: async (sessionId, todos) => {
      const channel = store?.getBySession(sessionId);
      if (channel && todos.length > 0) {
        const todosText = formatTodos(todos);
        try {
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(`**Tasks:**\n${todosText}`);
          }
        } catch (err) {
          console.error('[Discord] Failed to post todos:', err);
        }
      }
    },

    onToolCall: async (sessionId, tool) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      // Format tool call summary
      let inputSummary = '';
      if (tool.name === 'Bash' && tool.input.command) {
        inputSummary = `\`${tool.input.command.slice(0, 100)}${tool.input.command.length > 100 ? '...' : ''}\``;
      } else if (tool.name === 'Read' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Edit' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Write' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Grep' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Glob' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Task' && tool.input.description) {
        inputSummary = tool.input.description;
      }

      const text = inputSummary
        ? `🔧 **${tool.name}**: ${inputSummary}`
        : `🔧 **${tool.name}**`;

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          const message = await discordChannel.send(text);
          toolCallMessages.set(tool.id, message.id);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool call:', err);
      }
    },

    onToolResult: async (sessionId, result) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      const parentMessageId = toolCallMessages.get(result.toolUseId);
      if (!parentMessageId) return;

      const maxLen = 1800;
      let content = result.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n... (truncated)';
      }

      const prefix = result.isError ? '❌ Error:' : '✅ Result:';
      const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          const parentMessage = await discordChannel.messages.fetch(parentMessageId);
          if (parentMessage) {
            let thread = parentMessage.thread;
            if (!thread) {
              thread = await parentMessage.startThread({
                name: 'Result',
                autoArchiveDuration: 60,
              });
            }
            await thread.send(text);
          }
          toolCallMessages.delete(result.toolUseId);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool result:', err);
      }
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      const emoji = inPlanMode ? '📋' : '🔨';
      const status = inPlanMode ? 'Planning mode - Claude is designing a solution' : 'Execution mode - Claude is implementing';

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(`${emoji} ${status}`);
        }
      } catch (err) {
        console.error('[Discord] Failed to post plan mode change:', err);
      }
    },

    onAskUserQuestion: async (sessionId, questions) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      let text = '❓ **Claude is asking:**\n\n';
      for (const q of questions) {
        if (q.header) text += `**${q.header}:** `;
        text += `${q.question}\n`;
        if (q.options?.length) {
          for (const opt of q.options) {
            text += `> • **${opt.label}**`;
            if (opt.description) text += ` — ${opt.description}`;
            text += '\n';
          }
        }
        text += '\n';
      }
      text += '_Reply here to answer — Claude will re-ask as plain text._';

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(text);
        }
      } catch (err) {
        console.error('[Discord] Failed to post AskUserQuestion:', err);
      }
    },
  });

  // Download a Discord attachment to ~/.afk-code/attachments/ and return the local path
  const ATTACHMENTS_DIR = join(homedir(), '.afk-code', 'attachments');
  async function downloadAttachment(url: string, filename: string): Promise<string> {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    const prefix = randomUUID().slice(0, 8);
    const localName = `${prefix}-${filename}`;
    const localPath = join(ATTACHMENTS_DIR, localName);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);
    return localPath;
  }

  // Handle messages in session channels (user sending input to Claude)
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.author.id !== config.userId) return;

    const channel = store?.get(message.channelId);
    if (!channel) return; // Not a session channel

    try {

    // Build full message content (with attachments)
    let fullContent = message.content;
    if (message.attachments.size > 0) {
      const savedPaths: string[] = [];
      for (const [, attachment] of message.attachments) {
        try {
          const localPath = await downloadAttachment(attachment.url, attachment.name);
          savedPaths.push(localPath);
          console.log(`[Discord] Saved attachment: ${attachment.name} → ${localPath}`);
        } catch (err) {
          console.error(`[Discord] Failed to download attachment ${attachment.name}:`, err);
          await message.reply(`⚠️ Failed to download attachment: ${attachment.name}`);
        }
      }
      if (savedPaths.length > 0) {
        fullContent += '\nAttachment(s):\n' + savedPaths.join('\n');
      }
    }

    // Re-spawn archived or ended sessions on message
    if (channel.status === 'archived' || channel.status === 'ended') {
      store.queueMessage(message.channelId, fullContent);

      // If already resuming, just queue and return
      const current = store.get(message.channelId);
      if (current?.status === 'resuming') return;

      store.transition(message.channelId, 'resuming');
      await message.reply('🔄 **Resuming session...**');

      const cleanChannelName = channel.channelName.replace(/-archived$/, '');
      store.unbindSession(message.channelId);

      let newSessionId = await handleAutoSpawn(message.channelId, channel.cwd, { resumeSessionId: channel.claudeSessionId || undefined });

      // If resume failed (e.g. session no longer exists), retry without --resume
      if (!newSessionId && channel.claudeSessionId) {
        console.log(`[Discord] Resume failed for #${channel.channelName}, retrying with fresh session`);
        newSessionId = await handleAutoSpawn(message.channelId, channel.cwd);
      }

      if (newSessionId) {
        // Rename Discord channel back to active
        try {
          const discordChannel = await client.channels.fetch(message.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.setName(cleanChannelName);
          }
        } catch (err) {
          console.error(`[Discord] Failed to rename channel back to active:`, err);
        }
        store.setChannelName(message.channelId, cleanChannelName);

        // Wait for Claude to be ready
        await sessionManager.waitForReady(newSessionId);
        await new Promise(r => setTimeout(r, 1000));

        // Flush pending messages
        const queued = store.drainMessages(message.channelId);
        for (const msg of queued) {
          discordSentMessages.add(msg.trim());
          sessionManager.sendInput(newSessionId, msg);
          await new Promise(r => setTimeout(r, 200));
        }
      } else {
        store.transition(message.channelId, 'archived'); // revert
        store.drainMessages(message.channelId); // discard
      }
      return;
    }

    if (!channel.sessionId) {
      await message.reply('⚠️ No active session in this channel.');
      return;
    }

    console.log(`[Discord] Sending input to session ${channel.sessionId}: ${fullContent.slice(0, 50)}...`);

    discordSentMessages.add(fullContent.trim());

    const sent = sessionManager.sendInput(channel.sessionId, fullContent);
    if (!sent) {
      discordSentMessages.delete(fullContent.trim());
      await message.reply('⚠️ Failed to send input - session not connected.');
    }
    } catch (err) {
      console.error(`[Discord] Error handling message in #${channel.channelName}:`, err);
    }
  });

  // When bot is ready
  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);

    store = await ChannelStore.load();
    const guildInfo = await initializeGuild(client, config.userId);
    guild = guildInfo.guild;
    category = guildInfo.category;

    // Register slash commands
    const commands = [
      new SlashCommandBuilder()
        .setName('background')
        .setDescription('Send Claude to background mode (Ctrl+B)'),
      new SlashCommandBuilder()
        .setName('interrupt')
        .setDescription('Interrupt Claude (Escape)'),
      new SlashCommandBuilder()
        .setName('mode')
        .setDescription('Toggle Claude mode (Shift+Tab)'),
      new SlashCommandBuilder()
        .setName('sessions')
        .setDescription('List active Claude Code sessions'),
      new SlashCommandBuilder()
        .setName('compact')
        .setDescription('Compact the conversation (/compact)'),
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear conversation and start fresh (/clear)'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch Claude model')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Model name (opus, sonnet, haiku)')
            .setRequired(true)),
      new SlashCommandBuilder()
        .setName('context')
        .setDescription('Show context window usage for this session'),
      new SlashCommandBuilder()
        .setName('tmux')
        .setDescription('Get tmux attach command for this session'),
      new SlashCommandBuilder()
        .setName('screenshot')
        .setDescription('Capture current tmux pane content'),
      new SlashCommandBuilder()
        .setName('archive')
        .setDescription('Archive session — kill Claude but keep the channel for later'),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(config.botToken);
      await rest.put(Routes.applicationCommands(c.user.id), {
        body: commands.map((cmd) => cmd.toJSON()),
      });
      console.log('[Discord] Slash commands registered');
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err);
    }

    // Restore sessions for existing afk-* channels (with tmux orphan recovery)
    try {
      // Discover running tmux sessions so we can re-attach instead of spawning duplicates
      const runningTmuxSessions = new Set<string>();
      try {
        const tmuxOutput = execSync("tmux ls -F '#{session_name}'", { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        for (const line of tmuxOutput.trim().split('\n')) {
          const name = line.trim();
          if (name.startsWith('afk-')) {
            runningTmuxSessions.add(name.slice(4));
          }
        }
        console.log(`[Discord] Found ${runningTmuxSessions.size} running afk-* tmux session(s)`);
      } catch {
        console.log('[Discord] No running tmux sessions found');
      }

      const claimedTmuxSessions = new Set<string>();

      const allChannels = await guild.channels.fetch();
      for (const [, ch] of allChannels) {
        if (!ch || ch.type !== ChannelType.GuildText) continue;

        const saved = store.get(ch.id);

        // Restore any channel tracked by ID in the store, plus auto-discover
        // new afk-* channels. Channel name/prefix doesn't matter for tracked channels.
        if (!saved && !ch.name.startsWith('afk-')) continue;

        // Determine cwd from topic or saved state or $HOME
        const topic = (ch as TextChannel).topic?.trim();
        const cwd = (topic && topic.startsWith('/')) ? topic : (saved?.cwd || homedir());

        // Archived channels: register but don't spawn
        if (ch.name.endsWith('-archived') || saved?.status === 'archived') {
          if (!saved) {
            store.register(ch.id, ch.name, cwd);
            store.transition(ch.id, 'archived');
          }
          console.log(`[Discord] Registered archived channel #${ch.name} (no session spawned)`);
          continue;
        }

        // Has live tmux session? Re-attach
        if (saved?.sessionId && runningTmuxSessions.has(saved.sessionId)) {
          console.log(`[Discord] Re-attaching to existing tmux session afk-${saved.sessionId} for #${ch.name} in ${cwd}`);
          claimedTmuxSessions.add(saved.sessionId);

          if (!saved) store.register(ch.id, ch.name, cwd);
          try {
            await sessionManager.attachSession(saved.sessionId, cwd);
            store.bindSession(ch.id, saved.sessionId);
            try {
              await (ch as TextChannel).send(`🔄 **Session re-attached** — bot restarted, reconnected to existing tmux session in \`${cwd}\``);
            } catch (err) {
              console.error(`[Discord] Failed to post re-attach message in #${ch.name}:`, err);
            }
          } catch (err) {
            console.error(`[Discord] Failed to attach to tmux session afk-${saved.sessionId}:`, err);
            // Fall through to normal spawn below
            const resumeSessionId = saved?.claudeSessionId;
            console.log(`[Discord] Falling back to spawn for #${ch.name} in ${cwd}`);
            if (!store.get(ch.id)) store.register(ch.id, ch.name, cwd);
            let newSessionId = await handleAutoSpawn(ch.id, cwd, { silent: true, resumeSessionId: resumeSessionId || undefined });
            if (!newSessionId && resumeSessionId) {
              console.log(`[Discord] Resume failed for #${ch.name}, retrying with fresh session`);
              newSessionId = await handleAutoSpawn(ch.id, cwd, { silent: true });
            }
            if (newSessionId) {
              try {
                await (ch as TextChannel).send(`🔄 **Session restored** — bot restarted, conversation resumed in \`${cwd}\``);
              } catch (err) {
                console.error(`[Discord] Failed to post restore message in #${ch.name}:`, err);
              }
            } else {
              store.transition(ch.id, 'ended');
            }
          }
          continue;
        }

        // No live tmux — spawn fresh
        if (!saved) store.register(ch.id, ch.name, cwd);
        else if (saved.status === 'ended') {
          // Reset status so we can re-spawn on restart
          store.transition(ch.id, 'spawning');
        }
        const resumeSessionId = saved?.claudeSessionId;

        if (resumeSessionId) {
          console.log(`[Discord] Restoring session for #${ch.name} in ${cwd} (resuming Claude session ${resumeSessionId})`);
        } else {
          console.log(`[Discord] Restoring session for #${ch.name} in ${cwd} (fresh — no saved session)`);
        }

        let newSessionId = await handleAutoSpawn(ch.id, cwd, { silent: true, resumeSessionId: resumeSessionId || undefined });

        // If resume failed (e.g. session no longer exists), retry without --resume
        if (!newSessionId && resumeSessionId) {
          console.log(`[Discord] Resume failed for #${ch.name}, retrying with fresh session`);
          newSessionId = await handleAutoSpawn(ch.id, cwd, { silent: true });
        }

        if (newSessionId) {
          const msg = resumeSessionId
            ? `🔄 **Session restored** — bot restarted, conversation resumed in \`${cwd}\``
            : `🔄 **Session restored** — bot restarted, new session spawned in \`${cwd}\``;
          try {
            await (ch as TextChannel).send(msg);
          } catch (err) {
            console.error(`[Discord] Failed to post restore message in #${ch.name}:`, err);
          }
        } else {
          store.transition(ch.id, 'ended');
        }
      }

      // Kill orphaned tmux sessions that weren't claimed by any channel
      for (const tmuxSessionId of runningTmuxSessions) {
        if (!claimedTmuxSessions.has(tmuxSessionId)) {
          console.log(`[Discord] Killing orphaned tmux session: afk-${tmuxSessionId}`);
          try {
            execSync(`tmux kill-session -t afk-${tmuxSessionId}`, { stdio: 'ignore' });
          } catch {}
        }
      }
    } catch (err) {
      console.error('[Discord] Failed to restore sessions:', err);
    }
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
    if (interaction.user.id !== config.userId) {
      await interaction.reply({ content: '\u26a0\ufe0f You are not authorized to use this command.', ephemeral: true });
      return;
    }

    const { commandName, channelId } = interaction;

    if (commandName === 'sessions') {
      const active = store.getAllActive();
      if (active.length === 0) {
        await interaction.reply('No active sessions. Start a session with `afk-code run -- claude`');
        return;
      }

      const text = active
        .map((c) => `<#${c.channelId}> - ${formatSessionStatus(c.status)}`)
        .join('\n');

      await interaction.reply(`**Active Sessions:**\n${text}`);
      return;
    }

    if (commandName === 'background' || commandName === 'interrupt' || commandName === 'mode') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }
      if (channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended. Send a message to resume.');
        return;
      }

      let key: string;
      let message: string;
      if (commandName === 'background') {
        key = '\x02';
        message = '⬇️ Sent background command (Ctrl+B)';
      } else if (commandName === 'interrupt') {
        key = '\x1b';
        message = '🛑 Sent interrupt (Escape)';
      } else {
        key = '\x1b[Z';
        message = '🔄 Sent mode toggle (Shift+Tab)';
      }

      const sent = sessionManager.sendInput(channel.sessionId, key, true);
      if (sent) {
        await interaction.reply(message);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'compact') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }
      if (channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended. Send a message to resume.');
        return;
      }

      const sent = sessionManager.sendInput(channel.sessionId, '/compact\n');
      if (sent) {
        await interaction.reply('🗜️ Sent /compact');
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'clear') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }
      if (channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended. Send a message to resume.');
        return;
      }

      await sessionManager.resetWatchedFile(channel.sessionId);
      const sent = sessionManager.sendInput(channel.sessionId, '/clear\n');
      if (sent) {
        await interaction.reply('🧹 Conversation cleared');
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'model') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }
      if (channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended. Send a message to resume.');
        return;
      }

      const modelArg = interaction.options.getString('name', true);
      if (!ALLOWED_MODELS.includes(modelArg.toLowerCase())) {
        await interaction.reply(`⚠️ Invalid model. Choose from: ${ALLOWED_MODELS.join(', ')}`);
        return;
      }
      const sent = sessionManager.sendInput(channel.sessionId, `/model ${modelArg}\n`);
      if (sent) {
        await interaction.reply(`🧠 Sent /model ${modelArg}`);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'context') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ No active session in this channel.');
        return;
      }

      const usage = await sessionManager.getContextUsage(channel.sessionId);
      if (!usage) {
        await interaction.reply('⚠️ No usage data yet — session may still be starting.');
        return;
      }

      const pct = ((usage.totalTokens / usage.contextLimit) * 100).toFixed(1);
      const usedK = Math.round(usage.totalTokens / 1000);
      const limitK = usage.contextLimit / 1000;
      await interaction.reply(`📊 **Context:** ${usedK}k / ${limitK}k tokens (${pct}%)`);
    }

    if (commandName === 'tmux') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ No active session in this channel.');
        return;
      }

      await interaction.reply(`\`\`\`\ntmux attach -t afk-${channel.sessionId}\n\`\`\``);
    }

    if (commandName === 'screenshot') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ No active session in this channel.');
        return;
      }

      try {
        const paneText = sessionManager.capturePane(channel.sessionId);
        const attachment = new AttachmentBuilder(Buffer.from(paneText, 'utf-8'), { name: 'screenshot.txt' });
        await interaction.reply({ files: [attachment] });
      } catch {
        await interaction.reply('⚠️ Failed to capture tmux pane.');
      }
    }

    if (commandName === 'archive') {
      const channel = store.get(channelId);
      if (!channel?.sessionId) {
        await interaction.reply('⚠️ No active session in this channel.');
        return;
      }
      if (channel.status === 'archived') {
        await interaction.reply('⚠️ This session is already archived.');
        return;
      }
      if (channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended. Send a message to resume.');
        return;
      }

      const sessionIdToKill = channel.sessionId;
      store.transition(channelId, 'archived');
      store.unbindSession(channelId);

      // Rename Discord channel
      const archivedName = `${channel.channelName}-archived`.slice(0, 100);
      try {
        const discordChannel = await client.channels.fetch(channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.setName(archivedName);
        }
      } catch (err) {
        console.error('[Discord] Failed to rename channel archived:', err);
      }
      store.setChannelName(channelId, archivedName);

      await interaction.reply('📦 **Session archived.** Send a message here to resume.');
      sessionManager.killSession(sessionIdToKill);
    }
    } catch (err) {
      console.error(`[Discord] Error handling /${interaction.commandName}:`, err);
    }
  });

  // Auto-spawn: immediately spawn a session when an afk-* channel is created
  client.on(Events.ChannelCreate, async (channel) => {
    if (channel.type !== ChannelType.GuildText) return;
    if (!channel.name.startsWith('afk-')) return;

    // Already tracked (e.g. from restore loop)
    if (store.get(channel.id)) return;

    const home = homedir();
    console.log(`[Discord] Detected afk-* channel creation: #${channel.name}, spawning in ${home}`);
    store.register(channel.id, channel.name, home);
    const newSessionId = await handleAutoSpawn(channel.id, home);
    if (!newSessionId) store.transition(channel.id, 'ended');
  });

  // Auto-spawn: when topic changes to a valid directory, kill existing session and respawn
  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (newChannel.type !== ChannelType.GuildText) return;

    // React to topic changes on any tracked channel (by ID), or new afk-* channels
    if (!store.get(newChannel.id) && !newChannel.name.startsWith('afk-')) return;

    const oldTopic = oldChannel.type === ChannelType.GuildText ? (oldChannel as TextChannel).topic : null;
    const newTopic = (newChannel as TextChannel).topic;

    // Only react to actual topic changes — ignore renames
    if (!newTopic || newTopic === oldTopic) return;
    const oldName = oldChannel.type === ChannelType.GuildText ? (oldChannel as TextChannel).name : null;
    if (oldName !== (newChannel as TextChannel).name) return;

    const cwd = newTopic.trim();
    if (!cwd || !cwd.startsWith('/')) return;

    const existing = store.get(newChannel.id);
    if (existing && existing.status !== 'running' && existing.status !== 'idle') return;

    // Kill existing session for this channel if any
    if (existing?.sessionId) {
      console.log(`[Discord] Topic changed on #${newChannel.name}, killing session ${existing.sessionId}`);
      const oldSessionId = existing.sessionId;
      store.remove(newChannel.id);
      sessionManager.killSession(oldSessionId);
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Discord] Spawning new session for #${newChannel.name} in ${cwd}`);
    store.register(newChannel.id, newChannel.name, cwd);
    const newSessionId = await handleAutoSpawn(newChannel.id, cwd);
    if (!newSessionId) store.transition(newChannel.id, 'ended');
  });

  // Auto-spawn: cleanup on channel delete
  client.on(Events.ChannelDelete, async (channel) => {
    const existing = store.get(channel.id);
    if (existing?.sessionId) {
      const sid = existing.sessionId;
      store.remove(channel.id);
      console.log(`[Discord] Channel deleted, killing session ${sid}`);
      sessionManager.killSession(sid);
    } else {
      store.remove(channel.id);
    }
  });

  return { client, sessionManager };
}
