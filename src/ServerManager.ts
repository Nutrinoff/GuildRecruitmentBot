import {
    Client,
    ForumChannel,
    ThreadChannel,
    MessageCreateOptions,
    GatewayIntentBits,
} from 'discord.js';
import axios from 'axios';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

interface Config {
    DISCORD_TOKEN: string;
    ALLIANCE_CHANNEL_ID: string;
    HORDE_CHANNEL_ID: string;
    SPREADSHEET_ID: string;
    SHEET_RANGE: string;
    IMAGE_COLUMN_HEADER: string;
    EXCLUDED_COLUMN_HEADER: string;
    THREAD_AGE_LIMIT_HOURS: number;
    POLL_INTERVAL_MS: number;
    MAX_ENTRY_AGE_DAYS: number;
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

export class ServerManager {
    private sheets: any;
    private config: Config;

    constructor(
        private client: Client,
        private allianceChannelId: string,
        private hordeChannelId: string,
        config: Config
    ) {
        this.config = config;

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

        this.sheets = google.sheets({ version: 'v4', auth });
    }

    public updateChannels(allianceChannelId: string, hordeChannelId: string) {
    this.allianceChannelId = allianceChannelId;
    this.hordeChannelId = hordeChannelId;
    }

    private async getSpreadsheetData(): Promise<any[][]> {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.config.SPREADSHEET_ID,
                range: this.config.SHEET_RANGE,
            });
            return response.data.values || [];
        } catch (error) {
            console.error(`Failed to fetch data from Google Sheets: ${error}`);
            return [];
        }
    }

    private async fetchImage(url: string): Promise<Buffer | null> {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        } catch (error) {
            console.error(`Failed to fetch image from ${url}: ${error}`);
            return null;
        }
    }

    private getImageColumnIndex(headers: string[]): number {
        return headers.findIndex(header => header.includes(this.config.IMAGE_COLUMN_HEADER));
    }

    private getThreadAge(thread: ThreadChannel): number {
        const createdAt = thread.createdAt;
        if (!createdAt) return -1;
        return DateTime.now().diff(DateTime.fromJSDate(createdAt), 'hours').hours;
    }

    private needsRepost(thread: ThreadChannel): boolean {
        return this.getThreadAge(thread) >= this.config.THREAD_AGE_LIMIT_HOURS;
    }

    private isEntryTooOld(timestamp: string): boolean {
        const entryDate = DateTime.fromFormat(timestamp, 'MM/dd/yyyy HH:mm:ss');
        const daysOld = DateTime.now().diff(entryDate, 'days').days;
        return daysOld > this.config.MAX_ENTRY_AGE_DAYS;
    }

    public async removeUnmatchedThreads(channel: ForumChannel) {
        try {
            // Fetch the active threads in the forum channel
            const threads = await channel.threads.fetchActive();
            const existingThreadNames = new Set(Array.from(threads.threads.values()).map(thread => thread.name.trim().toLowerCase()));
    
            // Fetch data from Google Sheets
            const rows = await this.getSpreadsheetData();
            const headers = rows[0];
            const guildNameIndex = headers.indexOf('Guild Name');
            const timestampIndex = headers.indexOf('Timestamp');
    
            if (guildNameIndex === -1 || timestampIndex === -1) {
                console.error('Required columns not found in Google Sheets data.');
                return;
            }
    
            // Collect the guild names and their timestamps from the Google Sheet
            const sheetEntries = new Map<string, string>(); // Map of guild names to timestamps
            for (const row of rows.slice(1)) {
                const guildName = row[guildNameIndex]?.trim().toLowerCase();
                const timestamp = row[timestampIndex]?.trim();
                if (guildName && timestamp && !this.isEntryTooOld(timestamp)) {
                    sheetEntries.set(guildName, timestamp);
                }
            }
    
            // Identify threads to remove
            const threadsToDelete = Array.from(threads.threads.values()).filter(thread => {
                const threadName = thread.name.trim().toLowerCase();
                const threadTimestamp = sheetEntries.get(threadName);
                const isOld = threadTimestamp ? this.isEntryTooOld(threadTimestamp) : true;
                return !sheetEntries.has(threadName) || isOld;
            });
    
            // Delete the unmatched or outdated threads
            if (threadsToDelete.length > 0) {
                console.log(colorize(`[${channel.name}] ${threadsToDelete.length} threads to remove.`, COLORS.YELLOW));
                for (const thread of threadsToDelete) {
                    try {
                        await thread.delete('No matching data in Google Sheets or outdated entry');
                        console.log(`[${channel.name}] Deleted thread: ${thread.name} as it no longer matches any entry in the Google Sheet or is outdated.`);
                    } catch (error) {
                        console.error(`Failed to delete thread ${thread.name}: ${error}`);
                    }
                }
            } else {
                console.log(`[${channel.name}] No unmatched or outdated threads to remove.`);
            }
        } catch (error) {
            console.error(`Failed to remove unmatched threads: ${error}`);
        }
    }
    
    

    private async createGuildRecruitmentThread(channel: ForumChannel, threadTitle: string, messageOptions: MessageCreateOptions) {
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

    private async generateMessageContent(headers: string[], row: string[]): Promise<MessageCreateOptions> {
        let messageContent = '';
        const files: { attachment: Buffer; name: string }[] = [];

        const imageColumnIndex = this.getImageColumnIndex(headers);

        for (let j = 1; j < row.length; j++) {
            const key = headers[j];
            const value = row[j];
            if (key.includes('Guild Logo')) continue; // Exclude any header containing "Guild Logo"
            if (value) messageContent += `**${key}**: ${value}\n`;
        }

        if (imageColumnIndex !== -1 && row[imageColumnIndex]?.startsWith('http')) {
            const imageData = await this.fetchImage(row[imageColumnIndex]);
            if (imageData) {
                files.push({ attachment: imageData, name: `image${files.length + 1}.png` });
            }
        }

        return { content: messageContent, files };
    }

    private async handleThreadReposting(channel: ForumChannel, thread: ThreadChannel, row: string[], headers: string[]) {
        await thread.delete('Reposting new thread');
        console.log(`[${channel.name}] Deleted old thread for reposting: ${thread.name}`);

        const messageOptions = await this.generateMessageContent(headers, row);
        await this.createGuildRecruitmentThread(channel, thread.name, messageOptions);
        console.log(`[${channel.name}] Reposted thread: ${thread.name}`);
    }

    private async fetchAndFilterThreads(channel: ForumChannel, filterCondition: (thread: ThreadChannel) => boolean): Promise<ThreadChannel[]> {
        const threads = await channel.threads.fetchActive();
        return Array.from(threads.threads.values()).filter(filterCondition);
    }

    public async repostOldestThread(allianceChannel: ForumChannel, hordeChannel: ForumChannel) {
        async function handleReposting(channel: ForumChannel, config: Config, manager: ServerManager) {
            console.log(`\n\nStarting to check ${channel.name} for threads that need reposting...`);

            try {
                const threads = await manager.fetchAndFilterThreads(channel, thread => manager.needsRepost(thread));
                console.log(`[${channel.name}] Found ${threads.length} threads over the age limit.`);

                const rows = await manager.getSpreadsheetData();
                const headers = rows[0];
                const guildNameIndex = headers.indexOf('Guild Name');

                if (guildNameIndex === -1) {
                    console.error('Required columns not found in Google Sheets data.');
                    return;
                }

                let repostedCount = 0;

                for (const thread of threads) {
                    const row = rows.slice(1).find(r => r[guildNameIndex]?.trim() === thread.name.trim());
                    if (!row || manager.isEntryTooOld(row[headers.indexOf('Timestamp')])) continue;

                    await manager.handleThreadReposting(channel, thread, row, headers);
                    repostedCount++;
                    break; // Repost only the oldest thread
                }

                console.log(`[${channel.name}] Total reposted threads: ${repostedCount}`);
            } catch (error) {
                console.error(`Failed to handle reposting: ${error}`);
            }
        }

        await handleReposting(allianceChannel, this.config, this);
        await handleReposting(hordeChannel, this.config, this);
    }

    public async postNewEntries(allianceChannel: ForumChannel, hordeChannel: ForumChannel) {
        try {
            console.log('\n\nStarting to check for new entries to post...');

            const rows = await this.getSpreadsheetData();
            const headers = rows[0];
            const factionIndex = headers.indexOf('Faction');

            let newPostsAdded = 0;

            for (const row of rows.slice(1)) {
                const threadName = row[headers.indexOf('Guild Name')];
                const faction = row[factionIndex]?.trim();
                const timestamp = row[headers.indexOf('Timestamp')]?.trim();

                if (!threadName || this.isEntryTooOld(timestamp)) continue;

                const targetChannel = faction === 'Alliance' ? allianceChannel : faction === 'Horde' ? hordeChannel : null;
                if (!targetChannel) continue;

                const existingThreads = await this.fetchAndFilterThreads(targetChannel, thread => thread.name.trim() === threadName.trim());

                if (existingThreads.length === 0) {
                    const messageOptions = await this.generateMessageContent(headers, row);
                    await this.createGuildRecruitmentThread(targetChannel, threadName, messageOptions);
                   console.log(colorize(`[${targetChannel.name}] Added new thread: ${threadName}`, COLORS.GREEN));
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
}
