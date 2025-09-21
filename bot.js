const TelegramBot = require('node-telegram-bot-api');
const database = require('./db');
const walletManager = require('./wallet');
require('dotenv').config();

class TelegramBotHandler {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        this.adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
        this.userSessions = new Map(); // Rate limiting and session management
        
        this.setupBotHandlers();
        this.setupErrorHandling();
        console.log('🤖 Telegram bot initialized');
    }

    setupBotHandlers() {
        // Start command
        this.bot.onText(/\/start/, async (msg) => {
            await this.handleStart(msg);
        });

        // Generate new address
        this.bot.onText(/\/generate/, async (msg) => {
            await this.handleGenerate(msg);
        });

        // Check balance
        this.bot.onText(/\/balance/, async (msg) => {
            await this.handleBalance(msg);
        });

        // Transaction history
        this.bot.onText(/\/history/, async (msg) => {
            await this.handleHistory(msg);
        });

        // Admin commands
        this.bot.onText(/\/admin/, async (msg) => {
            await this.handleAdmin(msg);
        });

        // Help command
        this.bot.onText(/\/help/, async (msg) => {
            await this.handleHelp(msg);
        });

        // Address list
        this.bot.onText(/\/addresses/, async (msg) => {
            await this.handleAddresses(msg);
        });

        // Callback query handler for inline keyboards
        this.bot.on('callback_query', async (callbackQuery) => {
            await this.handleCallbackQuery(callbackQuery);
        });
    }

    setupErrorHandling() {
        this.bot.on('polling_error', (error) => {
            console.error('❌ Telegram polling error:', error);
        });

        this.bot.on('error', (error) => {
            console.error('❌ Telegram bot error:', error);
        });
    }

    // Rate limiting
    isRateLimited(userId) {
        const userSession = this.userSessions.get(userId);
        if (!userSession) {
            this.userSessions.set(userId, { lastCommand: Date.now(), commandCount: 1 });
            return false;
        }

        const now = Date.now();
        const timeDiff = now - userSession.lastCommand;

        // Reset count if more than 1 minute passed
        if (timeDiff > 60000) {
            userSession.commandCount = 1;
            userSession.lastCommand = now;
            return false;
        }

        // Allow max 10 commands per minute
        if (userSession.commandCount >= 10) {
            return true;
        }

        userSession.commandCount++;
        userSession.lastCommand = now;
        return false;
    }

    // Start command handler
    async handleStart(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            if (this.isRateLimited(userId)) {
                await this.bot.sendMessage(chatId, '⏱️ Please wait a moment before sending another command.');
                return;
            }

            // Create or get user
            await database.createUser(userId, {
                username: msg.from.username,
                first_name: msg.from.first_name,
                last_name: msg.from.last_name
            });

            const welcomeMessage = `
🎉 *Welcome to TRC20 Wallet Bot!*

I can help you manage TRC20 tokens (USDT) on the TRON network.

*Available Commands:*
🏦 /generate - Generate new wallet address
💰 /balance - Check your balances
📊 /addresses - View all your addresses
📋 /history - Transaction history
ℹ️ /help - Show this help message

*Features:*
✅ Unlimited address generation
✅ Auto-sweep to master wallet
✅ Real-time balance tracking
✅ Secure private key encryption
✅ Transaction history

Start by generating your first address with /generate
            `;

            await this.bot.sendMessage(chatId, welcomeMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏦 Generate Address', callback_data: 'generate' }],
                        [{ text: '💰 Check Balance', callback_data: 'balance' }],
                        [{ text: '📊 My Addresses', callback_data: 'addresses' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error in start handler:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
        }
    }

    // Generate address handler
    async handleGenerate(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            if (this.isRateLimited(userId)) {
                await this.bot.sendMessage(chatId, '⏱️ Please wait a moment before generating another address.');
                return;
            }

            // Show loading message
            const loadingMessage = await this.bot.sendMessage(chatId, '⏳ Generating new address...');

            // Get user from database
            const user = await database.getUserByTelegramId(userId);
            if (!user) {
                await database.createUser(userId, {
                    username: msg.from.username,
                    first_name: msg.from.first_name,
                    last_name: msg.from.last_name
                });
            }

            // Get next derivation index
            const userAddresses = await database.getUserAddresses(user?.id || userId);
            const derivationIndex = userAddresses.length;

            // Generate new HD wallet address
            const walletData = walletManager.generateHDWallet(derivationIndex);
            const encryptedPrivateKey = walletManager.encryptPrivateKey(walletData.privateKey);

            // Save to database
            await database.createAddress(
                user?.id || userId,
                walletData.address,
                encryptedPrivateKey,
                derivationIndex,
                `Address ${derivationIndex + 1}`
            );

            // Delete loading message
            await this.bot.deleteMessage(chatId, loadingMessage.message_id);

            const successMessage = `
✅ *New Address Generated!*

🏦 *Address:* \`${walletData.address}\`
🔢 *Index:* ${derivationIndex}
📱 *Label:* Address ${derivationIndex + 1}

⚡ *Important Notes:*
• Send USDT (TRC20) to this address
• Funds will auto-sweep to master wallet
• Keep small TRX balance for gas fees
• This address is permanently yours

*What's next?*
Send USDT to this address and it will automatically be swept to the master wallet within 5 minutes.
            `;

            await this.bot.sendMessage(chatId, successMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Copy Address', callback_data: `copy_${walletData.address}` }],
                        [{ text: '💰 Check Balance', callback_data: 'balance' }],
                        [{ text: '🏦 Generate Another', callback_data: 'generate' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error generating address:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Error generating address. Please try again.');
        }
    }

    // Balance handler
    async handleBalance(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            if (this.isRateLimited(userId)) {
                await this.bot.sendMessage(chatId, '⏱️ Please wait a moment before checking balance again.');
                return;
            }

            const loadingMessage = await this.bot.sendMessage(chatId, '⏳ Checking balances...');

            const user = await database.getUserByTelegramId(userId);
            if (!user) {
                await this.bot.editMessageText('❌ User not found. Please start with /start', {
                    chat_id: chatId,
                    message_id: loadingMessage.message_id
                });
                return;
            }

            const addresses = await database.getUserAddresses(user.id);
            if (addresses.length === 0) {
                await this.bot.editMessageText('📭 No addresses found. Generate your first address with /generate', {
                    chat_id: chatId,
                    message_id: loadingMessage.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🏦 Generate Address', callback_data: 'generate' }]]
                    }
                });
                return;
            }

            // Get master wallet balance
            const masterWalletInfo = await walletManager.getAccountInfo(process.env.MASTER_ADDRESS);
            
            let totalTRX = 0;
            let totalUSDT = 0;
            let addressBalances = [];

            // Check balance for each address
            for (const addr of addresses) {
                const balanceInfo = await walletManager.getAccountInfo(addr.address);
                totalTRX += balanceInfo.trxBalance;
                totalUSDT += balanceInfo.usdtBalance;

                if (balanceInfo.trxBalance > 0 || balanceInfo.usdtBalance > 0) {
                    addressBalances.push({
                        address: addr.address.substring(0, 6) + '...' + addr.address.substring(addr.address.length - 6),
                        label: addr.label,
                        trx: balanceInfo.trxBalance,
                        usdt: balanceInfo.usdtBalance
                    });
                }

                // Update database with latest balance
                await database.updateAddressBalance(addr.id, balanceInfo.usdtBalance);
            }

            let balanceMessage = `
💰 *Your Wallet Balances*

🏦 *Master Wallet:*
• TRX: ${masterWalletInfo.trxBalance.toFixed(6)} TRX
• USDT: ${masterWalletInfo.usdtBalance.toFixed(6)} USDT

📊 *Generated Addresses:*
• Total Addresses: ${addresses.length}
• TRX Balance: ${totalTRX.toFixed(6)} TRX
• USDT Balance: ${totalUSDT.toFixed(6)} USDT

💼 *Total Portfolio:*
• TRX: ${(masterWalletInfo.trxBalance + totalTRX).toFixed(6)} TRX
• USDT: ${(masterWalletInfo.usdtBalance + totalUSDT).toFixed(6)} USDT
            `;

            if (addressBalances.length > 0) {
                balanceMessage += '\n🔍 *Active Addresses:*\n';
                for (const bal of addressBalances.slice(0, 5)) {
                    balanceMessage += `• ${bal.address}: ${bal.usdt.toFixed(6)} USDT\n`;
                }
                if (addressBalances.length > 5) {
                    balanceMessage += `... and ${addressBalances.length - 5} more addresses`;
                }
            }

            await this.bot.editMessageText(balanceMessage, {
                chat_id: chatId,
                message_id: loadingMessage.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'balance' }],
                        [{ text: '📊 View Addresses', callback_data: 'addresses' }],
                        [{ text: '📋 History', callback_data: 'history' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error checking balance:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Error checking balance. Please try again.');
        }
    }

    // Addresses handler
    async handleAddresses(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            const user = await database.getUserByTelegramId(userId);
            if (!user) {
                await this.bot.sendMessage(chatId, '❌ User not found. Please start with /start');
                return;
            }

            const addresses = await database.getUserAddresses(user.id);
            if (addresses.length === 0) {
                await this.bot.sendMessage(chatId, '📭 No addresses found. Generate your first address with /generate', {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🏦 Generate Address', callback_data: 'generate' }]]
                    }
                });
                return;
            }

            let message = `📊 *Your Generated Addresses (${addresses.length})*\n\n`;
            
            for (let i = 0; i < Math.min(addresses.length, 10); i++) {
                const addr = addresses[i];
                const shortAddress = addr.address.substring(0, 8) + '...' + addr.address.substring(addr.address.length - 8);
                const balanceInfo = await walletManager.getAccountInfo(addr.address);
                
                message += `${i + 1}. *${addr.label || 'Address ' + (i + 1)}*\n`;
                message += `   📍 \`${shortAddress}\`\n`;
                message += `   💰 ${balanceInfo.usdtBalance.toFixed(6)} USDT\n`;
                message += `   ⚡ ${balanceInfo.trxBalance.toFixed(6)} TRX\n\n`;
            }

            if (addresses.length > 10) {
                message += `... and ${addresses.length - 10} more addresses`;
            }

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏦 Generate New', callback_data: 'generate' }],
                        [{ text: '💰 Check Balance', callback_data: 'balance' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error getting addresses:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Error getting addresses. Please try again.');
        }
    }

    // History handler
    async handleHistory(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            const user = await database.getUserByTelegramId(userId);
            if (!user) {
                await this.bot.sendMessage(chatId, '❌ User not found. Please start with /start');
                return;
            }

            const transactions = await database.getTransactionsByUser(user.id, 20);
            if (transactions.length === 0) {
                await this.bot.sendMessage(chatId, '📋 No transactions found yet.');
                return;
            }

            let message = `📋 *Recent Transactions (${transactions.length})*\n\n`;

            for (let i = 0; i < Math.min(transactions.length, 10); i++) {
                const tx = transactions[i];
                const shortHash = tx.tx_hash.substring(0, 10) + '...';
                const statusEmoji = tx.status === 'confirmed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
                const typeEmoji = tx.tx_type === 'deposit' ? '📥' : tx.tx_type === 'sweep' ? '📤' : '💸';
                
                message += `${typeEmoji} *${tx.tx_type.toUpperCase()}* ${statusEmoji}\n`;
                message += `   🔗 \`${shortHash}\`\n`;
                message += `   💰 ${tx.amount} ${tx.token_contract ? 'USDT' : 'TRX'}\n`;
                message += `   📅 ${new Date(tx.timestamp).toLocaleDateString()}\n\n`;
            }

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'history' }],
                        [{ text: '💰 Check Balance', callback_data: 'balance' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error getting history:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Error getting transaction history.');
        }
    }

    // Admin handler
    async handleAdmin(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            if (!this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
                return;
            }

            const stats = await database.getSystemStats();
            const masterWalletStats = await database.getMasterWalletStats();
            const networkStatus = await walletManager.getNetworkStatus();

            const adminMessage = `
🛠️ *Admin Dashboard*

📊 *System Statistics:*
• Total Users: ${stats.totalUsers}
• Total Addresses: ${stats.totalAddresses}
• Total Transactions: ${stats.totalTransactions}
• Total Balance: ${stats.totalBalance.toFixed(6)} USDT

🏦 *Master Wallet:*
• Balance: ${masterWalletStats?.current_balance || 0} USDT
• Total Received: ${masterWalletStats?.total_received || 0} USDT

🌐 *Network Status:*
• Status: ${networkStatus.status}
• Block: ${networkStatus.blockNumber || 'N/A'}

⏱️ *Last Updated:* ${new Date().toLocaleString()}
            `;

            await this.bot.sendMessage(chatId, adminMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh Stats', callback_data: 'admin_refresh' }],
                        [{ text: '📊 Detailed Report', callback_data: 'admin_report' }]
                    ]
                }
            });

        } catch (error) {
            console.error('Error in admin handler:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Error getting admin info.');
        }
    }

    // Help handler
    async handleHelp(msg) {
        const helpMessage = `
ℹ️ *TRC20 Wallet Bot Help*

*Available Commands:*
/start - Start the bot and show welcome message
/generate - Generate a new TRC20 address
/balance - Check all your balances
/addresses - View all your generated addresses
/history - View transaction history
/help - Show this help message

*How it works:*
1. Generate addresses with /generate
2. Send USDT (TRC20) to any generated address
3. Funds automatically sweep to master wallet
4. Check balances and history anytime

*Security Features:*
✅ Private keys are encrypted
✅ HD wallet for unlimited addresses
✅ Auto-sweep for security
✅ Rate limiting protection

*Support:*
If you encounter any issues, please contact the administrator.

*Powered by TRON Network*
        `;

        await this.bot.sendMessage(msg.chat.id, helpMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🏦 Generate Address', callback_data: 'generate' }],
                    [{ text: '💰 Check Balance', callback_data: 'balance' }]
                ]
            }
        });
    }

    // Callback query handler
    async handleCallbackQuery(callbackQuery) {
        try {
            const chatId = callbackQuery.message.chat.id;
            const messageId = callbackQuery.message.message_id;
            const data = callbackQuery.data;

            await this.bot.answerCallbackQuery(callbackQuery.id);

            // Handle different callback actions
            switch (data) {
                case 'generate':
                    await this.handleGenerate({ chat: { id: chatId }, from: callbackQuery.from });
                    break;
                case 'balance':
                    await this.handleBalance({ chat: { id: chatId }, from: callbackQuery.from });
                    break;
                case 'addresses':
                    await this.handleAddresses({ chat: { id: chatId }, from: callbackQuery.from });
                    break;
                case 'history':
                    await this.handleHistory({ chat: { id: chatId }, from: callbackQuery.from });
                    break;
                case 'admin_refresh':
                    await this.handleAdmin({ chat: { id: chatId }, from: callbackQuery.from });
                    break;
                default:
                    if (data.startsWith('copy_')) {
                        const address = data.replace('copy_', '');
                        await this.bot.sendMessage(chatId, `📋 Address copied:\n\`${address}\``, {
                            parse_mode: 'Markdown'
                        });
                    }
                    break;
            }

        } catch (error) {
            console.error('Error handling callback query:', error);
        }
    }

    // Send notification to user
    async sendNotification(userId, message, options = {}) {
        try {
            const user = await database.getUserByTelegramId(userId);
            if (user) {
                await this.bot.sendMessage(userId, message, options);
            }
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }

    // Broadcast message to all users
    async broadcast(message, options = {}) {
        try {
            // This would require getting all users from database
            // Implementation depends on your needs
            console.log('Broadcast message:', message);
        } catch (error) {
            console.error('Error broadcasting:', error);
        }
    }
}

// Export singleton instance
const telegramBot = new TelegramBotHandler();
module.exports = telegramBot;
