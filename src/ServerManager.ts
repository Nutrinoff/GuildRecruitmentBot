import {
    Client,
    ForumChannel,
    ThreadChannel,
    MessageCreateOptions,
    GatewayIntentBits,
    RateLimitError
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

const colorize = (text: string, colorCode: string): string => `\x1b[${colorCode}m${text}\x1b[0m`;

const COLORS = {
    RED: '31',
    GREEN: '32',
    YELLOW: '33',
    BLUE: '34',
    MAGENTA: '35',
    CYAN: '36',
    WHITE: '37',
};

const getRateLimitDelay = (error: RateLimitError): number => {
    return error.retryAfter || 10000; // Default to 10 seconds if not specified
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
        this.initializeGoogleSheetsAPI();
    }

    private initializeGoogleSheetsAPI() {
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

    private async handleRateLimit(response: any) {
        if (response.status === 429) { // Rate limit hit
            const retryAfter = parseInt(response.headers['retry-after'] || '10000', 10); // Default to 10 seconds if not specified
            console.warn(`Rate limit hit! Waiting for ${retryAfter}ms before retrying...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter)); // Wait before retrying
        }
    }

    private async getSpreadsheetData(): Promise<any[][]> {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.config.SPREADSHEET_ID,
                range: this.config.SHEET_RANGE,
            });
            await this.handleRateLimit(response);
            return response.data.values || [];
        } catch (error) {
            console.error(`Failed to fetch data from Google Sheets: ${error}`);
            return [];
        }
    }

    private async fetchImage(url: string): Promise<Buffer | null> {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            await this.handleRateLimit(response);
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
        return createdAt ? DateTime.now().diff(DateTime.fromJSDate(createdAt), 'hours').hours : -1;
    }

    private needsRepost(thread: ThreadChannel): boolean {
        return this.getThreadAge(thread) >= this.config.THREAD_AGE_LIMIT_HOURS;
    }

    private isEntryTooOld(timestamp: string): boolean {
        const entryDate = DateTime.fromFormat(timestamp, 'MM/dd/yyyy HH:mm:ss');
        return DateTime.now().diff(entryDate, 'days').days > this.config.MAX_ENTRY_AGE_DAYS;
    }

    public async removeUnmatchedThreads(channel: ForumChannel) {
        try {
            console.log(colorize(`\n\nStarting to check ${channel.name} for threads without Google Sheet...`, COLORS.YELLOW));
            const threads = await channel.threads.fetchActive();
            const existingThreadNames = new Set(Array.from(threads.threads.values()).map(thread => thread.name.trim().toLowerCase()));
    
            const rows = await this.getSpreadsheetData();
            const headers = rows[0];
            const guildNameIndex = headers.indexOf('Guild Name');
            const timestampIndex = headers.indexOf('Timestamp');
    
            if (guildNameIndex === -1 || timestampIndex === -1) {
                console.error('Required columns not found in Google Sheets data.');
                return;
            }
    
            const sheetEntries = new Map<string, string>();
            for (const row of rows.slice(1)) {
                const guildName = row[guildNameIndex]?.trim().toLowerCase();
                const timestamp = row[timestampIndex]?.trim();
                if (guildName && timestamp && !this.isEntryTooOld(timestamp)) {
                    sheetEntries.set(guildName, timestamp);
                }
            }
    
            const threadsToDelete = Array.from(threads.threads.values()).filter(thread => {
                const threadName = thread.name.trim().toLowerCase();
                const threadTimestamp = sheetEntries.get(threadName);
                const isOld = threadTimestamp ? this.isEntryTooOld(threadTimestamp) : true;
                return !sheetEntries.has(threadName) || isOld;
            });
    
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
        const timeoutDuration = 15000; // Timeout duration in milliseconds (15 seconds)
    
        try {
            const threadCreationPromise = channel.threads.create({
                name: threadTitle || 'No Title',
                autoArchiveDuration: 60,
                reason: 'Creating thread for recruitment post',
                message: messageOptions,
            });
    
            // Add timeout to the thread creation promise
            const timeoutPromise = new Promise<ThreadChannel>((_, reject) =>
                setTimeout(() => reject(new Error('Thread creation timed out')), timeoutDuration)
            );
    
            return await Promise.race([threadCreationPromise, timeoutPromise]);
        } catch {
            // Gracefully exit without logging error
            return;
        }
    }
    
    

    private async generateMessageContent(headers: string[], row: string[]): Promise<MessageCreateOptions> {
        let messageContent = '';
        const files: { attachment: Buffer; name: string }[] = [];

        const imageColumnIndex = this.getImageColumnIndex(headers);

        for (let j = 1; j < row.length; j++) {
            const key = headers[j];
            const value = row[j];
            if (key.includes(this.config.EXCLUDED_COLUMN_HEADER)) continue; // Exclude any header containing the specified text
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
        try {
            await thread.delete('Reposting new thread');
            console.log(`[${channel.name}] Deleted old thread for reposting: ${thread.name}`);
    
            const messageOptions = await this.generateMessageContent(headers, row);
            await this.createGuildRecruitmentThread(channel, thread.name, messageOptions);
            console.log(colorize(`[${channel.name}] Reposted thread: ${thread.name}`, COLORS.GREEN));
        } catch (error) {
            console.error(`Failed to handle thread reposting: ${error}`);
        }
    }

    private async fetchAndFilterThreads(channel: ForumChannel, filterCondition: (thread: ThreadChannel) => boolean): Promise<ThreadChannel[]> {
        const threads = await channel.threads.fetchActive();
        return Array.from(threads.threads.values()).filter(filterCondition);
    }

    public async removeDuplicateThreads(channel: ForumChannel) {
        try {
            console.log(colorize(`\n\nStarting to check ${channel.name} for duplicate threads...`, COLORS.YELLOW));

            const threads = await channel.threads.fetchActive();
            const threadsByTitle = new Map<string, ThreadChannel[]>();

            // Group threads by title
            for (const thread of threads.threads.values()) {
                const title = thread.name.trim().toLowerCase();
                if (!threadsByTitle.has(title)) {
                    threadsByTitle.set(title, []);
                }
                threadsByTitle.get(title)!.push(thread);
            }

            // Identify and delete duplicates, keeping only one thread per title
            let duplicatesRemoved = 0;
            for (const [title, threadList] of threadsByTitle) {
                if (threadList.length > 1) {
                    // Keep the first thread, delete the rest
                    for (const thread of threadList.slice(1)) {
                        try {
                            await thread.delete('Duplicate thread');
                            console.log(colorize(`[${channel.name}] Deleted duplicate thread: ${thread.name}`, COLORS.GREEN));
                            duplicatesRemoved++;
                        } catch (error) {
                            console.error(`Failed to delete duplicate thread ${thread.name}: ${error}`);
                        }
                    }
                }
            }

            if (duplicatesRemoved === 0) {
                console.log(`[${channel.name}] No duplicate threads to remove.`);
            } else {
                console.log(`[${channel.name}] Total duplicate threads removed: ${duplicatesRemoved}`);
            }
        } catch (error) {
            console.error(`Failed to remove duplicate threads: ${error}`);
        }
    }

    public async repostOldestThread(allianceChannel: ForumChannel, hordeChannel: ForumChannel) {
        async function handleReposting(channel: ForumChannel, config: Config, manager: ServerManager) {
            let repostedCount = 0;
            let hasTimeoutOccurred = false;
    
            const timeoutDuration = 10000; // Timeout duration in milliseconds (10 seconds)
    
            console.log(colorize(`\n\nStarting to check ${channel.name} for threads that need reposting...`, COLORS.YELLOW));
    
            try {
                const threadsPromise = manager.fetchAndFilterThreads(channel, thread => manager.needsRepost(thread));
                const timeoutPromise = new Promise<ThreadChannel[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Fetching threads timed out')), timeoutDuration)
                );
    
                const threads = await Promise.race([threadsPromise, timeoutPromise]);
    
                console.log(`[${channel.name}] Found ${threads.length} threads over the age limit.`);
    
                const rows = await manager.getSpreadsheetData();
                const headers = rows[0];
                const guildNameIndex = headers.indexOf('Guild Name');
    
                if (guildNameIndex === -1) {
                    console.error('Required columns not found in Google Sheets data.');
                    return;
                }
    
                for (const thread of threads) {
                    if (hasTimeoutOccurred) break; // Exit loop if timeout has occurred
    
                    const row = rows.slice(1).find(r => r[guildNameIndex]?.trim() === thread.name.trim());
                    if (!row || manager.isEntryTooOld(row[headers.indexOf('Timestamp')])) continue;
    
                    try {
                        const repostPromise = manager.handleThreadReposting(channel, thread, row, headers);
                        const repostTimeoutPromise = new Promise<void>((_, reject) =>
                            setTimeout(() => reject(new Error('Reposting thread timed out')), timeoutDuration)
                        );
    
                        await Promise.race([repostPromise, repostTimeoutPromise]);
                        repostedCount++;
                        break; // Repost only the oldest thread
                    } catch (error) {
                        if (error instanceof Error) {
                            if (error.message.includes('Reposting thread timed out')) {
                                console.error('Reposting thread timed out due to rate limit. Stopping further reposts.');
                                hasTimeoutOccurred = true; // Flag timeout occurrence
                                break; // Exit loop if timeout occurs
                            } else if (error instanceof RateLimitError) {
                                const delay = getRateLimitDelay(error);
                                console.warn(`Rate limit error while reposting in ${channel.name}: ${error.message}`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Failed to repost thread: ${error.message}`);
                                continue; // Continue to the next thread if error persists
                            }
                        } else {
                            console.error(`An unknown error occurred: ${String(error)}`);
                        }
                    }
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
        let newPostsAdded = 0;
        let hasTimeoutOccurred = false;
    
        try {
            console.log(colorize('\n\nStarting to check for new entries to post...', COLORS.YELLOW));
    
            const rows = await this.getSpreadsheetData();
            const headers = rows[0];
            const factionIndex = headers.indexOf('Faction');
            const guildNameIndex = headers.indexOf('Guild Name');
            const timestampIndex = headers.indexOf('Timestamp');
    
            if (factionIndex === -1 || guildNameIndex === -1 || timestampIndex === -1) {
                console.error('Required columns not found in Google Sheets data.');
                return;
            }
    
            for (const row of rows.slice(1)) {
                if (hasTimeoutOccurred) break; // Exit loop if timeout has occurred
    
                const threadName = row[guildNameIndex]?.trim();
                const faction = row[factionIndex]?.trim();
                const timestamp = row[timestampIndex]?.trim();
    
                if (!threadName || this.isEntryTooOld(timestamp)) continue;
    
                const targetChannel = faction === 'Alliance' ? allianceChannel : faction === 'Horde' ? hordeChannel : null;
                if (!targetChannel) continue;
    
                const existingThreads = await this.fetchAndFilterThreads(targetChannel, thread => thread.name.trim() === threadName.trim());
    
                if (existingThreads.length === 0) {
                    const messageOptions = await this.generateMessageContent(headers, row);
    
                    try {
                        const threadCreationPromise = this.createGuildRecruitmentThread(targetChannel, threadName, messageOptions);
                        const timeoutPromise = new Promise<ThreadChannel>((_, reject) =>
                            setTimeout(() => reject(new Error('Thread creation timed out')), 10000)
                        );
    
                        const thread = await Promise.race([threadCreationPromise, timeoutPromise]);
    
                        console.log(colorize(`[${targetChannel.name}] Added new thread: ${threadName}`, COLORS.GREEN));
                        newPostsAdded++;
                    } catch (error) {
                        if (error instanceof Error) {
                            if (error.message.includes('Thread creation timed out')) {
                                console.error('Thread creation timed out due to rate limit. Stopping further posts.');
                                hasTimeoutOccurred = true; // Flag timeout occurrence
                                break; // Exit loop if timeout occurs
                            } else if (error instanceof RateLimitError) {
                                const delay = getRateLimitDelay(error);
                                console.warn(`Rate limit error while posting new entry in ${targetChannel.name}: ${error.message}`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Failed to create thread due to error: ${error.message}`);
                                continue; // Continue to the next row if error persists
                            }
                        } else {
                            console.error(`An unknown error occurred: ${String(error)}`);
                        }
                    }
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
