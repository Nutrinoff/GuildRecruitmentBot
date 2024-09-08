import {
    Client,
    ForumChannel,
    ThreadChannel,
    MessageCreateOptions,
    GatewayIntentBits,
    RateLimitError,
    EmbedBuilder
} from 'discord.js';
import axios from 'axios';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import stringSimilarity from 'string-similarity';

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
    MAX_NEW_THREADS_PER_CYCLE: number;
}

const colorize = (text: string, colorCode: string): string => `\x1b[${colorCode}m${text}\x1b[0m`;

const classEmotes: { [key: string]: string } = {
    '[Warrior]': '<:wa_i:1281118860514164759>',
    '[Mage]': '<:ma_i:1281118847151247424>',
    '[Warlock]': '<:wl_i:1281118899232051241>',
    '[Hunter]': '<:hu_i:1281118845460807690>',
    '[Rogue]': '<:ro_i:1281118853887295498>',
    '[Druid]': '<:dr_i:1281118706424090654>',
    '[Priest]': '<:pr_i:1281118852440133666>',
    '[Paladin]': '<:pa_i:1281118849793659043>',
    '[Shaman]': '<:sh_i:1281118855401574410>',
    '[Monk]': '<:mo_i:1281118848598413414>',
    '[Evoker]': '<:ev_i:1281118844001452086>',
    '[Demon Hunter]': '<:dh_i:1281118841027563550>',
    '[Death Knight]': '<:dk_i:1281118842512478319>'
};

const roleEmotes: { [key: string]: string } = {
    'Tank': '<:t_i:1275165468164096192>',
    'Healer': '<:h_i:1275165466872250388>',
    'DPSMelee': '<:md_i:1275165464086970409>',
    'DPSRanged': '<:rd_i:1275165465374752860>'
};

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
    private postedWarnings: Set<string> = new Set();

    constructor(
        private client: Client,
        private allianceChannelId: string,
        private hordeChannelId: string,
        private modChannelId: string,  // Accept modChannelId in the constructor
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

    public updateChannels(allianceChannelId: string, hordeChannelId: string, modChannelId : string) {
        this.allianceChannelId = allianceChannelId;
        this.hordeChannelId = hordeChannelId;
        this.modChannelId = modChannelId;  // Initialize it here

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
            // Make a HEAD request to get the content type
            const headResponse = await axios.head(url);
            
            // Check if the content type is an image
            const contentType = headResponse.headers['content-type'];
            if (!contentType || !contentType.startsWith('image/')) {
                console.error(`URL ${url} does not point to an image. Content-Type: ${contentType}`);
                return null;
            }
            
            // Determine the correct extension if necessary
            // Assuming content-type has valid information
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
        return createdAt ? DateTime.now().diff(DateTime.fromJSDate(createdAt), 'hours').hours : -1;
    }

    private needsRepost(thread: ThreadChannel): boolean {
        return this.getThreadAge(thread) >= this.config.THREAD_AGE_LIMIT_HOURS;
    }

    private isEntryTooOld(timestamp: string): boolean {
        const entryDate = DateTime.fromFormat(timestamp, 'MM/dd/yyyy HH:mm:ss');
        return DateTime.now().diff(entryDate, 'days').days > this.config.MAX_ENTRY_AGE_DAYS;
    }

    private findSimilarThreads(threads: ThreadChannel[], similarityThreshold: number = 0.6): Map<string, ThreadChannel[]> {
        const threadTitles = threads.map(thread => thread.name.trim().toLowerCase());
        const similarThreadsMap = new Map<string, ThreadChannel[]>();
    
        for (let i = 0; i < threadTitles.length; i++) {
            for (let j = i + 1; j < threadTitles.length; j++) {
                const similarity = stringSimilarity.compareTwoStrings(threadTitles[i], threadTitles[j]);
    
                // Log similarity scores for debugging
                //console.log(`\nComparing "${threadTitles[i]}" with "${threadTitles[j]}": Similarity = ${similarity}`);
    
                if (similarity >= similarityThreshold) {
                    if (!similarThreadsMap.has(threadTitles[i])) {
                        similarThreadsMap.set(threadTitles[i], []);
                    }
                    similarThreadsMap.get(threadTitles[i])!.push(threads[j]);
                }
            }
        }
        return similarThreadsMap;
    }

    public async checkAndPostSimilarThreads(channel: ForumChannel) {
        console.log(`\nChecking for similar threads in ${channel.name}...`);
    
        // Fetch active threads from the forum channel
        const threads = await channel.threads.fetchActive();
        const threadList = Array.from(threads.threads.values());
    
        // Find similar threads
        const similarThreadsMap = this.findSimilarThreads(threadList, 0.8);
    
        // Fetch the mod channel
        const modChannel = await this.client.channels.fetch(this.modChannelId);
        if (!modChannel || !(modChannel instanceof ForumChannel)) {
            console.error(`Failed to fetch the mod channel or it's not a forum channel`);
            return;
        }
    
        // Fetch existing threads in the mod channel
        const existingModThreads = await modChannel.threads.fetchActive();
        const existingModThreadsArray = Array.from(existingModThreads.threads.values());
    
        // Process each set of similar threads
        for (const [originalTitle, similarThreads] of similarThreadsMap) {
            // Collect all guild names from similar threads
            const guildNames = new Set<string>();
            similarThreads.forEach(thread => {
                const guildName = this.extractGuildNameFromThreadName(thread.name).toLowerCase();
                guildNames.add(guildName);
            });
    
            // Check if any guild name is present in existing threads
            const shouldPost = !await Promise.all(existingModThreadsArray.map(async thread => {
                const threadTitle = thread.name.toLowerCase();
                const messages = await thread.messages.fetch();
                const threadMessages = messages.map(msg => msg.content.toLowerCase());
    
                // Check if any guild name is present in the thread title or content
                return Array.from(guildNames).some(guildName =>
                    threadTitle.includes(guildName) || threadMessages.some(content => content.includes(guildName))
                );
            })).then(results => results.some(hasGuildName => hasGuildName));
    
            if (shouldPost) {
                // Construct the message content with the similar thread names
                let messageContent = `⚠️ **Potentially Similar Guild Names Found for: ${originalTitle}**\n\n`;
                similarThreads.forEach(thread => {
                    messageContent += ` - ${thread.name} (ID: ${thread.id})\n`;
                });
    
                // Create a new thread title with the original title and a timestamp
                const threadTitle = `Similar Guild Names - ${originalTitle} - ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`;
    
                try {
                    // Create a new thread in the mod channel
                    const createdThread = await modChannel.threads.create({
                        name: threadTitle,
                        autoArchiveDuration: 60, // Set the auto-archive duration as needed
                        reason: 'Similar guild names detected',
                        message: { content: messageContent },
                    });
    
                    console.log(`\nPosted similar thread names to mod channel in thread: ${createdThread.name}.`);
                } catch (error) {
                    console.error(`\nFailed to create thread in mod channel: ${error}`);
                }
            } else {
                console.log(`\nA thread with similar content already exists in the mod channel.`);
            }
        }
    }
    
    private extractGuildNameFromThreadName(name: string): string {
        // Simplified extraction logic: Return the part of the name that is considered the guild name
        return name.split(' - ')[0].trim(); // Adjust based on actual thread naming conventions
    }

    public async removeUnmatchedThreads(channel: ForumChannel) {
        try {
            console.log(colorize(`\n\nStarting to check ${channel.name} for threads without Google Sheet...`, COLORS.YELLOW));
            const threads = await channel.threads.fetchActive();
            const existingThreadNames = Array.from(threads.threads.values()).map(thread => thread.name.trim().toLowerCase());
    
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
    
            // Adjust logic: Check if any guild name is contained within the thread title
            const threadsToDelete = Array.from(threads.threads.values()).filter(thread => {
                const threadName = thread.name.trim().toLowerCase();
                const matchingGuildEntry = Array.from(sheetEntries.keys()).find(guildName => threadName.includes(guildName));
                
                // If no matching entry or the entry is too old, mark for deletion
                const isOld = matchingGuildEntry ? this.isEntryTooOld(sheetEntries.get(matchingGuildEntry) || '') : true;
                return !matchingGuildEntry || isOld;
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

    private async createGuildRecruitmentThread(channel: ForumChannel, guildName: string, guildScope: string, messageOptions: MessageCreateOptions) {
        const timeoutDuration = 15000; // Timeout duration in milliseconds (15 seconds)
    
        try {
            // Sanitize the title with both guild name and guild scope
            const sanitizedTitle = this.sanitizeTitle(guildName, guildScope);
    
            const threadCreationPromise = channel.threads.create({
                name: sanitizedTitle || 'No Title',
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
    
    private sanitizeTitle(guildName: string, guildScope: string): string {
        // Define a regex that allows alphanumeric characters, spaces, hyphens, and accented characters
        const allowedCharactersRegex = /[^\p{L}\p{N}\s\-]/gu;
    
        const cleanedGuildName = guildName
            .replace(allowedCharactersRegex, '') // Allow alphanumeric, spaces, hyphens, and accented characters
            .trim();
        
        const cleanedGuildScope = guildScope
            .replace(allowedCharactersRegex, '') // Allow alphanumeric, spaces, hyphens, and accented characters
            .trim();
        
        // Combine the cleaned name and scope into the desired format
        return `<${cleanedGuildName}> - ${cleanedGuildScope}`;
    }  
    
    private async generateMessageContent(headers: string[], row: string[]): Promise<MessageCreateOptions> {
        const files: { attachment: Buffer; name: string }[] = [];
        const imageColumnIndex = this.getImageColumnIndex(headers);
    
        // Create the EmbedBuilder instance
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Guild Details')
            .setTimestamp();
    
        let emoteRows: string[] = [];
        let otherFields: { name: string, value: string, inline: boolean }[] = [];
        let discordLink: string | null = null;
        let discordContact: string | null = null;
    
        for (let j = 1; j < row.length; j++) {
            const key = headers[j].trim();
            let value = row[j]?.trim();
    
            // Skip excluded columns
            if (key.toLowerCase().includes('guild logo') || key.includes(this.config.EXCLUDED_COLUMN_HEADER)) {
                continue;
            }
    
            if (value && key.startsWith('[') && key.endsWith(']')) {
                // Process emote rows
                const classEmote = classEmotes[key] || key;
                const roles = value.split(',').map(role => role.trim());
                const roleEmotesString = roles.map(role => roleEmotes[role] || role).join(' ');
                const classRoleLine = `${classEmote} ${roleEmotesString}`;
    
                emoteRows.push(classRoleLine);
            } else {
                // Process other fields
                if (value.length > 1024) {
                    value = value.slice(0, 1024) + '...'; // Truncate long values
                }
                if (key.length <= 256 && value.length <= 1024) {
                    if (key.toLowerCase().includes('discord link')) {
                        discordLink = value;
                    } else if (key.toLowerCase().includes('discord contact')) {
                        discordContact = value;
                    } else {
                        otherFields.push({ name: key, value: value, inline: false });
                    }
                }
            }
        }
    
        // Add non-emote fields to the embed first if they have valid content
        otherFields.forEach(field => {
            if (field.name && field.value) {
                embed.addFields(field);
            }
        });
    
        // Add each row of emotes as a separate field
        emoteRows.forEach(row => {
            if (row.length > 0 && row.length <= 1024) {
                embed.addFields({ name: '\u200B', value: row, inline: false });
            } else {
                console.warn('Emote content exceeded the 1024 character limit or is empty and was not added to the embed.');
            }
        });
    
        // Add Discord Link and Discord Contact fields last, if they exist
        if (discordLink) {
            embed.addFields({ name: 'Discord Link', value: discordLink, inline: false });
        }
        if (discordContact) {
            embed.addFields({ name: 'Discord Contact', value: discordContact, inline: false });
        }
    
        // Handle image attachment if an image is available
        if (imageColumnIndex !== -1 && row[imageColumnIndex]?.match(/\.(png|jpg|jpeg)$/)) {
            const imageUrl = row[imageColumnIndex];
            try {
                const imageData = await this.fetchImage(imageUrl);
                if (imageData) {
                    files.push({ attachment: imageData, name: path.basename(imageUrl) });
                }
            } catch (error) {
                console.error(`Failed to fetch image from ${imageUrl}:`, error);
            }
        }
    
        return {
            content: '',
            embeds: [embed],
            files,
        };
    }
    
    private async handleThreadReposting(channel: ForumChannel, thread: ThreadChannel, row: string[], headers: string[]) {
        try {
            // Delete the old thread
            await thread.delete('Reposting new thread');
            console.log(`[${channel.name}] Deleted old thread for reposting: ${thread.name}`);
        
            // Generate new message content
            const messageOptions = await this.generateMessageContent(headers, row);
    
            // Get the index of the 'Guild Scope' column (formerly 'Guild Type')
            const guildScopeIndex = headers.indexOf('Guild Type'); // Update to 'Guild Type' if needed
    
            // Retrieve guild name and scope from the row data
            const guildName = row[headers.indexOf('Guild Name')]?.trim();
            const guildScope = guildScopeIndex !== -1 ? row[guildScopeIndex]?.trim() : 'Unknown';
    
            // Create the new thread with the correct arguments
            if (guildName) {
                await this.createGuildRecruitmentThread(channel, guildName, guildScope, messageOptions);
                console.log(colorize(`[${channel.name}] Reposted thread: ${guildName}`, COLORS.GREEN));
            } else {
                console.error('Guild Name is missing in the row data.');
            }
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
                // Fetch and filter threads that need reposting
                const threadsPromise = manager.fetchAndFilterThreads(channel, thread => manager.needsRepost(thread));
                const timeoutPromise = new Promise<ThreadChannel[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Fetching threads timed out')), timeoutDuration)
                );
    
                // Race the promises and get the threads
                let threads = await Promise.race([threadsPromise, timeoutPromise]);
    
                console.log(`[${channel.name}] Found ${threads.length} threads over the age limit.`);
    
                // Sort threads by their creation date (oldest first), accounting for null/undefined values
                threads = threads.sort((a, b) => {
                    const dateA = a.createdAt ? a.createdAt.getTime() : 0;
                    const dateB = b.createdAt ? b.createdAt.getTime() : 0;
                    return dateA - dateB;
                });
    
                // Get spreadsheet data
                const rows = await manager.getSpreadsheetData();
                const headers = rows[0];
                const guildNameIndex = headers.indexOf('Guild Name');
    
                if (guildNameIndex === -1) {
                    console.error('Required columns not found in Google Sheets data.');
                    return;
                }
    
                for (const thread of threads) {
                    if (hasTimeoutOccurred) break; // Exit loop if timeout has occurred
    
                    const threadNameLower = thread.name.trim().toLowerCase();
    
                    // Find the row where the guild name is contained within the thread name (case-insensitive)
                    const row = rows.slice(1).find(r => {
                        const guildName = r[guildNameIndex]?.trim().toLowerCase();
                        return guildName && threadNameLower.includes(guildName);
                    });
    
                    if (!row) {
                        console.log(`[DEBUG] No matching row found for thread ${thread.name}. Skipping.`);
                        continue;
                    }
    
                    if (manager.isEntryTooOld(row[headers.indexOf('Timestamp')])) {
                        console.log(`[DEBUG] Entry for thread ${thread.name} is too old. Skipping.`);
                        continue;
                    }
    
                    try {
                        // Try to repost the thread
                        const repostPromise = manager.handleThreadReposting(channel, thread, row, headers);
                        const repostTimeoutPromise = new Promise<void>((_, reject) =>
                            setTimeout(() => reject(new Error('Reposting thread timed out')), timeoutDuration)
                        );
    
                        // Race the reposting promise with a timeout
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
    
        // Reposting for both channels
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
            const guildScopeIndex = headers.indexOf('Guild Type'); // Assuming this is the correct column header
    
            if (factionIndex === -1 || guildNameIndex === -1 || timestampIndex === -1 || guildScopeIndex === -1) {
                console.error('Required columns not found in Google Sheets data.');
                return;
            }
    
            // Fetch existing thread names from both channels
            const existingThreads = await Promise.all([
                this.fetchAndFilterThreads(allianceChannel, () => true),
                this.fetchAndFilterThreads(hordeChannel, () => true),
            ]);
    
            // Combine all thread names into one array and convert to lowercase for case-insensitive comparison
            const existingThreadNames = [
                ...existingThreads[0].map(thread => thread.name.trim().toLowerCase()),
                ...existingThreads[1].map(thread => thread.name.trim().toLowerCase())
            ];
    
            // Fetch the maximum number of new threads allowed per cycle from the config
            const maxNewThreads = this.config.MAX_NEW_THREADS_PER_CYCLE || 10;
    
            // First pass: Identify new guild names by checking if they are not contained in any existing thread title
            const newGuildNames = new Set<string>();
    
            for (const row of rows.slice(1)) {
                const guildName = row[guildNameIndex]?.trim();
    
                if (guildName) {
                    const guildNameLower = guildName.toLowerCase();
                    const threadExists = existingThreadNames.some(threadName => threadName.includes(guildNameLower));
                    
                    if (!threadExists) {
                        newGuildNames.add(guildName.trim());
                    }
                }
            }
    
            // If no new guild names found, exit early
            if (newGuildNames.size === 0) {
                console.log('No new guild names found.');
                return;
            }
    
            // Second pass: Process rows for new guild names and create threads if necessary
            for (const row of rows.slice(1)) {
                if (hasTimeoutOccurred || newPostsAdded >= maxNewThreads) break; // Exit loop if timeout or max posts reached
    
                const guildName = row[guildNameIndex]?.trim();
                const faction = row[factionIndex]?.trim();
                const timestamp = row[timestampIndex]?.trim();
                const guildScope = row[guildScopeIndex]?.trim(); // Get guildScope from row
    
                if (!guildName || !newGuildNames.has(guildName) || this.isEntryTooOld(timestamp)) continue;
    
                const targetChannel = faction === 'Alliance' ? allianceChannel : faction === 'Horde' ? hordeChannel : null;
                if (!targetChannel) continue;
    
                const messageOptions = await this.generateMessageContent(headers, row);
    
                try {
                    const threadCreationPromise = this.createGuildRecruitmentThread(targetChannel, guildName, guildScope, messageOptions);
                    const timeoutPromise = new Promise<ThreadChannel>((_, reject) =>
                        setTimeout(() => reject(new Error('Thread creation timed out')), 10000)
                    );
    
                    const thread = await Promise.race([threadCreationPromise, timeoutPromise]);
    
                    console.log(colorize(`[${targetChannel.name}] Added new thread: ${guildName}`, COLORS.GREEN));
                    newPostsAdded++;
    
                    // Stop creating new threads if we hit the limit for this cycle
                    if (newPostsAdded >= maxNewThreads) {
                        console.log(colorize(`Reached the limit of ${maxNewThreads} new threads for this cycle.`, COLORS.YELLOW));
                        break;
                    }
                } catch (error: unknown) {
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
                            console.error(error.stack); // Log the stack trace for debugging
                            continue; // Continue to the next row if error persists
                        }
                    } else {
                        console.error(`An unknown error occurred: ${String(error)}`);
                    }
                }
            }
    
            if (newPostsAdded === 0) {
                console.log('No new posts to add.');
            } else {
                console.log(`Total new posts added: ${newPostsAdded}`);
            }
        } catch (error: unknown) {
            console.error('Failed to post new entries due to an unexpected error.');
            if (error instanceof Error) {
                console.error(error.message); // Log the specific error message
                console.error(error.stack); // Log the stack trace for debugging
            } else {
                console.error(`An unknown error occurred: ${String(error)}`);
            }
        }
    }     
}
