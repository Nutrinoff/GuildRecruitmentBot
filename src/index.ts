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

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Function to poll a single server
    const pollServer = async (guild: any) => {
        const serverConfig = readServerConfig(guild.id);
        const allianceChannel = client.channels.cache.get(serverConfig.ALLIANCE_CHANNEL_ID) as ForumChannel | null;
        const hordeChannel = client.channels.cache.get(serverConfig.HORDE_CHANNEL_ID) as ForumChannel | null;

        if (!allianceChannel || !hordeChannel) {
            console.error(`One or both channels could not be found for server ${guild.id}.`);
            return;
        }

        if (!(allianceChannel instanceof ForumChannel) || !(hordeChannel instanceof ForumChannel)) {
            console.error(`One or both channels are not ForumChannel instances for server ${guild.id}.`);
            return;
        }

        try {
            console.log(colorize(`\nStarting polling for server ${guild.name} (${guild.id})...\n`, COLORS.CYAN));


            const serverManager = new ServerManager(client, serverConfig.ALLIANCE_CHANNEL_ID, serverConfig.HORDE_CHANNEL_ID, {
                DISCORD_TOKEN: discordToken,
                ALLIANCE_CHANNEL_ID: serverConfig.ALLIANCE_CHANNEL_ID,
                HORDE_CHANNEL_ID: serverConfig.HORDE_CHANNEL_ID,
                SPREADSHEET_ID: serverConfig.SPREADSHEET_ID,
                SHEET_RANGE: serverConfig.SHEET_RANGE,
                IMAGE_COLUMN_HEADER: serverConfig.IMAGE_COLUMN_HEADER,
                EXCLUDED_COLUMN_HEADER: serverConfig.EXCLUDED_COLUMN_HEADER,
                THREAD_AGE_LIMIT_HOURS: serverConfig.THREAD_AGE_LIMIT_HOURS,
                POLL_INTERVAL_MS: pollIntervalMs, // Use the value from botsettings.json
                MAX_ENTRY_AGE_DAYS: serverConfig.MAX_ENTRY_AGE_DAYS,
            });

            await serverManager.removeUnmatchedThreads(allianceChannel);
            await serverManager.removeUnmatchedThreads(hordeChannel);
            await serverManager.repostOldestThread(allianceChannel, hordeChannel);
            await serverManager.postNewEntries(allianceChannel, hordeChannel);

            console.log(colorize(`\nPolling completed for server ${guild.name} (${guild.id}).`, COLORS.GREEN));
        } catch (error) {
            console.error(`Error during polling for server ${guild.name} (${guild.id}):`, error);
        }
    };

    // Sequentially poll each guild
    const pollAllServers = async () => {
        for (const guild of client.guilds.cache.values()) {
            await pollServer(guild);
        }
    };

    // Start the sequential polling with interval
    setInterval(async () => {
        console.log(colorize('\n\nStarting sequential polling of all servers...', COLORS.BLUE));
        await pollAllServers();
        console.log(colorize('\nAll servers have been polled.', COLORS.GREEN));
    }, pollIntervalMs); // Use the value from botsettings.json
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
            userSelections.delete(userId);

            await selectMenuInteraction.reply({
                content: `Horde channel updated to <#${channelId}>. Configuration is now complete!`,
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
