const express = require('express');
const cron = require('node-cron');
const database = require('./db');
const walletManager = require('./wallet');
const telegramBot = require('./bot');
require('dotenv').config();

class TRC20WalletServer {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.sweepStats = {
            totalSwept: 0,
            lastSweepTime: null,
            sweepCount: 0,
            errors: 0
        };

        this.setupMiddleware();
        this.setupRoutes();
        this.setupAutoSweep();
        this.startServer();
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // Basic security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        });

        // Request logging
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/', (req, res) => {
            res.json({
                status: 'online',
                service: 'TRC20 Wallet Bot',
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        // System status endpoint
        this.app.get('/status', async (req, res) => {
            try {
                const systemStats = await database.getSystemStats();
                const masterWalletStats = await database.getMasterWalletStats();
                const networkStatus = await walletManager.getNetworkStatus();

                res.json({
                    status: 'healthy',
                    database: {
                        connected: true,
                        stats: systemStats
                    },
                    wallet: {
                        network: networkStatus,
                        master: masterWalletStats
                    },
                    sweep: this.sweepStats,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                res.status(500).json({
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // Generate address endpoint (for API access)
        this.app.post('/api/generate-address', async (req, res) => {
            try {
                const { userId, label } = req.body;
                
                if (!userId) {
                    return res.status(400).json({ error: 'User ID required' });
                }

                // Get or create user
                let user = await database.getUserByTelegramId(userId);
                if (!user) {
                    await database.createUser(userId);
                    user = await database.getUserByTelegramId(userId);
                }

                // Generate new address
                const userAddresses = await database.getUserAddresses(user.id);
                const derivationIndex = userAddresses.length;

                const walletData = walletManager.generateHDWallet(derivationIndex);
                const encryptedPrivateKey = walletManager.encryptPrivateKey(walletData.privateKey);

                await database.createAddress(
                    user.id,
                    walletData.address,
                    encryptedPrivateKey,
                    derivationIndex,
                    label || `Address ${derivationIndex + 1}`
                );

                res.json({
                    success: true,
                    address: walletData.address,
                    derivationIndex,
                    label: label || `Address ${derivationIndex + 1}`,
                    timestamp: new Date().toISOString()
                });

            } catch (error) {
                console.error('Error in generate-address API:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Balance check endpoint
        this.app.get('/api/balance/:userId', async (req, res) => {
            try {
                const { userId } = req.params;
                
                const user = await database.getUserByTelegramId(userId);
                if (!user) {
                    return res.status(404).json({ error: 'User not found' });
                }

                const addresses = await database.getUserAddresses(user.id);
                const masterWalletInfo = await walletManager.getAccountInfo(process.env.MASTER_ADDRESS);
                
                let totalTRX = 0;
                let totalUSDT = 0;
                let addressBalances = [];

                for (const addr of addresses) {
                    const balanceInfo = await walletManager.getAccountInfo(addr.address);
                    totalTRX += balanceInfo.trxBalance;
                    totalUSDT += balanceInfo.usdtBalance;

                    addressBalances.push({
                        address: addr.address,
                        label: addr.label,
                        trxBalance: balanceInfo.trxBalance,
                        usdtBalance: balanceInfo.usdtBalance
                    });
                }

                res.json({
                    success: true,
                    masterWallet: masterWalletInfo,
                    generatedAddresses: {
                        count: addresses.length,
                        totalTRX,
                        totalUSDT,
                        addresses: addressBalances
                    },
                    totalPortfolio: {
                        trx: masterWalletInfo.trxBalance + totalTRX,
                        usdt: masterWalletInfo.usdtBalance + totalUSDT
                    },
                    timestamp: new Date().toISOString()
                });

            } catch (error) {
                console.error('Error in balance API:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Manual sweep endpoint (admin only)
        this.app.post('/api/sweep', async (req, res) => {
            try {
                const { adminKey } = req.body;
                
                if (adminKey !== process.env.ADMIN_API_KEY) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }

                console.log('🔄 Manual sweep initiated via API');
                const result = await this.performSweep();
                
                res.json({
                    success: true,
                    result,
                    timestamp: new Date().toISOString()
                });

            } catch (error) {
                console.error('Error in manual sweep:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Webhook endpoint for external notifications
        this.app.post('/webhook/transaction', async (req, res) => {
            try {
                const { txHash, address, amount, type } = req.body;
                
                // Verify webhook authenticity if needed
                // const signature = req.headers['x-signature'];
                
                console.log('📥 Webhook received:', { txHash, address, amount, type });
                
                // Process webhook data and notify user if needed
                // Implementation depends on your webhook provider
                
                res.json({ success: true, received: true });
                
            } catch (error) {
                console.error('Webhook error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                timestamp: new Date().toISOString()
            });
        });

        // Error handler
        this.app.use((error, req, res, next) => {
            console.error('Express error:', error);
            res.status(500).json({
                error: 'Internal server error',
                timestamp: new Date().toISOString()
            });
        });
    }

    setupAutoSweep() {
        const sweepInterval = process.env.SWEEP_INTERVAL_MINUTES || 5;
        console.log(`⏰ Auto-sweep scheduled every ${sweepInterval} minutes`);

        // Run sweep every X minutes
        cron.schedule(`*/${sweepInterval} * * * *`, async () => {
            await this.performSweep();
        });

        // Daily stats report (optional)
        cron.schedule('0 0 * * *', async () => {
            await this.sendDailyReport();
        });

        // Cleanup old transactions (weekly)
        cron.schedule('0 0 * * 0', async () => {
            await this.cleanupOldData();
        });
    }

    async performSweep() {
        try {
            console.log('🔄 Starting auto-sweep process...');
            const startTime = Date.now();

            // Get all active addresses
            const addresses = await database.getAllActiveAddresses();
            console.log(`📊 Checking ${addresses.length} addresses for sweep...`);

            let totalSweptAmount = 0;
            let sweepTransactions = [];
            let errorCount = 0;

            for (const address of addresses) {
                try {
                    // Check if address has sufficient balance to sweep
                    const accountInfo = await walletManager.getAccountInfo(address.address);
                    
                    if (accountInfo.usdtBalance >= parseFloat(process.env.MIN_SWEEP_AMOUNT || 1)) {
                        console.log(`💰 Sweeping ${accountInfo.usdtBalance} USDT from ${address.address}`);
                        
                        // Perform sweep
                        const sweepResult = await walletManager.sweepToMasterWallet(address);
                        
                        if (sweepResult.transactions.length > 0) {
                            totalSweptAmount += sweepResult.totalSwept;
                            sweepTransactions.push(...sweepResult.transactions);

                            // Record transactions in database
                            for (const tx of sweepResult.transactions) {
                                await database.createTransaction(
                                    address.id,
                                    tx.txHash,
                                    address.address,
                                    process.env.MASTER_ADDRESS,
                                    tx.amount,
                                    tx.type === 'USDT' ? process.env.USDT_CONTRACT_ADDRESS : null,
                                    'sweep',
                                    tx.status
                                );
                            }

                            // Notify user about sweep
                            const user = await database.getUserByTelegramId(address.user_id);
                            if (user) {
                                await telegramBot.sendNotification(
                                    user.telegram_id,
                                    `✅ Auto-sweep completed!\n\n💰 Amount: ${sweepResult.totalSwept.toFixed(6)} tokens\n📍 From: ${address.address.substring(0, 10)}...\n🏦 To: Master Wallet\n\n🔗 Transactions: ${sweepResult.transactions.length}`,
                                    { parse_mode: 'Markdown' }
                                );
                            }
                        }
                    }

                    // Small delay to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (error) {
                    console.error(`❌ Error sweeping address ${address.address}:`, error);
                    errorCount++;
                }
            }

            // Update sweep stats
            this.sweepStats = {
                totalSwept: this.sweepStats.totalSwept + totalSweptAmount,
                lastSweepTime: new Date().toISOString(),
                sweepCount: this.sweepStats.sweepCount + 1,
                errors: this.sweepStats.errors + errorCount
            };

            const endTime = Date.now();
            const duration = (endTime - startTime) / 1000;

            console.log(`✅ Sweep completed in ${duration}s`);
            console.log(`📊 Swept ${totalSweptAmount.toFixed(6)} tokens in ${sweepTransactions.length} transactions`);
            console.log(`❌ Errors: ${errorCount}`);

            return {
                success: true,
                addressesChecked: addresses.length,
                totalSwept: totalSweptAmount,
                transactionCount: sweepTransactions.length,
                errors: errorCount,
                duration: duration
            };

        } catch (error) {
            console.error('❌ Critical error in sweep process:', error);
            this.sweepStats.errors++;
            throw error;
        }
    }

    async sendDailyReport() {
        try {
            console.log('📊 Generating daily report...');
            
            const stats = await database.getSystemStats();
            const masterWalletStats = await database.getMasterWalletStats();
            
            const reportMessage = `
📊 *Daily Report - ${new Date().toLocaleDateString()}*

*System Statistics:*
• Users: ${stats.totalUsers}
• Addresses: ${stats.totalAddresses} 
• Transactions: ${stats.totalTransactions}
• Total Balance: ${stats.totalBalance.toFixed(6)} USDT

*Sweep Statistics:*
• Total Swept: ${this.sweepStats.totalSwept.toFixed(6)} tokens
• Sweep Count: ${this.sweepStats.sweepCount}
• Errors: ${this.sweepStats.errors}
• Last Sweep: ${this.sweepStats.lastSweepTime}

*Master Wallet:*
• Balance: ${masterWalletStats?.current_balance || 0} USDT
• Total Received: ${masterWalletStats?.total_received || 0} USDT

System is running smoothly! 🚀
            `;

            // Send to admin users
            if (process.env.ADMIN_IDS) {
                const adminIds = process.env.ADMIN_IDS.split(',');
                for (const adminId of adminIds) {
                    await telegramBot.sendNotification(
                        parseInt(adminId),
                        reportMessage,
                        { parse_mode: 'Markdown' }
                    );
                }
            }

        } catch (error) {
            console.error('Error sending daily report:', error);
        }
    }

    async cleanupOldData() {
        try {
            console.log('🧹 Cleaning up old data...');
            
            // Cleanup old transactions (older than 90 days)
            const connection = await database.getConnection();
            const [result] = await connection.execute(
                'DELETE FROM transactions WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY) AND status = "confirmed"'
            );
            connection.release();
            
            console.log(`🗑️ Cleaned up ${result.affectedRows} old transactions`);
            
        } catch (error) {
            console.error('Error cleaning up data:', error);
        }
    }

    startServer() {
        this.app.listen(this.port, () => {
            console.log('🚀 TRC20 Wallet Bot Server Started');
            console.log(`📡 Server running on port ${this.port}`);
            console.log(`🔗 Health check: http://localhost:${this.port}`);
            console.log(`📊 Status endpoint: http://localhost:${this.port}/status`);
            console.log(`🏦 Master Wallet: ${process.env.MASTER_ADDRESS}`);
            console.log(`🤖 Telegram Bot: Active`);
            console.log(`⏰ Auto-sweep: Every ${process.env.SWEEP_INTERVAL_MINUTES || 5} minutes`);
            console.log('=' .repeat(50));
        });

        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down gracefully...');
            await database.close();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            console.log('\n🛑 SIGTERM received, shutting down...');
            await database.close();
            process.exit(0);
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        });
    }

    // Public method to get server stats
    getStats() {
        return {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            sweep: this.sweepStats,
            timestamp: new Date().toISOString()
        };
    }
}

// Initialize and start the server
console.log('🚀 Initializing TRC20 Wallet Bot...');
console.log('📦 Loading dependencies...');
console.log('🔧 Setting up components...');

const server = new TRC20WalletServer();

// Export for testing or external access
module.exports = server;
