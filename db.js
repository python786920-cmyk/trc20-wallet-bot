const mysql = require('mysql2/promise');
require('dotenv').config();

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

class Database {
    constructor() {
        this.pool = pool;
        this.initializeTables();
    }

    // Initialize database tables
    async initializeTables() {
        try {
            const connection = await this.pool.getConnection();
            
            // Users table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    telegram_id BIGINT UNIQUE NOT NULL,
                    username VARCHAR(255),
                    first_name VARCHAR(255),
                    last_name VARCHAR(255),
                    is_admin BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_telegram_id (telegram_id)
                )
            `);

            // Generated addresses table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS addresses (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    address VARCHAR(255) UNIQUE NOT NULL,
                    private_key_encrypted TEXT NOT NULL,
                    derivation_index INT NOT NULL,
                    label VARCHAR(255),
                    is_active BOOLEAN DEFAULT TRUE,
                    last_balance DECIMAL(20, 6) DEFAULT 0,
                    total_received DECIMAL(20, 6) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    INDEX idx_address (address),
                    INDEX idx_user_id (user_id),
                    INDEX idx_active (is_active)
                )
            `);

            // Transactions table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS transactions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    address_id INT NOT NULL,
                    tx_hash VARCHAR(255) UNIQUE NOT NULL,
                    from_address VARCHAR(255) NOT NULL,
                    to_address VARCHAR(255) NOT NULL,
                    amount DECIMAL(20, 6) NOT NULL,
                    token_contract VARCHAR(255),
                    tx_type ENUM('deposit', 'sweep', 'withdrawal') NOT NULL,
                    status ENUM('pending', 'confirmed', 'failed') DEFAULT 'pending',
                    block_number BIGINT,
                    gas_used INT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE CASCADE,
                    INDEX idx_tx_hash (tx_hash),
                    INDEX idx_address_id (address_id),
                    INDEX idx_status (status),
                    INDEX idx_timestamp (timestamp)
                )
            `);

            // Master wallet config table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS master_wallet (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    address VARCHAR(255) UNIQUE NOT NULL,
                    current_balance DECIMAL(20, 6) DEFAULT 0,
                    total_received DECIMAL(20, 6) DEFAULT 0,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // System settings table
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    setting_key VARCHAR(255) UNIQUE NOT NULL,
                    setting_value TEXT,
                    description TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            connection.release();
            console.log('✅ Database tables initialized successfully');

        } catch (error) {
            console.error('❌ Error initializing database:', error);
            throw error;
        }
    }

    // Get database connection
    async getConnection() {
        return await this.pool.getConnection();
    }

    // User operations
    async createUser(telegramId, userData = {}) {
        try {
            const [result] = await this.pool.execute(
                'INSERT INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), first_name = VALUES(first_name), last_name = VALUES(last_name)',
                [telegramId, userData.username || null, userData.first_name || null, userData.last_name || null]
            );
            return result.insertId;
        } catch (error) {
            console.error('Error creating user:', error);
            throw error;
        }
    }

    async getUserByTelegramId(telegramId) {
        try {
            const [rows] = await this.pool.execute(
                'SELECT * FROM users WHERE telegram_id = ?',
                [telegramId]
            );
            return rows[0] || null;
        } catch (error) {
            console.error('Error getting user:', error);
            throw error;
        }
    }

    // Address operations
    async createAddress(userId, address, encryptedPrivateKey, derivationIndex, label = null) {
        try {
            const [result] = await this.pool.execute(
                'INSERT INTO addresses (user_id, address, private_key_encrypted, derivation_index, label) VALUES (?, ?, ?, ?, ?)',
                [userId, address, encryptedPrivateKey, derivationIndex, label]
            );
            return result.insertId;
        } catch (error) {
            console.error('Error creating address:', error);
            throw error;
        }
    }

    async getUserAddresses(userId) {
        try {
            const [rows] = await this.pool.execute(
                'SELECT * FROM addresses WHERE user_id = ? AND is_active = TRUE ORDER BY created_at DESC',
                [userId]
            );
            return rows;
        } catch (error) {
            console.error('Error getting user addresses:', error);
            throw error;
        }
    }

    async getAllActiveAddresses() {
        try {
            const [rows] = await this.pool.execute(
                'SELECT * FROM addresses WHERE is_active = TRUE'
            );
            return rows;
        } catch (error) {
            console.error('Error getting active addresses:', error);
            throw error;
        }
    }

    async updateAddressBalance(addressId, balance, totalReceived = null) {
        try {
            const updateQuery = totalReceived !== null 
                ? 'UPDATE addresses SET last_balance = ?, total_received = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                : 'UPDATE addresses SET last_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            
            const params = totalReceived !== null 
                ? [balance, totalReceived, addressId]
                : [balance, addressId];

            await this.pool.execute(updateQuery, params);
        } catch (error) {
            console.error('Error updating address balance:', error);
            throw error;
        }
    }

    // Transaction operations
    async createTransaction(addressId, txHash, fromAddress, toAddress, amount, tokenContract, txType, status = 'pending') {
        try {
            const [result] = await this.pool.execute(
                'INSERT INTO transactions (address_id, tx_hash, from_address, to_address, amount, token_contract, tx_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [addressId, txHash, fromAddress, toAddress, amount, tokenContract, txType, status]
            );
            return result.insertId;
        } catch (error) {
            console.error('Error creating transaction:', error);
            throw error;
        }
    }

    async updateTransactionStatus(txHash, status, blockNumber = null, gasUsed = null) {
        try {
            const updateQuery = 'UPDATE transactions SET status = ?, block_number = ?, gas_used = ? WHERE tx_hash = ?';
            await this.pool.execute(updateQuery, [status, blockNumber, gasUsed, txHash]);
        } catch (error) {
            console.error('Error updating transaction status:', error);
            throw error;
        }
    }

    async getTransactionsByUser(userId, limit = 50) {
        try {
            const [rows] = await this.pool.execute(
                `SELECT t.*, a.address, a.label 
                 FROM transactions t 
                 JOIN addresses a ON t.address_id = a.id 
                 WHERE a.user_id = ? 
                 ORDER BY t.timestamp DESC 
                 LIMIT ?`,
                [userId, limit]
            );
            return rows;
        } catch (error) {
            console.error('Error getting user transactions:', error);
            throw error;
        }
    }

    // Master wallet operations
    async updateMasterWalletBalance(address, balance, totalReceived) {
        try {
            await this.pool.execute(
                'INSERT INTO master_wallet (address, current_balance, total_received) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_balance = VALUES(current_balance), total_received = VALUES(total_received), last_updated = CURRENT_TIMESTAMP',
                [address, balance, totalReceived]
            );
        } catch (error) {
            console.error('Error updating master wallet balance:', error);
            throw error;
        }
    }

    async getMasterWalletStats() {
        try {
            const [rows] = await this.pool.execute(
                'SELECT * FROM master_wallet LIMIT 1'
            );
            return rows[0] || null;
        } catch (error) {
            console.error('Error getting master wallet stats:', error);
            throw error;
        }
    }

    // System statistics
    async getSystemStats() {
        try {
            const [userCount] = await this.pool.execute('SELECT COUNT(*) as count FROM users');
            const [addressCount] = await this.pool.execute('SELECT COUNT(*) as count FROM addresses WHERE is_active = TRUE');
            const [transactionCount] = await this.pool.execute('SELECT COUNT(*) as count FROM transactions');
            const [totalBalance] = await this.pool.execute('SELECT SUM(last_balance) as total FROM addresses WHERE is_active = TRUE');

            return {
                totalUsers: userCount[0].count,
                totalAddresses: addressCount[0].count,
                totalTransactions: transactionCount[0].count,
                totalBalance: parseFloat(totalBalance[0].total) || 0
            };
        } catch (error) {
            console.error('Error getting system stats:', error);
            throw error;
        }
    }

    // Close connection pool
    async close() {
        await this.pool.end();
    }
}

// Export singleton instance
const database = new Database();
module.exports = database;
