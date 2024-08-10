Guild Recruitment Bot
=====================

**Guild Recruitment Bot** is a versatile Discord bot designed to automate and manage guild advertisements in your Discord channels. By leveraging data from Google Sheets, the bot ensures that advertisements are kept current and visible. It continuously monitors your Google Sheets for new entries, removes outdated advertisements, and re-posts older ones to maintain their visibility.

Features
--------
- **Automated Posting**: Posts guild advertisements to designated Discord channels using data from Google Sheets.
- **Continuous Monitoring**: Regularly checks for new entries, updates, and deletions in Google Sheets.
- **Dynamic Management**: Removes outdated posts and re-posts older advertisements to enhance visibility.
- **Configurable**: Easily set up with your Discord and Google Sheets credentials.

Installation
------------
### Prerequisites
Before setting up the bot, ensure you have the following:
- **Node.js**: Node.js must be installed on your system.
- **Discord Bot Token**: Obtain your Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications).
- **Google API Credentials**: Obtain your Google API credentials from the [Google Cloud Console](https://console.cloud.google.com/).

### Getting Started
1. **Clone the Repository**
   Clone the repository to your local machine:
git clone https://github.com/Nutrinoff/GuildRecruitmentBot

2. **Navigate to the Project Directory**

3. **Install Dependencies**
Install the required Node.js packages:

4. **Configure the Bot**
- **`config.txt`**: This file contains your Discord bot token, channel IDs, and other configuration details. Ensure it is placed in the same directory as `index.ts`.
- **`credentials.json`**: This file contains your Google API credentials. Ensure it is placed in the same directory as `index.ts`.

5. **Run the Bot**
Start the bot by running:
node dist/index.js
