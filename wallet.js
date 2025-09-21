const TronWeb = require('tronweb');
const bip39 = require('bip39');
const HDKey = require('hdkey');
const CryptoJS = require('crypto-js');
require('dotenv').config();

class WalletManager {
    constructor() {
        this.tronWeb = new TronWeb({
            fullHost: process.env.TRON_NODE_URL,
            headers: { "TRON-PRO-API-KEY": process.env.TRON_GRID_API_KEY },
            privateKey: process.env.MASTER_PRIVATE_KEY
        });

        this.masterAddress = process.env.MASTER_ADDRESS;
        this.masterPrivateKey = process.env.MASTER_PRIVATE_KEY;
        this.encryptionKey = process.env.ENCRYPTION_KEY;
        this.usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS;
        
        // Initialize USDT contract
        this.initializeContract();
    }

    async initializeContract() {
        try {
            this.usdtContract = await this.tronWeb.contract().at(this.usdtContractAddress);
            console.log('✅ USDT contract initialized');
        } catch (error) {
            console.error('❌ Error initializing USDT contract:', error);
        }
    }

    // Generate HD wallet addresses
    generateHDWallet(derivationIndex) {
        try {
            // Generate mnemonic if not exists (for first time setup)
            let mnemonic = process.env.HD_WALLET_MNEMONIC;
            if (!mnemonic) {
                mnemonic = bip39.generateMnemonic();
                console.log('🔑 Generated new mnemonic (SAVE THIS SECURELY):', mnemonic);
            }

            // Generate seed from mnemonic
            const seed = bip39.mnemonicToSeedSync(mnemonic);
            const hdkey = HDKey.fromMasterSeed(seed);

            // Derive child key using derivation path
            const derivationPath = `m/44'/195'/0'/0/${derivationIndex}`;
            const childKey = hdkey.derive(derivationPath);

            // Generate TRON address
            const privateKey = childKey.privateKey.toString('hex');
            const address = this.tronWeb.address.fromPrivateKey(privateKey);

            return {
                address,
                privateKey,
                derivationIndex,
                derivationPath
            };
        } catch (error) {
            console.error('Error generating HD wallet:', error);
            throw error;
        }
    }

    // Encrypt private key
    encryptPrivateKey(privateKey) {
        try {
            return CryptoJS.AES.encrypt(privateKey, this.encryptionKey).toString();
        } catch (error) {
            console.error('Error encrypting private key:', error);
            throw error;
        }
    }

    // Decrypt private key
    decryptPrivateKey(encryptedPrivateKey) {
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedPrivateKey, this.encryptionKey);
            return bytes.toString(CryptoJS.enc.Utf8);
        } catch (error) {
            console.error('Error decrypting private key:', error);
            throw error;
        }
    }

    // Get TRX balance
    async getTRXBalance(address) {
        try {
            const balance = await this.tronWeb.trx.getBalance(address);
            return this.tronWeb.fromSun(balance);
        } catch (error) {
            console.error('Error getting TRX balance:', error);
            return 0;
        }
    }

    // Get TRC20 token balance (USDT)
    async getUSDTBalance(address) {
        try {
            if (!this.usdtContract) {
                await this.initializeContract();
            }
            
            const balance = await this.usdtContract.balanceOf(address).call();
            return parseFloat(this.tronWeb.toDecimal(balance)) / 1000000; // USDT has 6 decimals
        } catch (error) {
            console.error('Error getting USDT balance:', error);
            return 0;
        }
    }

    // Get account info
    async getAccountInfo(address) {
        try {
            const [trxBalance, usdtBalance] = await Promise.all([
                this.getTRXBalance(address),
                this.getUSDTBalance(address)
            ]);

            return {
                address,
                trxBalance: parseFloat(trxBalance),
                usdtBalance: parseFloat(usdtBalance),
                totalValue: parseFloat(trxBalance) + parseFloat(usdtBalance)
            };
        } catch (error) {
            console.error('Error getting account info:', error);
            return {
                address,
                trxBalance: 0,
                usdtBalance: 0,
                totalValue: 0
            };
        }
    }

    // Transfer TRX
    async transferTRX(fromPrivateKey, toAddress, amount) {
        try {
            const tronWebInstance = new TronWeb({
                fullHost: process.env.TRON_NODE_URL,
                headers: { "TRON-PRO-API-KEY": process.env.TRON_GRID_API_KEY },
                privateKey: fromPrivateKey
            });

            const transaction = await tronWebInstance.trx.sendTransaction(
                toAddress,
                tronWebInstance.toSun(amount)
            );

            return transaction;
        } catch (error) {
            console.error('Error transferring TRX:', error);
            throw error;
        }
    }

    // Transfer USDT
    async transferUSDT(fromPrivateKey, toAddress, amount) {
        try {
            const tronWebInstance = new TronWeb({
                fullHost: process.env.TRON_NODE_URL,
                headers: { "TRON-PRO-API-KEY": process.env.TRON_GRID_API_KEY },
                privateKey: fromPrivateKey
            });

            const contract = await tronWebInstance.contract().at(this.usdtContractAddress);
            
            // Convert amount to contract format (6 decimals for USDT)
            const amountInContractFormat = Math.floor(amount * 1000000);

            const transaction = await contract.transfer(
                toAddress,
                amountInContractFormat
            ).send({
                feeLimit: 100000000 // 100 TRX fee limit
            });

            return transaction;
        } catch (error) {
            console.error('Error transferring USDT:', error);
            throw error;
        }
    }

    // Auto-sweep function
    async sweepToMasterWallet(addressData) {
        try {
            const { address, private_key_encrypted } = addressData;
            const privateKey = this.decryptPrivateKey(private_key_encrypted);

            // Get balances
            const accountInfo = await this.getAccountInfo(address);
            const { trxBalance, usdtBalance } = accountInfo;

            const transactions = [];
            let totalSwept = 0;

            // Sweep USDT first (if available)
            if (usdtBalance > parseFloat(process.env.MIN_SWEEP_AMOUNT || 1)) {
                try {
                    // Ensure address has enough TRX for gas
                    if (trxBalance >= 15) {
                        const usdtTx = await this.transferUSDT(privateKey, this.masterAddress, usdtBalance);
                        transactions.push({
                            type: 'USDT',
                            amount: usdtBalance,
                            txHash: usdtTx.txid || usdtTx.transaction?.txID,
                            status: 'pending'
                        });
                        totalSwept += usdtBalance;
                    } else {
                        console.log(`⚠️  Insufficient TRX for gas in ${address}`);
                    }
                } catch (error) {
                    console.error(`❌ Error sweeping USDT from ${address}:`, error);
                }
            }

            // Sweep remaining TRX (keep 1 TRX for future gas)
            const trxToSweep = trxBalance - 1;
            if (trxToSweep > 0.1) {
                try {
                    const trxTx = await this.transferTRX(privateKey, this.masterAddress, trxToSweep);
                    transactions.push({
                        type: 'TRX',
                        amount: trxToSweep,
                        txHash: trxTx.txid || trxTx.transaction?.txID,
                        status: 'pending'
                    });
                } catch (error) {
                    console.error(`❌ Error sweeping TRX from ${address}:`, error);
                }
            }

            return {
                address,
                transactions,
                totalSwept
            };

        } catch (error) {
            console.error('Error in sweep operation:', error);
            throw error;
        }
    }

    // Get transaction info
    async getTransactionInfo(txHash) {
        try {
            const txInfo = await this.tronWeb.trx.getTransactionInfo(txHash);
            return txInfo;
        } catch (error) {
            console.error('Error getting transaction info:', error);
            return null;
        }
    }

    // Validate TRON address
    isValidAddress(address) {
        try {
            return this.tronWeb.isAddress(address);
        } catch (error) {
            return false;
        }
    }

    // Get network status
    async getNetworkStatus() {
        try {
            const nodeInfo = await this.tronWeb.trx.getNodeInfo();
            return {
                status: 'connected',
                blockNumber: nodeInfo.block,
                solidityBlock: nodeInfo.solidityBlock
            };
        } catch (error) {
            return {
                status: 'disconnected',
                error: error.message
            };
        }
    }

    // Estimate gas for USDT transfer
    async estimateUSDTGas() {
        try {
            return {
                estimatedGas: 15, // TRX
                feeLimit: 100000000 // Sun (100 TRX)
            };
        } catch (error) {
            console.error('Error estimating gas:', error);
            return {
                estimatedGas: 15,
                feeLimit: 100000000
            };
        }
    }
}

// Export singleton instance
const walletManager = new WalletManager();
module.exports = walletManager;
