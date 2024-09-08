import {
    Client,
    ForumChannel,
    GatewayIntentBits,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    StringSelectMenuOptionBuilder,
    Interaction,
    CommandInteraction,
    StringSelectMenuInteraction
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { ServerManager } from './ServerManager';

// Load Discord token
const discordCredentialsPath = path.resolve(__dirname, 'discord-credentials.json');
const discordCredentials = JSON.parse(fs.readFileSync(discordCredentialsPath, 'utf-8'));
const discordToken = discordCredentials.DISCORD_TOKEN;
if (!discordToken) {
    console.error('Missing Discord token.');
    process.exit(1);
}

// Define paths for configuration files
const configPath = path.resolve(__dirname, 'server-settings.json');
const botSettingsPath = path.resolve(__dirname, 'botsettings.json');
const joinTimesPath = path.resolve(__dirname, 'join-times.json');

// Load bot settings
const botSettings = JSON.parse(fs.readFileSync(botSettingsPath, 'utf-8'));
const pollIntervalMs = botSettings.POLL_INTERVAL_MS;
if (pollIntervalMs === undefined) {
    console.error('Missing POLL_INTERVAL_MS in botsettings.json.');
    process.exit(1);
}

// Example function to add color to text
const colorize = (text: string, colorCode: string): string => `\x1b[${colorCode}m${text}\x1b[0m`;

// Define color codes
const COLORS = {
    RED: '31',
    GREEN: '32',
    YELLOW: '33',
    BLUE: '34',
    MAGENTA: '35',
    CYAN: '36',
    WHITE: '37',
};

// Temporary storage for user interactions
interface UserSelections {
    allianceChannelId?: string;
    hordeChannelId?: string;
}
const userSelections = new Map<string, UserSelections>();

// Function to read server config
const readServerConfig = (serverId: string) => {
    let serverSettings: Record<string, any> = {};

    if (fs.existsSync(configPath)) {
        serverSettings = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    return serverSettings[serverId] || {
        ALLIANCE_CHANNEL_ID: '',
        HORDE_CHANNEL_ID: '',
        MOD_CHANNEL_ID: '',
        SPREADSHEET_ID: '',
        THREAD_AGE_LIMIT_HOURS: 0.5,
        MAX_ENTRY_AGE_DAYS: 14,
    };
};

// Function to save server config
const saveServerConfig = (serverId: string, config: object) => {
    let serverSettings = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
    serverSettings[serverId] = config;

    try {
        fs.writeFileSync(configPath, JSON.stringify(serverSettings, null, 2));
        console.log(`Server config for ${serverId} saved successfully:`, config);
    } catch (error) {
        console.error(`Failed to save server config for ${serverId}:`, error);
    }
};

// Track server join times
const trackServerJoinTime = (guildId: string) => {
    const joinTimes = JSON.parse(fs.readFileSync(joinTimesPath, 'utf-8') || '{}');
    joinTimes[guildId] = new Date().toISOString();
    fs.writeFileSync(joinTimesPath, JSON.stringify(joinTimes, null, 2));
};

// Check and remove server if it hasn't been set up
const checkAndRemoveUnconfiguredServers = async (guild: any) => {
    const joinTimes = JSON.parse(fs.readFileSync(joinTimesPath, 'utf-8') || '{}');
    const joinTime = new Date(joinTimes[guild.id]);
    const currentTime = new Date();
    const setupTimeLimitMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    if (!joinTime) {
        console.error(`No join time found for server ${guild.name} (${guild.id}).`);
        return;
    }

    const timeSinceJoinMs = currentTime.getTime() - joinTime.getTime();
    
    if (timeSinceJoinMs > setupTimeLimitMs) {
        console.log(`\nServer ${guild.name} (${guild.id}) has been unconfigured for too long.`);
        console.log(`Current Time: ${currentTime.toISOString()}`);
        console.log(`Join Time: ${joinTime.toISOString()}`);
        console.log(`Time Since Join: ${Math.floor(timeSinceJoinMs / (1000 * 60 * 60))} hours`);

        const serverConfig = readServerConfig(guild.id);
        const allianceChannel = client.channels.cache.get(serverConfig.ALLIANCE_CHANNEL_ID) as ForumChannel | null;
        const hordeChannel = client.channels.cache.get(serverConfig.HORDE_CHANNEL_ID) as ForumChannel | null;
        const modChannel = client.channels.cache.get(serverConfig.MOD_CHANNEL_ID) as ForumChannel | null;

        if (!allianceChannel || !hordeChannel || !modChannel) {
            console.log(`Removing bot from server ${guild.name} (${guild.id}) due to incomplete setup.`);
            await guild.leave();
            delete joinTimes[guild.id];
            fs.writeFileSync(joinTimesPath, JSON.stringify(joinTimes, null, 2));
            console.log(`Successfully removed server ${guild.name} (${guild.id}).`);
        } else {
            console.log(`Server ${guild.name} (${guild.id}) is still configured. No action taken.`);
        }
    } else {
        console.log(`Server ${guild.name} (${guild.id}) is within the safe time limit.`);
    }
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Listen to rate limit events
client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Track server join time when bot joins a server
    client.on('guildCreate', async (guild) => {
        trackServerJoinTime(guild.id);
    });

    const pollServer = async (guild: any) => {
        console.log(colorize(`\nStarting polling for server ${guild.name} (${guild.id})...\n`, COLORS.CYAN));
        
        // Reload bot settings before each polling cycle
        const botSettings = JSON.parse(fs.readFileSync(botSettingsPath, 'utf-8'));

        const pollIntervalMs = botSettings.POLL_INTERVAL_MS;
        const serverConfig = readServerConfig(guild.id);
        const allianceChannel = client.channels.cache.get(serverConfig.ALLIANCE_CHANNEL_ID) as ForumChannel | null;
        const hordeChannel = client.channels.cache.get(serverConfig.HORDE_CHANNEL_ID) as ForumChannel | null;
        const modChannel = client.channels.cache.get(serverConfig.MOD_CHANNEL_ID) as ForumChannel | null;

        if (!allianceChannel || !hordeChannel || !modChannel) {
            console.error(`One or more channels could not be found for server ${guild.id}.`);
            return;
        }

        if (!(allianceChannel instanceof ForumChannel) || !(hordeChannel instanceof ForumChannel) || !(modChannel instanceof ForumChannel)) {
            console.error(`One or more channels are not ForumChannel instances for server ${guild.id}.`);
            return;
        }

        try {
            const serverManager = new ServerManager(
                client,
                serverConfig.ALLIANCE_CHANNEL_ID,
                serverConfig.HORDE_CHANNEL_ID,
                serverConfig.MOD_CHANNEL_ID,  // Pass the MOD_CHANNEL_ID here
                {
                    DISCORD_TOKEN: discordToken,
                    ALLIANCE_CHANNEL_ID: serverConfig.ALLIANCE_CHANNEL_ID,
                    HORDE_CHANNEL_ID: serverConfig.HORDE_CHANNEL_ID,
                    SPREADSHEET_ID: serverConfig.SPREADSHEET_ID,
                    SHEET_RANGE: botSettings.SHEET_RANGE,
                    IMAGE_COLUMN_HEADER: botSettings.IMAGE_COLUMN_HEADER,
                    EXCLUDED_COLUMN_HEADER: botSettings.EXCLUDED_COLUMN_HEADER,
                    THREAD_AGE_LIMIT_HOURS: serverConfig.THREAD_AGE_LIMIT_HOURS,
                    POLL_INTERVAL_MS: pollIntervalMs,
                    MAX_ENTRY_AGE_DAYS: serverConfig.MAX_ENTRY_AGE_DAYS,
                    MAX_NEW_THREADS_PER_CYCLE: botSettings.MAX_NEW_THREADS_PER_CYCLE,
                }
            );

            // Existing polling tasks
            await serverManager.removeDuplicateThreads(allianceChannel);
            await serverManager.removeDuplicateThreads(hordeChannel);
            await serverManager.removeUnmatchedThreads(allianceChannel);
            await serverManager.removeUnmatchedThreads(hordeChannel);
            await serverManager.repostOldestThread(allianceChannel, hordeChannel);
            await serverManager.postNewEntries(allianceChannel, hordeChannel);
            
            // New task for checking and posting similar threads
            await serverManager.checkAndPostSimilarThreads(allianceChannel);
            await serverManager.checkAndPostSimilarThreads(hordeChannel);

            console.log(colorize(`\nPolling completed for server ${guild.name} (${guild.id}).`, COLORS.GREEN));
        } catch (error) {
            console.error(`Error during polling for server ${guild.name} (${guild.id}):`, error);
        }
    };

    const startPolling = async () => {
        while (true) {
            console.log(colorize('\n\nStarting sequential polling of all servers...', COLORS.BLUE));

            for (const guild of client.guilds.cache.values()) {
                await pollServer(guild);
                await checkAndRemoveUnconfiguredServers(guild); // Check and remove unconfigured servers
            }

            console.log(colorize('\nAll servers have been polled.', COLORS.GREEN));
            console.log(`Waiting for ${pollIntervalMs}ms before starting next poll...`);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
    };

    startPolling();
});

client.on('interactionCreate', async (interaction: Interaction) => {
    if (interaction.isCommand()) {
        const commandInteraction = interaction as CommandInteraction;
        const serverId = commandInteraction.guild?.id;
        if (!serverId) return;

        if (commandInteraction.commandName === 'setup') {
            await commandInteraction.reply({
                content: 'Starting setup process. Please follow the instructions.',
                ephemeral: true
            });

            // Proceed to the Alliance channel selection
            const channels = commandInteraction.guild.channels.cache.filter(c => c instanceof ForumChannel);
            const allianceOptions = channels.map(c => new StringSelectMenuOptionBuilder()
                .setLabel(c.name)
                .setValue(`alliance_${c.id}`)
            );

            const allianceSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('alliance_channel_select')
                .setPlaceholder('Select Alliance Channel')
                .addOptions(allianceOptions);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(allianceSelectMenu);

            await commandInteraction.followUp({
                content: 'Select the Alliance channel:',
                components: [row],
                ephemeral: true
            });

        } else if (commandInteraction.commandName === 'setupsheet') {
            const spreadsheetId = commandInteraction.options.get('spreadsheet_id', true)?.value as string;

            let serverConfig = readServerConfig(serverId);

            serverConfig.SPREADSHEET_ID = spreadsheetId;

            saveServerConfig(serverId, serverConfig);

            await commandInteraction.reply({
                content: `Spreadsheet ID updated: ${spreadsheetId}`,
                ephemeral: true
            });

        } else if (commandInteraction.commandName === 'setuptimers') {
            // Handling setuptimers command
            const options = commandInteraction.options as CommandInteraction['options'];
            const threadAgeLimitHours = options.get('thread_age_limit_hours', true)?.value as number;
            const maxEntryAgeDays = options.get('max_entry_age_days', true)?.value as number;

            let serverConfig = readServerConfig(serverId);

            serverConfig.THREAD_AGE_LIMIT_HOURS = threadAgeLimitHours;
            serverConfig.MAX_ENTRY_AGE_DAYS = maxEntryAgeDays;

            saveServerConfig(serverId, serverConfig);

            await commandInteraction.reply({
                content: `Configuration updated:\n- Thread Age Limit: ${threadAgeLimitHours} hours\n- Max Entry Age: ${maxEntryAgeDays} days`,
                ephemeral: true
            });

        } else {
            await commandInteraction.reply({
                content: 'Unknown command.',
                ephemeral: true
            });
        }

    } else if (interaction.isStringSelectMenu()) {
        const selectMenuInteraction = interaction as StringSelectMenuInteraction;
        const selectedChannelId = selectMenuInteraction.values[0];
        const [type, channelId] = selectedChannelId.split('_');
        const guild = selectMenuInteraction.guild;
        const userId = selectMenuInteraction.user.id;

        if (!guild) return;

        const serverId = guild.id;
        let serverConfig = readServerConfig(serverId);

        if (type === 'alliance') {
            serverConfig.ALLIANCE_CHANNEL_ID = channelId;
            saveServerConfig(serverId, serverConfig);
            userSelections.set(userId, { allianceChannelId: channelId });

            await selectMenuInteraction.reply({
                content: `Alliance channel updated to <#${channelId}>. Now select the Horde channel:`,
                ephemeral: true
            });

            const channels = guild.channels.cache.filter(c => c instanceof ForumChannel);
            const hordeOptions = channels.map(c => new StringSelectMenuOptionBuilder()
                .setLabel(c.name)
                .setValue(`horde_${c.id}`)
            );

            const hordeSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('horde_channel_select')
                .setPlaceholder('Select Horde Channel')
                .addOptions(hordeOptions);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(hordeSelectMenu);

            await selectMenuInteraction.followUp({
                content: 'Select the Horde channel:',
                components: [row],
                ephemeral: true
            });

        } else if (type === 'horde') {
            const selection = userSelections.get(userId);
            if (!selection) {
                await selectMenuInteraction.reply({
                    content: 'You need to select an Alliance channel first.',
                    ephemeral: true
                });
                return;
            }

            serverConfig.HORDE_CHANNEL_ID = channelId;
            saveServerConfig(serverId, serverConfig);

            await selectMenuInteraction.reply({
                content: `Horde channel updated to <#${channelId}>. Now select the Moderation channel:`,
                ephemeral: true
            });

            const channels = guild.channels.cache.filter(c => c instanceof ForumChannel);
            const modOptions = channels.map(c => new StringSelectMenuOptionBuilder()
                .setLabel(c.name)
                .setValue(`mod_${c.id}`)
            );

            const modSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('mod_channel_select')
                .setPlaceholder('Select Moderation Channel')
                .addOptions(modOptions);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modSelectMenu);

            await selectMenuInteraction.followUp({
                content: 'Select the Moderation channel:',
                components: [row],
                ephemeral: true
            });

        } else if (type === 'mod') {
            serverConfig.MOD_CHANNEL_ID = channelId;
            saveServerConfig(serverId, serverConfig);
            userSelections.delete(userId);

            await selectMenuInteraction.reply({
                content: `Moderation channel updated to <#${channelId}>. Configuration is now complete!`,
                ephemeral: true
            });

        } else {
            await selectMenuInteraction.reply({
                content: 'This interaction is not a valid selection menu.',
                ephemeral: true
            });
        }
    }
});

client.login(discordToken);
