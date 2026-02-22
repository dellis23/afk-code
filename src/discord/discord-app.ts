import { Client, GatewayIntentBits, Events, ChannelType, AttachmentBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { randomUUID } from 'crypto';
import { stat as fsStat } from 'fs/promises';
import { homedir } from 'os';
import type { DiscordConfig } from './types.js';
import { SessionManager, type SessionInfo, type ToolCallInfo, type ToolResultInfo } from '../slack/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { markdownToSlack, chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';

export const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

export function createDiscordApp(config: DiscordConfig) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelManager = new ChannelManager(client, config.userId);

  // Track messages sent from Discord to avoid re-posting
  const discordSentMessages = new Set<string>();

  // Track tool call messages for threading results
  const toolCallMessages = new Map<string, string>(); // toolUseId -> message id

  // Guard against concurrent spawn attempts on the same channel
  const spawningChannels = new Set<string>(); // channelId

  async function handleAutoSpawn(channelId: string, channelName: string, cwd: string, silent?: boolean): Promise<void> {
    // Validate path exists and is a directory
    try {
      const stats = await fsStat(cwd);
      if (!stats.isDirectory()) {
        if (!silent) {
          const discordChannel = await client.channels.fetch(channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(`\u26a0\ufe0f Path is not a directory: \`${cwd}\`. Update the topic to a valid directory path.`);
          }
        }
        return;
      }
    } catch {
      if (!silent) {
        const discordChannel = await client.channels.fetch(channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(`\u26a0\ufe0f Path does not exist: \`${cwd}\`. Update the topic to a valid directory path.`);
        }
      }
      return;
    }

    const sessionId = randomUUID().slice(0, 8);

    // Register the channel mapping before spawning
    channelManager.registerExternalChannel(sessionId, channelId, channelName, cwd);

    try {
      await sessionManager.spawnSession(sessionId, cwd);
    } catch (err: any) {
      console.error(`[Discord] Failed to spawn session for #${channelName}:`, err);
      const discordChannel = await client.channels.fetch(channelId);
      if (discordChannel?.type === ChannelType.GuildText) {
        await discordChannel.send(`\u274c Failed to spawn Claude session: ${err.message || err}`);
      }
      channelManager.unregisterChannel(sessionId);
    }
  }

  // Create session manager with event handlers that post to Discord
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const channel = await channelManager.createChannel(session.id, session.name, session.cwd);
      if (channel) {
        try {
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(
              `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\``
            );
          }
        } catch (err) {
          console.error(`[Discord] Error in onSessionStart:`, err);
        }
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateStatus(sessionId, 'ended');

        try {
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send('🛑 **Session ended** - this channel will be archived');
          }

          await channelManager.archiveChannel(sessionId);
        } catch (err: any) {
          // Channel may already be deleted (e.g. user deleted the channel,
          // which triggered the session kill that led us here).
          if (err?.code === 10003) {
            console.log(`[Discord] Channel already deleted for session ${sessionId}, skipping archive`);
          } else {
            console.error('[Discord] Error in onSessionEnd:', err);
          }
        }
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateName(sessionId, name);
        // Note: we no longer set the channel topic here because the topic
        // is reserved for the working directory path (used for auto-spawn).
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateStatus(sessionId, status);
      }
    },

    onMessage: async (sessionId, role, content) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        // Discord markdown is similar to Slack's mrkdwn but uses standard markdown
        const formatted = content; // Discord uses standard markdown

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
            const chunks = chunkMessage(formatted);
            for (const chunk of chunks) {
              await discordChannel.send(`**User:** ${chunk}`);
            }
          }
        } else {
          // Claude's response
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            const chunks = chunkMessage(formatted);
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
      }
    },

    onTodos: async (sessionId, todos) => {
      const channel = channelManager.getChannel(sessionId);
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
      const channel = channelManager.getChannel(sessionId);
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
          // Store the message id for threading results
          toolCallMessages.set(tool.id, message.id);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool call:', err);
      }
    },

    onToolResult: async (sessionId, result) => {
      const channel = channelManager.getChannel(sessionId);
      if (!channel) return;

      const parentMessageId = toolCallMessages.get(result.toolUseId);
      if (!parentMessageId) return; // No parent message to reply to

      // Truncate long results
      const maxLen = 1800; // Discord has 2000 char limit
      let content = result.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n... (truncated)';
      }

      const prefix = result.isError ? '❌ Error:' : '✅ Result:';
      const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          // Fetch the parent message and create a thread
          const parentMessage = await discordChannel.messages.fetch(parentMessageId);
          if (parentMessage) {
            // Create a thread if one doesn't exist, or use existing
            let thread = parentMessage.thread;
            if (!thread) {
              thread = await parentMessage.startThread({
                name: 'Result',
                autoArchiveDuration: 60,
              });
            }
            await thread.send(text);
          }

          // Clean up the mapping
          toolCallMessages.delete(result.toolUseId);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool result:', err);
      }
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const channel = channelManager.getChannel(sessionId);
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
  });

  // Handle messages in session channels (user sending input to Claude)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;

    // Ignore DMs
    if (!message.guild) return;

    // Only allow the configured user to send input
    if (message.author.id !== config.userId) return;

    const sessionId = channelManager.getSessionByChannel(message.channelId);
    if (!sessionId) return; // Not a session channel

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await message.reply('⚠️ This session has ended.');
      return;
    }

    console.log(`[Discord] Sending input to session ${sessionId}: ${message.content.slice(0, 50)}...`);

    // Track this message so we don't re-post it
    discordSentMessages.add(message.content.trim());

    const sent = sessionManager.sendInput(sessionId, message.content);
    if (!sent) {
      discordSentMessages.delete(message.content.trim());
      await message.reply('⚠️ Failed to send input - session not connected.');
    }
  });

  // When bot is ready
  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
    await channelManager.initialize();

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
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Only allow the configured user to use slash commands
    if (interaction.user.id !== config.userId) {
      await interaction.reply({ content: '\u26a0\ufe0f You are not authorized to use this command.', ephemeral: true });
      return;
    }

    const { commandName, channelId } = interaction;

    if (commandName === 'sessions') {
      const active = channelManager.getAllActive();
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
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      // Send the appropriate escape sequence
      let key: string;
      let message: string;
      if (commandName === 'background') {
        key = '\x02'; // Ctrl+B
        message = '⬇️ Sent background command (Ctrl+B)';
      } else if (commandName === 'interrupt') {
        key = '\x1b'; // Escape
        message = '🛑 Sent interrupt (Escape)';
      } else {
        key = '\x1b[Z'; // Shift+Tab
        message = '🔄 Sent mode toggle (Shift+Tab)';
      }

      const sent = sessionManager.sendInput(sessionId, key, true);
      if (sent) {
        await interaction.reply(message);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'compact') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      const sent = sessionManager.sendInput(sessionId, '/compact\n');
      if (sent) {
        await interaction.reply('🗜️ Sent /compact');
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'clear') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      // Reset the watched file so we pick up the new JSONL after /clear
      sessionManager.resetWatchedFile(sessionId);
      const sent = sessionManager.sendInput(sessionId, '/clear\n');
      if (sent) {
        await interaction.reply('🧹 Conversation cleared');
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'model') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      const modelArg = interaction.options.getString('name', true);
      if (!ALLOWED_MODELS.includes(modelArg.toLowerCase())) {
        await interaction.reply(`⚠️ Invalid model. Choose from: ${ALLOWED_MODELS.join(', ')}`);
        return;
      }
      const sent = sessionManager.sendInput(sessionId, `/model ${modelArg}\n`);
      if (sent) {
        await interaction.reply(`🧠 Sent /model ${modelArg}`);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }
  });

  // Auto-spawn: immediately spawn a session when a claude-* channel is created
  client.on(Events.ChannelCreate, async (channel) => {
    if (channel.type !== ChannelType.GuildText) return;
    if (!channel.name.startsWith('claude-')) return;

    // Guard against concurrent spawns
    if (spawningChannels.has(channel.id)) return;
    spawningChannels.add(channel.id);

    const home = homedir();
    console.log(`[Discord] Detected claude-* channel creation: #${channel.name}, spawning in ${home}`);
    await handleAutoSpawn(channel.id, channel.name, home);
    spawningChannels.delete(channel.id);
  });

  // Auto-spawn: when topic changes to a valid directory, kill existing session and respawn
  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (newChannel.type !== ChannelType.GuildText) return;
    if (!newChannel.name.startsWith('claude-')) return;

    const oldTopic = oldChannel.type === ChannelType.GuildText ? (oldChannel as TextChannel).topic : null;
    const newTopic = (newChannel as TextChannel).topic;

    // Only react to actual topic changes
    if (!newTopic || newTopic === oldTopic) return;

    const cwd = newTopic.trim();
    if (!cwd) return;

    // Only handle absolute paths — ignore non-path topics (e.g. session descriptions)
    if (!cwd.startsWith('/')) return;

    // Guard against concurrent spawns
    if (spawningChannels.has(newChannel.id)) return;
    spawningChannels.add(newChannel.id);

    // Kill existing session for this channel if any
    const existingSessionId = channelManager.getSessionByChannel(newChannel.id);
    if (existingSessionId) {
      console.log(`[Discord] Topic changed on #${newChannel.name}, killing session ${existingSessionId}`);
      channelManager.unregisterChannel(existingSessionId);
      sessionManager.killSession(existingSessionId);
      // Brief pause for cleanup
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Discord] Spawning new session for #${newChannel.name} in ${cwd}`);
    await handleAutoSpawn(newChannel.id, newChannel.name, cwd);
    spawningChannels.delete(newChannel.id);
  });

  // Auto-spawn: cleanup on channel delete
  client.on(Events.ChannelDelete, (channel) => {
    // If channel has an active session, unregister first then kill.
    // Unregistering before killing ensures onSessionEnd won't try to
    // fetch/message the already-deleted channel.
    const sessionId = channelManager.getSessionByChannel(channel.id);
    if (sessionId) {
      console.log(`[Discord] Channel deleted, killing session ${sessionId}`);
      channelManager.unregisterChannel(sessionId);
      sessionManager.killSession(sessionId);
    }
  });

  return { client, sessionManager, channelManager };
}
