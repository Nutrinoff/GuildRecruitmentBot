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
        MOD_CHANNEL_ID: '',  // Add this line
        SPREADSHEET_ID: '',
        SHEET_RANGE: '',
        IMAGE_COLUMN_HEADER: '',
        EXCLUDED_COLUMN_HEADER: '',
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

class RateLimitError extends Error {
    constructor(public bucket: string, public message: string) {
        super(message);
        this.name = 'RateLimitError';
    }
}

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let rateLimitTimeouts = new Map<string, number>(); // Track rate limit timeouts

// Listen to rate limit events
client.on('rateLimit', (rateLimitData) => {
    console.warn(`Rate limit hit! Route: ${rateLimitData.route}`);
    console.warn(`Timeout: ${rateLimitData.timeout}ms`);
    console.warn(`Method: ${rateLimitData.method}`);
    console.warn(`Global: ${rateLimitData.global}`);
    console.warn(`Bucket: ${rateLimitData.bucket}`);

    // Store the timeout duration for the bucket
    rateLimitTimeouts.set(rateLimitData.bucket, rateLimitData.timeout);
});

// Log rate limit info before starting polling
const logRateLimitInfo = () => {
    console.log(colorize('\nRate limit information is monitored via rateLimit event.', COLORS.YELLOW));
    // Log or handle other rate limit information as needed
};

client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    const pollServer = async (guild: any) => {
        console.log(colorize(`\nStarting polling for server ${guild.name} (${guild.id})...\n`, COLORS.CYAN));

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
                    SHEET_RANGE: serverConfig.SHEET_RANGE,
                    IMAGE_COLUMN_HEADER: serverConfig.IMAGE_COLUMN_HEADER,
                    EXCLUDED_COLUMN_HEADER: serverConfig.EXCLUDED_COLUMN_HEADER,
                    THREAD_AGE_LIMIT_HOURS: serverConfig.THREAD_AGE_LIMIT_HOURS,
                    POLL_INTERVAL_MS: pollIntervalMs,
                    MAX_ENTRY_AGE_DAYS: serverConfig.MAX_ENTRY_AGE_DAYS,
                }
            );

            const executePollingTask = async (task: () => Promise<void>) => {
                try {
                    await task();
                } catch (error) {
                    if (error instanceof RateLimitError) {
                        console.warn(`Rate limit error: ${error.message}`);
                        const timeout = rateLimitTimeouts.get(error.bucket) || 10000; // Default to 10 seconds
                        console.warn(`Waiting for ${timeout}ms before retrying...`);
                        await new Promise(resolve => setTimeout(resolve, timeout));
                    } else {
                        throw error;
                    }
                }
            };

            // Existing polling tasks
            await executePollingTask(() => serverManager.removeDuplicateThreads(allianceChannel));
            await executePollingTask(() => serverManager.removeDuplicateThreads(hordeChannel));
            await executePollingTask(() => serverManager.removeUnmatchedThreads(allianceChannel));
            await executePollingTask(() => serverManager.removeUnmatchedThreads(hordeChannel));
            await executePollingTask(() => serverManager.repostOldestThread(allianceChannel, hordeChannel));
            await executePollingTask(() => serverManager.postNewEntries(allianceChannel, hordeChannel));
            
            // New task for checking and posting similar threads
            await executePollingTask(() => serverManager.checkAndPostSimilarThreads(allianceChannel));
            await executePollingTask(() => serverManager.checkAndPostSimilarThreads(hordeChannel));

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

        } else if (commandInteraction.commandName === 'setupvalues') {
            // Handling setupvalues command
            const options = commandInteraction.options as CommandInteraction['options'];

            const spreadsheetId = options.get('spreadsheet_id', true)?.value as string;
            const sheetRange = options.get('sheet_range', true)?.value as string;
            const imageColumnHeader = options.get('image_column_header', true)?.value as string;
            const excludedColumnHeader = options.get('excluded_column_header', true)?.value as string;

            let serverConfig = readServerConfig(serverId);

            serverConfig.SPREADSHEET_ID = spreadsheetId;
            serverConfig.SHEET_RANGE = sheetRange;
            serverConfig.IMAGE_COLUMN_HEADER = imageColumnHeader;
            serverConfig.EXCLUDED_COLUMN_HEADER = excludedColumnHeader;

            saveServerConfig(serverId, serverConfig);

            await commandInteraction.reply({
                content: `Configuration updated:\n- Spreadsheet ID: ${spreadsheetId}\n- Sheet Range: ${sheetRange}\n- Image Column Header: ${imageColumnHeader}\n- Excluded Column Header: ${excludedColumnHeader}`,
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
