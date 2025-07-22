const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const playdl = require('play-dl');
require('dotenv').config();
const { Client: PgClient } = require('pg');
const fetch = require('node-fetch'); // Add at the top if not already

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences // <-- Add this line
    ]
});

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

// PostgreSQL connection
const pgClient = new PgClient({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 10000,
    ssl: {
        rejectUnauthorized: false // Required for AWS RDS
    }
});

pgClient.connect()
    .then(() => console.log("✅ Connected to PostgreSQL DB"))
    .catch(err => console.error("❌ DB Connection Error:", err));

let queue = {};

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    client.user.setPresence({
        activities: [{ name: 'Music😼', type: ActivityType.Streaming, url: 'https://twitch.tv/smoothlikemeow' }],
        status: 'Streaming'
    });

    // Create autorole table if not exists
    await pgClient.query(`CREATE TABLE IF NOT EXISTS autorole (
        guild_id VARCHAR(32) PRIMARY KEY,
        role_id VARCHAR(32),
        enabled BOOLEAN DEFAULT true
    )`);

    // Create welcome_dm table if not exists
    await pgClient.query(`CREATE TABLE IF NOT EXISTS welcome_dm (
        guild_id VARCHAR(32) PRIMARY KEY,
        enabled BOOLEAN DEFAULT true
    )`);

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_invites (
        user_id VARCHAR(32) PRIMARY KEY,
        invited_by VARCHAR(32)
    )`);

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_messages (
        user_id VARCHAR(32) PRIMARY KEY,
        count INT DEFAULT 0
    )`);

    // Create afk_users table if not exists
    await pgClient.query(`CREATE TABLE IF NOT EXISTS afk_users (
        user_id VARCHAR(32) PRIMARY KEY,
        reason TEXT DEFAULT 'AFK',
        timestamp BIGINT,
        is_permanent BOOLEAN DEFAULT false
    )`);

    // Create afk_ignore_roles table if not exists
    await pgClient.query(`CREATE TABLE IF NOT EXISTS afk_ignore_roles (
        guild_id VARCHAR(32),
        role_id VARCHAR(32),
        PRIMARY KEY (guild_id, role_id)
    )`);

    // Create afk_ignore_users table if not exists
    await pgClient.query(`CREATE TABLE IF NOT EXISTS afk_ignore_users (
        guild_id VARCHAR(32),
        user_id VARCHAR(32),
        PRIMARY KEY (guild_id, user_id)
    )`);

    const commands = [
        new SlashCommandBuilder().setName('play').setDescription('Plays a song from YouTube').addStringOption(option => option.setName('query').setDescription('The YouTube URL').setRequired(true)),
        new SlashCommandBuilder().setName('skip').setDescription('Skips the current song'),
        new SlashCommandBuilder().setName('stop').setDescription('Stops the music and clears the queue'),
        new SlashCommandBuilder().setName('pause').setDescription('Pauses the current song'),
        new SlashCommandBuilder().setName('resume').setDescription('Resumes the paused song'),
        new SlashCommandBuilder().setName('queue').setDescription('Displays the current song queue'),
        new SlashCommandBuilder().setName('giverole').setDescription('Gives a role to a user')
            .addUserOption(option => option.setName('user').setDescription('User to give role').setRequired(true))
            .addRoleOption(option => option.setName('role').setDescription('Role to give').setRequired(true)),
        new SlashCommandBuilder().setName('removerole').setDescription('Removes a role from a user')
            .addUserOption(option => option.setName('user').setDescription('User to remove role from').setRequired(true))
            .addRoleOption(option => option.setName('role').setDescription('Role to remove').setRequired(true)),
        new SlashCommandBuilder().setName('say').setDescription('Send a message as the bot')
            .addStringOption(option => option.setName('message').setDescription('The message to send').setRequired(true))
            .addChannelOption(option => option.setName('channel').setDescription('Channel to send the message in (optional)'))
            .addStringOption(option => option.setName('mention').setDescription('Mention @everyone, @here, or a role ID (optional)').setRequired(false))
            .addStringOption(option => option.setName('reply_to').setDescription('Message ID to reply to (optional)').setRequired(false)),
        new SlashCommandBuilder().setName('setautorole').setDescription('Set auto role for new members')
            .addRoleOption(option => option.setName('role').setDescription('Role to auto assign').setRequired(true)),
        new SlashCommandBuilder().setName('toggleautorole').setDescription('Enable or disable auto role')
            .addBooleanOption(option => option.setName('enabled').setDescription('True to enable, false to disable').setRequired(true)),
        new SlashCommandBuilder().setName('togglewelcomedm').setDescription('Enable or disable welcome DM')
            .addBooleanOption(option => option.setName('enabled').setDescription('True to enable, false to disable').setRequired(true)),
        new SlashCommandBuilder()
            .setName('userinfo')
            .setDescription('Show user and server details')
            .addUserOption(option => option.setName('user').setDescription('User to show info for').setRequired(false)),
        new SlashCommandBuilder()
            .setName('sendvoice')
            .setDescription('Send a voice file as the bot')
            .addAttachmentOption(option => option.setName('file').setDescription('Audio file to send').setRequired(true))
            .addChannelOption(option => option.setName('channel').setDescription('Channel to send the voice file (optional)')),
        new SlashCommandBuilder()
            .setName('steal')
            .setDescription('Steal an emoji or sticker')
            .addStringOption(option => option.setName('item').setDescription('Emoji or sticker to steal').setRequired(true))
            .addStringOption(option => option.setName('name').setDescription('Name for the new emoji/sticker').setRequired(false)),
        new SlashCommandBuilder()
            .setName('avatar')
            .setDescription('Display user\'s avatar')
            .addUserOption(option => option.setName('user').setDescription('User to show avatar for').setRequired(false))
            .addIntegerOption(option => 
                option.setName('size')
                    .setDescription('Avatar size')
                    .setRequired(false)
                    .addChoices(
                        { name: '64x64', value: 64 },
                        { name: '128x128', value: 128 },
                        { name: '256x256', value: 256 },
                        { name: '512x512', value: 512 },
                        { name: '1024x1024', value: 1024 },
                        { name: '2048x2048', value: 2048 }
                    )
            ),
        new SlashCommandBuilder()
            .setName('afk')
            .setDescription('Set your AFK status')
            .addStringOption(option => option.setName('reason').setDescription('Reason for being AFK').setRequired(false))
            .addBooleanOption(option => option.setName('permanent').setDescription('Set permanent AFK (Admin only)').setRequired(false))
            .addRoleOption(option => option.setName('ignore_role').setDescription('Role to ignore AFK messages (Admin only)').setRequired(false))
            .addUserOption(option => option.setName('ignore_user').setDescription('User to ignore AFK messages (Admin only)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('unafk')
            .setDescription('Remove your AFK status'),
        new SlashCommandBuilder()
            .setName('afkignore')
            .setDescription('Manage AFK ignore list for roles and users')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('add-role')
                    .setDescription('Add a role to AFK ignore list')
                    .addRoleOption(option => option.setName('role').setDescription('Role to add').setRequired(true))
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('remove-role')
                    .setDescription('Remove a role from AFK ignore list')
                    .addRoleOption(option => option.setName('role').setDescription('Role to remove').setRequired(true))
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('add-user')
                    .setDescription('Add a user to AFK ignore list')
                    .addUserOption(option => option.setName('user').setDescription('User to add').setRequired(true))
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('remove-user')
                    .setDescription('Remove a user from AFK ignore list')
                    .addUserOption(option => option.setName('user').setDescription('User to remove').setRequired(true))
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('list')
                    .setDescription('List all AFK ignore roles and users')
            ),
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
        console.log('🔁 Registering slash commands...');
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('✅ Slash commands registered successfully.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }

    global.inviteCache = {};
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            invites.forEach(inv => global.inviteCache[inv.code] = inv.uses);
        } catch {}
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

client.on('guildMemberAdd', async (member) => {
    const guildId = member.guild.id;
    // Get autorole settings from DB
    const result = await pgClient.query('SELECT * FROM autorole WHERE guild_id = $1', [guildId]);
    const settings = result.rows[0];

    if (settings?.enabled && settings.role_id) {
        const role = member.guild.roles.cache.get(settings.role_id);
        if (role) {
            try {
                await member.roles.add(role);
                console.log(`✅ Auto role assigned to ${member.user.tag}`);
            } catch (err) {
                console.error(`❌ Failed to assign role: ${err}`);
            }
        }
    }

    // Check if welcome DM is enabled for this guild (from database)
    let welcomeDMEnabled = true;
    try {
        const result = await pgClient.query('SELECT enabled FROM welcome_dm WHERE guild_id = $1', [guildId]);
        if (result.rows.length > 0) welcomeDMEnabled = !!result.rows[0].enabled;
    } catch (err) {
        console.error('❌ Error checking welcome DM toggle:', err);
    }

    if (welcomeDMEnabled) {
        try {
            await sleep(1500); // Add a 1.5 second delay before sending DM
            const invite1 = "https://discord.gg/sMGvW9BCPG";
            const invite2 = "https://discord.gg/MDbyaMxp5j";
            await member.send(`👋 Welcome to ${member.guild.name}!\nHere's the server invite link: ${invite1}\n\nHere's another server : ${invite2}`);
            console.log(`✅ Sent welcome DM to ${member.user.tag}`);
        } catch (err) {
            if (err.code === 50007) {
                console.log(`❌ Cannot DM ${member.user.tag}.`);
            } else if (err.code === 40003) {
                console.log(`❌ Rate limited: DM not sent to ${member.user.tag}.`);
            } else {
                console.error('❌ DM error:', err);
            }
        }
    }

    // Invite tracking
    try {
        const invites = await member.guild.invites.fetch();
        const usedInvite = invites.find(inv => inv.uses > (global.inviteCache?.[inv.code] || 0));
        if (!global.inviteCache) global.inviteCache = {};
        invites.forEach(inv => global.inviteCache[inv.code] = inv.uses);

        if (usedInvite && usedInvite.inviter) {
            await pgClient.query(
                'INSERT INTO user_invites (user_id, invited_by) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET invited_by = EXCLUDED.invited_by',
                [member.id, usedInvite.inviter.id]
            );
        }
    } catch (err) {
        console.error('❌ Invite tracking error:', err);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild, member } = interaction;

    if (commandName === 'say') {
        await interaction.deferReply({ flags: 1 << 6 }); // ephemeral

        if (!member.permissions.has('Administrator')) {
            return await interaction.editReply('❌ Only admins can use this command.');
        }

        const message = options.getString('message');
        const channel = options.getChannel('channel') || interaction.channel;
        const mention = options.getString('mention');
        const replyTo = options.getString('reply_to');

        if (!channel.isTextBased()) {
            return await interaction.editReply('❌ The selected channel is not a text channel.');
        }

        let content = message;
        if (mention === '@everyone' || mention === '@here') {
            content = `${mention}\n\n${message}`;
        } else if (mention && /^\d+$/.test(mention)) {
            // If a role ID is provided, mention the role
            content = `<@&${mention}>\n\n${message}`;
        }

        try {
            if (replyTo) {
                const msg = await channel.messages.fetch(replyTo).catch(() => null);
                if (msg) {
                    await msg.reply({ content });
                } else {
                    await channel.send({ content });
                }
            } else {
                await channel.send({ content });
            }
            await interaction.editReply(`Message sent in ${channel}`);
        } catch (error) {
            console.error('❌ Failed to send message:', error);
            await interaction.editReply('Failed to send message.');
        }
        return;
    }

    // Handle togglewelcomedm command
    if (commandName === 'togglewelcomedm') {
        try {
            // Use flags for ephemeral (avoids deprecation warning)
            await interaction.deferReply({ flags: 1 << 6 });
            if (!member.permissions.has('Administrator')) {
                return await interaction.editReply('Only admins can use this command.');
            }
            const enabled = options.getBoolean('enabled');
            await pgClient.query(
                'INSERT INTO welcome_dm (guild_id, enabled) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET enabled = EXCLUDED.enabled',
                [guild.id, enabled]
            );
            await interaction.editReply(`✅ Welcome DM is now ${enabled ? 'enabled' : 'disabled'} for this server.`);
        } catch (err) {
            console.error('❌ Database error in togglewelcomedm:', err);
            // Only try to reply if not already replied/deferred
            if (interaction.deferred || interaction.replied) {
                try { await interaction.editReply('❌ Database connection error. Please check your PostgreSQL connection.'); } catch {}
            }
        }
        return;
    }

    try {
        if (commandName === 'play') {
            await interaction.deferReply();
            const url = options.getString('query');

            if (!playdl.yt_validate(url)) {
                return await interaction.editReply('Invalid YouTube URL.');
            }

            if (!queue[guild.id]) {
                queue[guild.id] = {
                    songs: [],
                    connection: null,
                    player: createAudioPlayer()
                };

                queue[guild.id].player.on(AudioPlayerStatus.Idle, () => {
                    if (!queue[guild.id] || !queue[guild.id].songs) return; // Prevent undefined error
                    queue[guild.id].songs.shift();
                    if (queue[guild.id].songs.length > 0) {
                        playMusic(guild);
                    } else {
                        if (queue[guild.id].connection) queue[guild.id].connection.destroy();
                        delete queue[guild.id];
                    }
                });

                queue[guild.id].player.on('error', error => {
                    console.error('Audio player error:', error);
                    if (!queue[guild.id] || !queue[guild.id].songs) return; // Prevent undefined error
                    queue[guild.id].songs.shift();
                    if (queue[guild.id].songs.length > 0) {
                        playMusic(guild);
                    } else {
                        if (queue[guild.id].connection) queue[guild.id].connection.destroy();
                        delete queue[guild.id];
                    }
                });
            }

            queue[guild.id].songs.push({ url });
            await interaction.editReply(`🎶 Added to queue: ${url}`);

            if (!queue[guild.id].connection) {
                const channel = member.voice.channel;
                if (!channel) return await interaction.editReply('Join a voice channel first.');

                const connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator
                });

                queue[guild.id].connection = connection;
                connection.subscribe(queue[guild.id].player);
                playMusic(guild);
            }
        }

        if (commandName === 'skip') {
            await interaction.deferReply();
            if (queue[guild.id]?.player) {
                queue[guild.id].player.stop();
                await interaction.editReply('⏩ Skipped the song.');
            } else {
                await interaction.editReply('No song is currently playing.');
            }
        }

        if (commandName === 'stop') {
            await interaction.deferReply();
            if (queue[guild.id]) {
                queue[guild.id].connection.destroy();
                delete queue[guild.id];
                await interaction.editReply('🛑 Stopped and cleared queue.');
            } else {
                await interaction.editReply('❌ Nothing is playing.');
            }
        }

        if (commandName === 'pause') {
            await interaction.deferReply();
            if (queue[guild.id]?.player) {
                queue[guild.id].player.pause();
                await interaction.editReply('⏸️ Paused.');
            } else {
                await interaction.editReply('❌ Nothing to pause.');
            }
        }

        if (commandName === 'resume') {
            await interaction.deferReply();
            if (queue[guild.id]?.player) {
                queue[guild.id].player.unpause();
                await interaction.editReply('▶️ Resumed.');
            } else {
                await interaction.editReply('❌ Nothing to resume.');
            }
        }

        if (commandName === 'queue') {
            await interaction.deferReply();
            const list = queue[guild.id]?.songs?.map((s, i) => `${i + 1}. ${s.url}`).join('\n');
            await interaction.editReply(list ? `🎵 Queue:\n${list}` : '❌ Queue is empty.');
        }

        if (["giverole", "removerole"].includes(commandName)) {
            await interaction.deferReply();
            if (!member.permissions.has('Administrator') && !member.permissions.has('ManageRoles')) {
                return await interaction.editReply('❌ You need proper permissions.');
            }

            const targetUser = options.getUser('user');
            const role = options.getRole('role');
            const targetMember = guild.members.cache.get(targetUser.id);

            if (!targetMember) return await interaction.editReply('❌ Member not found.');
            if (role.position >= guild.members.me.roles.highest.position) {
                return await interaction.editReply('❌ Role is above bot\'s highest role.');
            }

            const hasRole = targetMember.roles.cache.has(role.id);
            if (commandName === 'giverole') {
                if (hasRole) return await interaction.editReply(`${targetUser.username} already has ${role.name}.`);
                await targetMember.roles.add(role);
                return await interaction.editReply(`✅ Given ${role.name} to ${targetUser.username}.`);
            } else {
                if (!hasRole) return await interaction.editReply(`${targetUser.username} doesn’t have ${role.name}.`);
                await targetMember.roles.remove(role);
                return await interaction.editReply(`✅ Removed ${role.name} from ${targetUser.username}.`);
            }
        }

        if (commandName === 'setautorole') {
            await interaction.deferReply();
            if (!member.permissions.has('Administrator')) {
                return await interaction.editReply('❌ Only admins can use this command.');
            }
            const role = options.getRole('role');
            await pgClient.query('INSERT INTO autorole (guild_id, role_id, enabled) VALUES ($1, $2, true) ON CONFLICT (guild_id) DO UPDATE SET role_id = EXCLUDED.role_id', [guild.id, role.id]);
            await interaction.editReply(`✅ Auto role set to ${role.name} for this server.`);
        }

        if (commandName === 'toggleautorole') {
            await interaction.deferReply();
            if (!member.permissions.has('Administrator')) {
                return await interaction.editReply('❌ Only admins can use this command.');
            }
            const enabled = options.getBoolean('enabled');
            try {
                await pgClient.query('INSERT INTO autorole (guild_id, enabled) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET enabled = EXCLUDED.enabled', [guild.id, enabled]);
                await interaction.editReply(`✅ Auto role is now ${enabled ? 'enabled' : 'disabled'} for this server.`);
            } catch (error) {
                console.error('❌ Database error in toggleautorole:', error);
                await interaction.editReply('❌ Database error occurred. Please check the connection.');
            }
        }

        if (commandName === 'userinfo') {
            await interaction.deferReply({ flags: 1 << 6 }); // ephemeral

            const targetUser = options.getUser('user') || interaction.user;
            await targetUser.fetch();
            const member = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);

            // Account age (created date)
            const accAge = `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`;
            // Join date
            const joinDate = member && member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'Unknown';
            // Status
            const status = member && member.presence ? member.presence.status : 'offline';
            let statusText = 'Offline';
            if (status === 'online') statusText = 'Online';
            else if (status === 'idle') statusText = 'Idle';
            else if (status === 'dnd') statusText = 'Do Not Disturb';

            // Custom status
            let customStatus = 'None';
            let activityText = 'None';
            if (member && member.presence && member.presence.activities.length > 0) {
                // Find custom status
                const custom = member.presence.activities.find(a => a.type === 4 && a.state);
                if (custom && custom.state) customStatus = custom.state;

                // Find first non-custom activity (game, listening, etc.)
                const nonCustom = member.presence.activities.find(a => a.type !== 4 && a.name);
                if (nonCustom && nonCustom.name) {
                    activityText = nonCustom.name;
                } else if (custom) {
                    activityText = 'Custom Status';
                }
            }

            // Name
            const name = `${targetUser.tag} (${targetUser.id})`;

            // Invited by (now from database)
            let invitedBy = 'Unknown';
            try {
                const inviteResult = await pgClient.query('SELECT invited_by FROM user_invites WHERE user_id = $1', [targetUser.id]);
                if (inviteResult.rows.length > 0 && inviteResult.rows[0].invited_by) {
                    const inviter = await client.users.fetch(inviteResult.rows[0].invited_by).catch(() => null);
                    invitedBy = inviter ? `${inviter.tag}` : inviteResult.rows[0].invited_by;
                }
            } catch {}

            // Total messages (now from database)
            let totalMessages = 'N/A';
            try {
                const msgResult = await pgClient.query('SELECT count FROM user_messages WHERE user_id = $1', [targetUser.id]);
                if (msgResult.rows.length > 0) totalMessages = msgResult.rows[0].count.toString();
            } catch {}

            // Send as plain text only (no embed)
            let info = `**User Info for ${name}**\n`;
            info += `Account Created: ${accAge}\n`;
            info += `Server Joined: ${joinDate}\n`;
            info += `Status: ${statusText}\n`;
            info += `Custom Status: ${customStatus}\n`;
            info += `Activity: ${activityText}\n`;
            info += `Invited By: ${invitedBy}\n`;
            info += `Total Messages: ${totalMessages}`;

            await interaction.editReply({ content: info });
            return;
        }

        if (commandName === 'sendvoice') {
            await interaction.deferReply({ flags: 1 << 6 }); // ephemeral

            if (!member.permissions.has('Administrator')) {
                return await interaction.editReply('❌ Only admins can use this command.');
            }

            const file = options.getAttachment('file');
            const channel = options.getChannel('channel') || interaction.channel;

            if (!channel.isTextBased()) {
                return await interaction.editReply('❌ The selected channel is not a text channel.');
            }

            try {
                await channel.send({ files: [file.url] });
                await interaction.editReply(`✅ Voice file sent in ${channel}`);
            } catch (error) {
                console.error('❌ Failed to send voice file:', error);
                await interaction.editReply('❌ Failed to send voice file.');
            }
            return;
        }

        if (commandName === 'steal') {
            await interaction.deferReply({ flags: 1 << 6 }); // ephemeral

            if (!member.permissions.has('ManageEmojisAndStickers')) {
                return await interaction.editReply('❌ You need Manage Emojis and Stickers permission.');
            }

            const item = options.getString('item');
            const name = options.getString('name') || 'stolen';

            // Try to steal emoji
            const emojiMatch = item.match(/<a?:\w+:(\d+)>/);
            if (emojiMatch) {
                const emojiId = emojiMatch[1];
                const ext = item.startsWith('<a:') ? 'gif' : 'png';
                const url = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}`;
                try {
                    const added = await guild.emojis.create({ attachment: url, name });
                    return await interaction.editReply(`✅ Emoji added: ${added.toString()}`);
                } catch (err) {
                    return await interaction.editReply('❌ Failed to add emoji.');
                }
            }

            // Try to steal sticker
            const stickerMatch = item.match(/sticker:(\d+)/i);
            if (stickerMatch) {
                const stickerId = stickerMatch[1];
                try {
                    const sticker = await client.fetchSticker(stickerId);
                    const added = await guild.stickers.create(sticker.url, name, sticker.format_type === 1 ? 'png' : 'apng');
                    return await interaction.editReply(`✅ Sticker added: ${added.name}`);
                } catch (err) {
                    return await interaction.editReply('❌ Failed to add sticker.');
                }
            }

            return await interaction.editReply('❌ Please provide a valid emoji or sticker.');
        }

        if (commandName === 'avatar') {
            await interaction.deferReply();

            const targetUser = options.getUser('user') || interaction.user;
            const size = options.getInteger('size') || 1024;
            
            try {
                // Fetch the user to get the latest data
                await targetUser.fetch();
                const member = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);

                // Get avatar URLs
                const globalAvatar = targetUser.displayAvatarURL({ 
                    dynamic: true, 
                    size: size,
                    format: targetUser.avatar && targetUser.avatar.startsWith('a_') ? 'gif' : 'png'
                });

                const serverAvatar = member && member.avatar ? 
                    member.displayAvatarURL({ 
                        dynamic: true, 
                        size: size,
                        format: member.avatar.startsWith('a_') ? 'gif' : 'png'
                    }) : null;

                // Create response message
                let response = `**${targetUser.tag}'s Avatar**\n\n`;
                
                if (serverAvatar && serverAvatar !== globalAvatar) {
                    response += `**Server Avatar:**\n${serverAvatar}\n\n`;
                    response += `**Global Avatar:**\n${globalAvatar}\n\n`;
                } else {
                    response += `**Avatar:**\n${globalAvatar}\n\n`;
                }

                // Add download links for different sizes
                response += `**Download Links:**\n`;
                const sizes = [64, 128, 256, 512, 1024, 2048];
                const downloadLinks = sizes.map(s => {
                    const url = targetUser.displayAvatarURL({ dynamic: true, size: s });
                    return `[${s}x${s}](${url})`;
                }).join(' • ');
                response += downloadLinks;

                // Add format info
                const isAnimated = targetUser.avatar && targetUser.avatar.startsWith('a_');
                if (isAnimated) {
                    response += `\n\n*This avatar is animated (GIF format)*`;
                }

                await interaction.editReply({
                    content: response,
                    files: [{ attachment: globalAvatar, name: `${targetUser.username}_avatar.${isAnimated ? 'gif' : 'png'}` }]
                });

            } catch (error) {
                console.error('❌ Avatar command error:', error);
                await interaction.editReply('❌ Failed to fetch avatar. Please try again.');
            }
            return;
        }

        if (commandName === 'afk') {
            await interaction.deferReply();
            
            const reason = options.getString('reason') || 'AFK';
            const userId = interaction.user.id;
            const timestamp = Date.now();
            const requestedPermanent = options.getBoolean('permanent') || false;
            const ignoreRole = options.getRole('ignore_role');
            const ignoreUser = options.getUser('ignore_user');
            
            // Check if user can set permanent AFK (admin only)
            let isPermanent = false;
            if (requestedPermanent) {
                if (member.permissions.has('Administrator')) {
                    isPermanent = true;
                } else {
                    return await interaction.editReply('❌ Only administrators can set permanent AFK status.');
                }
            }
            
            // Handle ignore role (admin only)
            if (ignoreRole) {
                if (!member.permissions.has('Administrator')) {
                    return await interaction.editReply('❌ Only administrators can set AFK ignore roles.');
                }
                
                try {
                    // Check if role already exists
                    const existing = await pgClient.query('SELECT * FROM afk_ignore_roles WHERE guild_id = $1 AND role_id = $2', [guild.id, ignoreRole.id]);
                    
                    if (existing.rows.length === 0) {
                        await pgClient.query('INSERT INTO afk_ignore_roles (guild_id, role_id) VALUES ($1, $2)', [guild.id, ignoreRole.id]);
                    }
                } catch (error) {
                    console.error('❌ AFK ignore role error:', error);
                }
            }
            
            // Handle ignore user (admin only)
            if (ignoreUser) {
                if (!member.permissions.has('Administrator')) {
                    return await interaction.editReply('❌ Only administrators can set AFK ignore users.');
                }
                
                try {
                    // Check if user already exists
                    const existing = await pgClient.query('SELECT * FROM afk_ignore_users WHERE guild_id = $1 AND user_id = $2', [guild.id, ignoreUser.id]);
                    
                    if (existing.rows.length === 0) {
                        await pgClient.query('INSERT INTO afk_ignore_users (guild_id, user_id) VALUES ($1, $2)', [guild.id, ignoreUser.id]);
                    }
                } catch (error) {
                    console.error('❌ AFK ignore user error:', error);
                }
            }
            
            try {
                await pgClient.query(
                    'INSERT INTO afk_users (user_id, reason, timestamp, is_permanent) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, timestamp = EXCLUDED.timestamp, is_permanent = EXCLUDED.is_permanent',
                    [userId, reason, timestamp, isPermanent]
                );
                
                let afkMessage = isPermanent 
                    ? `💤 **${interaction.user.username}** is now AFK: ${reason}\n*🔒 Permanent AFK - will only be removed when you use /unafk*`
                    : `💤 **${interaction.user.username}** is now AFK: ${reason}`;
                
                if (ignoreRole) {
                    afkMessage += `\n*Added **${ignoreRole.name}** to AFK ignore list*`;
                }
                
                if (ignoreUser) {
                    afkMessage += `\n*Added **${ignoreUser.username}** to AFK ignore list*`;
                }
                    
                await interaction.editReply(afkMessage);
                console.log(`✅ ${interaction.user.tag} set AFK: ${reason} (Permanent: ${isPermanent})`);
            } catch (error) {
                console.error('❌ AFK command error:', error);
                await interaction.editReply('❌ Failed to set AFK status. Please try again.');
            }
            return;
        }

        if (commandName === 'unafk') {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            
            try {
                const result = await pgClient.query('SELECT * FROM afk_users WHERE user_id = $1', [userId]);
                
                if (result.rows.length === 0) {
                    return await interaction.editReply('❌ You are not currently AFK.');
                }
                
                await pgClient.query('DELETE FROM afk_users WHERE user_id = $1', [userId]);
                
                await interaction.editReply(`✅ **${interaction.user.username}** is no longer AFK. Welcome back!`);
                console.log(`✅ ${interaction.user.tag} removed AFK status`);
            } catch (error) {
                console.error('❌ UnAFK command error:', error);
                await interaction.editReply('❌ Failed to remove AFK status. Please try again.');
            }
            return;
        }

        if (commandName === 'afkignore') {
            await interaction.deferReply({ flags: 1 << 6 }); // ephemeral
            
            if (!member.permissions.has('Administrator')) {
                return await interaction.editReply('❌ Only administrators can manage AFK ignore list.');
            }
            
            const subcommand = options.getSubcommand();
            
            try {
                if (subcommand === 'add-role') {
                    const role = options.getRole('role');
                    
                    // Check if role already exists
                    const existing = await pgClient.query('SELECT * FROM afk_ignore_roles WHERE guild_id = $1 AND role_id = $2', [guild.id, role.id]);
                    
                    if (existing.rows.length > 0) {
                        return await interaction.editReply(`❌ Role **${role.name}** is already in the AFK ignore list.`);
                    }
                    
                    await pgClient.query('INSERT INTO afk_ignore_roles (guild_id, role_id) VALUES ($1, $2)', [guild.id, role.id]);
                    await interaction.editReply(`✅ Added **${role.name}** to AFK ignore list. Users with this role won't see AFK messages when they ping AFK users.`);
                    
                } else if (subcommand === 'remove-role') {
                    const role = options.getRole('role');
                    
                    const result = await pgClient.query('DELETE FROM afk_ignore_roles WHERE guild_id = $1 AND role_id = $2', [guild.id, role.id]);
                    
                    if (result.rowCount === 0) {
                        return await interaction.editReply(`❌ Role **${role.name}** is not in the AFK ignore list.`);
                    }
                    
                    await interaction.editReply(`✅ Removed **${role.name}** from AFK ignore list.`);
                    
                } else if (subcommand === 'add-user') {
                    const user = options.getUser('user');
                    
                    // Check if user already exists
                    const existing = await pgClient.query('SELECT * FROM afk_ignore_users WHERE guild_id = $1 AND user_id = $2', [guild.id, user.id]);
                    
                    if (existing.rows.length > 0) {
                        return await interaction.editReply(`❌ User **${user.username}** is already in the AFK ignore list.`);
                    }
                    
                    await pgClient.query('INSERT INTO afk_ignore_users (guild_id, user_id) VALUES ($1, $2)', [guild.id, user.id]);
                    await interaction.editReply(`✅ Added **${user.username}** to AFK ignore list. This user won't see AFK messages when they ping AFK users.`);
                    
                } else if (subcommand === 'remove-user') {
                    const user = options.getUser('user');
                    
                    const result = await pgClient.query('DELETE FROM afk_ignore_users WHERE guild_id = $1 AND user_id = $2', [guild.id, user.id]);
                    
                    if (result.rowCount === 0) {
                        return await interaction.editReply(`❌ User **${user.username}** is not in the AFK ignore list.`);
                    }
                    
                    await interaction.editReply(`✅ Removed **${user.username}** from AFK ignore list.`);
                    
                } else if (subcommand === 'list') {
                    const rolesResult = await pgClient.query('SELECT role_id FROM afk_ignore_roles WHERE guild_id = $1', [guild.id]);
                    const usersResult = await pgClient.query('SELECT user_id FROM afk_ignore_users WHERE guild_id = $1', [guild.id]);
                    
                    if (rolesResult.rows.length === 0 && usersResult.rows.length === 0) {
                        return await interaction.editReply('📋 No roles or users are currently in the AFK ignore list.');
                    }
                    
                    let list = '📋 **AFK Ignore List:**\n\n';
                    
                    if (rolesResult.rows.length > 0) {
                        list += '**Roles:**\n';
                        for (const row of rolesResult.rows) {
                            const role = guild.roles.cache.get(row.role_id);
                            if (role) {
                                list += `• ${role.name}\n`;
                            } else {
                                list += `• <Deleted Role: ${row.role_id}>\n`;
                            }
                        }
                        list += '\n';
                    }
                    
                    if (usersResult.rows.length > 0) {
                        list += '**Users:**\n';
                        for (const row of usersResult.rows) {
                            try {
                                const user = await client.users.fetch(row.user_id);
                                list += `• ${user.username}\n`;
                            } catch {
                                list += `• <Unknown User: ${row.user_id}>\n`;
                            }
                        }
                    }
                    
                    await interaction.editReply(list);
                }
            } catch (error) {
                console.error('❌ AFK ignore command error:', error);
                await interaction.editReply('❌ Failed to manage AFK ignore list. Please try again.');
            }
            return;
        }
    } catch (err) {
        console.error('❌ Interaction error:', err);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ Something went wrong.');
        } else {
            await interaction.reply({ content: '❌ Something went wrong.', flags: 1 << 6 });
        }
    }
});

async function playMusic(guild) {
    const serverQueue = queue[guild.id];
    if (!serverQueue || serverQueue.songs.length === 0) return;

    const song = serverQueue.songs[0];
    try {
        // Use play-dl to get stream
        const streamInfo = await playdl.stream(song.url);
        const resource = createAudioResource(streamInfo.stream, { inputType: streamInfo.type });
        serverQueue.player.play(resource);
    } catch (err) {
        console.error('Music error:', err);
        serverQueue.songs.shift();
        playMusic(guild);
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Message counting
    try {
        await pgClient.query(
            'INSERT INTO user_messages (user_id, count) VALUES ($1, 1) ON CONFLICT (user_id) DO UPDATE SET count = user_messages.count + 1',
            [message.author.id]
        );
    } catch (err) {
        console.error('❌ Message counting error:', err);
    }

    // AFK System - Check if user is AFK and should be removed
    try {
        const afkResult = await pgClient.query('SELECT * FROM afk_users WHERE user_id = $1', [message.author.id]);
        
        if (afkResult.rows.length > 0) {
            const afkData = afkResult.rows[0];
            
            // Check if user has permanent AFK (admin-only feature)
            if (afkData.is_permanent) {
                // Don't remove AFK for permanent users - they must use /unafk
                console.log(`🔒 ${message.author.tag} sent message but AFK is permanent`);
            } else {
                // Remove AFK for normal users when they send messages
                await pgClient.query('DELETE FROM afk_users WHERE user_id = $1', [message.author.id]);
                
                const afkDuration = Date.now() - afkData.timestamp;
                const durationText = afkDuration > 60000 
                    ? `${Math.floor(afkDuration / 60000)} minute(s)`
                    : `${Math.floor(afkDuration / 1000)} second(s)`;
                
                await message.reply(`✅ **${message.author.username}** is no longer AFK. You were away for ${durationText}.`);
                console.log(`✅ ${message.author.tag} AFK removed automatically after ${durationText}`);
            }
        }
    } catch (err) {
        console.error('❌ AFK removal error:', err);
    }

    // AFK System - Check if mentioned users are AFK
    if (message.mentions.users.size > 0) {
        try {
            // Check if the message author has any ignore roles or is an ignored user
            const member = message.guild.members.cache.get(message.author.id);
            let shouldIgnoreAFK = false;
            
            if (member) {
                // Check ignore roles
                const ignoreRolesResult = await pgClient.query('SELECT role_id FROM afk_ignore_roles WHERE guild_id = $1', [message.guild.id]);
                const ignoreRoleIds = ignoreRolesResult.rows.map(row => row.role_id);
                
                // Check if user has any of the ignore roles
                shouldIgnoreAFK = member.roles.cache.some(role => ignoreRoleIds.includes(role.id));
                
                // If not ignored by role, check if user is specifically ignored
                if (!shouldIgnoreAFK) {
                    const ignoreUsersResult = await pgClient.query('SELECT user_id FROM afk_ignore_users WHERE guild_id = $1 AND user_id = $2', [message.guild.id, message.author.id]);
                    shouldIgnoreAFK = ignoreUsersResult.rows.length > 0;
                }
            }
            
            if (!shouldIgnoreAFK) {
                for (const [userId, user] of message.mentions.users) {
                    // Skip if mentioning bot
                    if (user.bot || userId === client.user.id) continue;
                    
                    const afkResult = await pgClient.query('SELECT * FROM afk_users WHERE user_id = $1', [userId]);
                    
                    if (afkResult.rows.length > 0) {
                        const afkData = afkResult.rows[0];
                        const afkDuration = Date.now() - afkData.timestamp;
                        const durationText = afkDuration > 60000 
                            ? `${Math.floor(afkDuration / 60000)} minute(s)`
                            : `${Math.floor(afkDuration / 1000)} second(s)`;
                        
                        await message.reply(`💤 **${user.username}** is currently AFK: ${afkData.reason}\n*They have been away for ${durationText}*`);
                    }
                }
            }
        } catch (err) {
            console.error('❌ AFK mention check error:', err);
        }
    }

    // Trigger when bot OR user 1021122042302562375 is pinged (and not a reply)
    if (
        (message.mentions.users.has(client.user.id) || message.mentions.users.has('1021122042302562375')) &&
        !message.reference
    ) {
        return await message.reply('<:FakeNitroEmoji:1387805391429304512> Zon\'t zisturb me');
    }

});

client.login(token);

process.on('unhandledRejection', reason => console.error('💥 Unhandled Rejection:', reason));
process.on('uncaughtException', err => console.error('💥 Uncaught Exception:', err));
