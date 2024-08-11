import { Client, GatewayIntentBits, ForumChannel, TextChannel, ThreadChannel, MessageCreateOptions } from 'discord.js';
import axios from 'axios';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon'; // For date handling

// Load configuration from config.txt
const configPath = path.resolve(__dirname, 'config.txt');
const configData = fs.readFileSync(configPath, 'utf-8');

// Parse the configuration
const config: Record<string, string> = {};
configData.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    config[key.trim()] = value.trim();
  }
});

// Configuration
const CONFIG = {
DISCORD_TOKEN: config.DISCORD_TOKEN, // Replace with your Discord bot token
ALLIANCE_CHANNEL_ID: config.ALLIANCE_CHANNEL_ID, // Replace with your Alliance channel ID
HORDE_CHANNEL_ID: config.HORDE_CHANNEL_ID, // Replace with your Horde channel ID
SPREADSHEET_ID: config.SPREADSHEET_ID, // Replace with your Google Spreadsheet ID
SHEET_RANGE: 'Form Responses 1!A:AG', // Replace with your sheet range
IMAGE_COLUMN_HEADER: 'Guild Logo', // Replace with your column header for image URLs
EXCLUDED_COLUMN_HEADER: 'Timestamp', // Replace with the column header to exclude

THREAD_AGE_LIMIT_HOURS: parseFloat(config.THREAD_AGE_LIMIT_HOURS), // Parse as float
POLL_INTERVAL_MS: parseInt(config.POLL_INTERVAL_MS, 10), // Parse as integer
MAX_ENTRY_AGE_DAYS: parseInt(config.MAX_ENTRY_AGE_DAYS, 10) // Parse as integer
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Initialize Google Sheets API
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

const auth = new google.auth.JWT(
    credentials.client_email,
    undefined,
    credentials.private_key,
    SCOPES
);

const sheets = google.sheets({ version: 'v4', auth });

// Utility Functions
async function fetchImage(url: string): Promise<Buffer | null> {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`Failed to fetch image from ${url}: ${error}`);
        return null;
    }
}

// Function to find the correct image column index dynamically
function getImageColumnIndex(headers: string[]): number {
    return headers.findIndex(header => header.includes(CONFIG.IMAGE_COLUMN_HEADER));
}

function getThreadAge(thread: ThreadChannel): number {
    const createdAt = thread.createdAt;
    if (!createdAt) return -1;
    return DateTime.now().diff(DateTime.fromJSDate(createdAt), 'hours').hours;
}

function needsRepost(thread: ThreadChannel): boolean {
    return getThreadAge(thread) >= CONFIG.THREAD_AGE_LIMIT_HOURS;
}

function isEntryTooOld(timestamp: string): boolean {
    const entryDate = DateTime.fromFormat(timestamp, 'MM/dd/yyyy HH:mm:ss');
    const daysOld = DateTime.now().diff(entryDate, 'days').days;
    return daysOld > CONFIG.MAX_ENTRY_AGE_DAYS;
}

// Google Sheets API Functions
async function getSpreadsheetData(): Promise<any[][]> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: CONFIG.SHEET_RANGE,
        });
        return response.data.values || [];
    } catch (error) {
        console.error(`Failed to fetch data from Google Sheets: ${error}`);
        return [];
    }
}

// Discord Bot Functions
async function removeUnmatchedThreads(channel: ForumChannel) {
    try {
        const threads = await channel.threads.fetchActive();
        const threadCount = threads.threads.size;
        console.log(`[${channel.name}] Found ${threadCount} active threads.`);

        const existingThreadNames = new Set(Array.from(threads.threads.values()).map(thread => thread.name.trim()));

        const rows = await getSpreadsheetData();
        const headers = rows[0];
        const guildNameIndex = headers.indexOf('Guild Name');
        const timestampIndex = headers.indexOf('Timestamp');

        if (guildNameIndex === -1 || timestampIndex === -1) {
            console.error('Required columns not found in Google Sheets data.');
            return;
        }

        // Track entries that need removal due to being too old
        const entriesToRemove = new Set<string>();

        // Identify outdated entries and mark for removal
        for (const row of rows.slice(1)) {
            const timestamp = row[timestampIndex];
            const guildName = row[guildNameIndex]?.trim();

            if (guildName && isEntryTooOld(timestamp)) {
                // Only add to entriesToRemove if the thread exists
                if (existingThreadNames.has(guildName)) {
                    entriesToRemove.add(guildName);
                    console.log(`[${channel.name}] Entry with timestamp ${timestamp} is older than ${CONFIG.MAX_ENTRY_AGE_DAYS} days and will be excluded.`);
                }
            }
        }

        // Identify threads to delete
        const threadsToDelete = Array.from(threads.threads.values()).filter(thread => entriesToRemove.has(thread.name.trim()));

        if (threadsToDelete.length > 0) {
            console.log(`[${channel.name}] ${threadsToDelete.length} threads to remove.`);

            for (const thread of threadsToDelete) {
                try {
                    await thread.delete('No matching data in Google Sheets');
                    console.log(`[${channel.name}] Deleted thread: ${thread.name} due to outdated entry.`);
                } catch (error) {
                    console.error(`Failed to delete thread ${thread.name}: ${error}`);
                }
            }
        } else {
            console.log(`[${channel.name}] No threads to remove.`);
        }
    } catch (error) {
        console.error(`Failed to remove unmatched threads: ${error}`);
    }
}

async function createGuildRecruitmentThread(channel: ForumChannel, threadTitle: string, messageOptions: MessageCreateOptions) {
    try {
        const thread = await channel.threads.create({
            name: threadTitle || 'No Title',
            autoArchiveDuration: 60,
            reason: 'Creating thread for recruitment post',
            message: messageOptions,
        });
        return thread;
    } catch (error) {
        console.error(`Failed to create thread: ${error}`);
        throw error;
    }
}

async function generateMessageContent(headers: string[], row: string[]): Promise<MessageCreateOptions> {
    let messageContent = '';
    const files: { attachment: Buffer; name: string }[] = [];
    
    const imageColumnIndex = getImageColumnIndex(headers);

    for (let j = 1; j < row.length; j++) {
        const key = headers[j];
        const value = row[j];
        if (key.includes('Guild Logo')) continue; // Exclude any header containing "Guild Logo"
        if (value) messageContent += `**${key}**: ${value}\n`;
    }

    if (imageColumnIndex !== -1 && row[imageColumnIndex]?.startsWith('http')) {
        const imageData = await fetchImage(row[imageColumnIndex]);
        if (imageData) {
            files.push({ attachment: imageData, name: `image${files.length + 1}.png` });
        }
    }

    return { content: messageContent, files };
}

async function handleThreadReposting(channel: ForumChannel, thread: ThreadChannel, row: string[], headers: string[]) {
    await thread.delete('Reposting new thread');
    console.log(`[${channel.name}] Deleted old thread for reposting: ${thread.name}`);

    const messageOptions = await generateMessageContent(headers, row);
    await createGuildRecruitmentThread(channel, thread.name, messageOptions);
    console.log(`[${channel.name}] Reposted thread: ${thread.name}`);
}

async function fetchAndFilterThreads(channel: ForumChannel, filterCondition: (thread: ThreadChannel) => boolean): Promise<ThreadChannel[]> {
    const threads = await channel.threads.fetchActive();
    return Array.from(threads.threads.values()).filter(filterCondition);
}

async function repostOldestThread(allianceChannel: ForumChannel, hordeChannel: ForumChannel) {
    async function handleReposting(channel: ForumChannel) {
        console.log(`\n\nStarting to check ${channel.name} for threads that need reposting...`);

        try {
            const threads = await fetchAndFilterThreads(channel, thread => needsRepost(thread));
            console.log(`[${channel.name}] Found ${threads.length} threads over the age limit.`);

            const rows = await getSpreadsheetData();
            const headers = rows[0];
            const guildNameIndex = headers.indexOf('Guild Name');

            if (guildNameIndex === -1) {
                console.error('Required columns not found in Google Sheets data.');
                return;
            }

            let repostedCount = 0;

            for (const thread of threads) {
                const row = rows.slice(1).find(r => r[guildNameIndex]?.trim() === thread.name.trim());
                if (!row || isEntryTooOld(row[headers.indexOf('Timestamp')])) continue;

                await handleThreadReposting(channel, thread, row, headers);
                repostedCount++;
                break; // Repost only the oldest thread
            }

            console.log(`[${channel.name}] Total reposted threads: ${repostedCount}`);
        } catch (error) {
            console.error(`Failed to handle reposting: ${error}`);
        }
    }

    await handleReposting(allianceChannel);
    await handleReposting(hordeChannel);
}

async function postNewEntries(allianceChannel: ForumChannel, hordeChannel: ForumChannel) {
    try {
        console.log('\n\nStarting to check for new entries to post...');

        const rows = await getSpreadsheetData();
        const headers = rows[0];
        const factionIndex = headers.indexOf('Faction');

        let newPostsAdded = 0;

        for (const row of rows.slice(1)) {
            const threadName = row[headers.indexOf('Guild Name')];
            const faction = row[factionIndex]?.trim();
            const timestamp = row[headers.indexOf('Timestamp')]?.trim();

            if (!threadName || isEntryTooOld(timestamp)) continue;

            const targetChannel = faction === 'Alliance' ? allianceChannel : faction === 'Horde' ? hordeChannel : null;
            if (!targetChannel) continue;

            const existingThreads = await fetchAndFilterThreads(targetChannel, thread => thread.name.trim() === threadName.trim());

            if (existingThreads.length === 0) {
                const messageOptions = await generateMessageContent(headers, row);
                await createGuildRecruitmentThread(targetChannel, threadName, messageOptions);
                console.log(`[${targetChannel.name}] Added new thread: ${threadName}`);
                newPostsAdded++;
            }
        }

        if (newPostsAdded === 0) {
            console.log('No new posts to add.');
        } else {
            console.log(`Total new posts added: ${newPostsAdded}`);
        }
    } catch (error) {
        console.error(`Failed to post new entries: ${error}`);
    }
}

// On ready event
client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    const allianceChannel = client.channels.cache.get(CONFIG.ALLIANCE_CHANNEL_ID) as ForumChannel | null;
    const hordeChannel = client.channels.cache.get(CONFIG.HORDE_CHANNEL_ID) as ForumChannel | null;

    if (!allianceChannel || !hordeChannel) {
        console.error('One or both channels could not be found.');
        return;
    }

    if (!(allianceChannel instanceof ForumChannel) || !(hordeChannel instanceof ForumChannel)) {
        console.error('One or both channels are not ForumChannel instances.');
        return;
    }

    // Poll for threads and repost if necessary, and also post new entries
    let isPolling = false;
    setInterval(async () => {
        if (isPolling) {
            console.log('Polling is already in progress...');
            return;
        }

        isPolling = true;
        console.log('\n\nStarting polling...');
        try {
            await removeUnmatchedThreads(allianceChannel);
            await removeUnmatchedThreads(hordeChannel);
            await repostOldestThread(allianceChannel, hordeChannel);
            await postNewEntries(allianceChannel, hordeChannel);
        } catch (error) {
            console.error('Error during polling:', error);
        } finally {
            isPolling = false;
            console.log('Polling completed.');
        }
    }, CONFIG.POLL_INTERVAL_MS);

    // Command line interface
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (input) => {
        const command = input.toString().trim();
        try {
            if (command === 'repost old') {
                await repostOldestThread(allianceChannel, hordeChannel);
            } else if (command === 'post new') {
                await postNewEntries(allianceChannel, hordeChannel);
            } else {
                console.log('Unknown command. Use "repost old" or "post new".');
            }
        } catch (error) {
            console.error('Error executing command:', error);
        }
    });
});

// Start the bot
client.login(CONFIG.DISCORD_TOKEN);