/**
 * Xeris Chess - Escrow Wallet Utility
 * 
 * Run once to generate your escrow wallet, then save the keys!
 * 
 * Usage:
 *   node wallet.js generate    - Create new wallet
 *   node wallet.js show        - Show existing wallet from file
 */

const fs = require('fs');
const path = require('path');

// These will be installed with npm install
let nacl, bs58;
try {
    nacl = require('tweetnacl');
    bs58 = require('bs58');
} catch (e) {
    console.log('Run "npm install" first!');
    process.exit(1);
}

const WALLET_FILE = path.join(__dirname, 'escrow-wallet.json');

function generateWallet() {
    const keypair = nacl.sign.keyPair();
    const address = bs58.encode(keypair.publicKey);
    const privateKey = bs58.encode(keypair.secretKey);
    
    return { address, privateKey };
}

function saveWallet(wallet) {
    fs.writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2));
}

function loadWallet() {
    if (fs.existsSync(WALLET_FILE)) {
        return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    }
    return null;
}

const command = process.argv[2];

console.log('\n♟️  XERIS CHESS - ESCROW WALLET UTILITY\n');
console.log('='.repeat(60) + '\n');

if (command === 'generate') {
    const existing = loadWallet();
    if (existing) {
        console.log('⚠️  Wallet already exists! Current wallet:\n');
        console.log(`   Address:     ${existing.address}`);
        console.log(`   Private Key: ${existing.privateKey.slice(0, 20)}...`);
        console.log('\n   Delete escrow-wallet.json first if you want a new one.\n');
    } else {
        const wallet = generateWallet();
        saveWallet(wallet);
        
        console.log('✅ NEW ESCROW WALLET GENERATED!\n');
        console.log('='.repeat(60));
        console.log('\n🔑 SAVE THESE KEYS - YOU WILL NEED THEM FOR DEPLOYMENT!\n');
        console.log('='.repeat(60) + '\n');
        console.log(`   Address (Public):  ${wallet.address}\n`);
        console.log(`   Private Key:       ${wallet.privateKey}\n`);
        console.log('='.repeat(60) + '\n');
        console.log('📋 For Railway/Render deployment, set these environment variables:\n');
        console.log(`   ESCROW_ADDRESS=${wallet.address}`);
        console.log(`   ESCROW_PRIVATE_KEY=${wallet.privateKey}`);
        console.log('\n⚠️  NEVER share or commit your private key!\n');
        console.log(`💰 Fund this wallet with XRS before starting games.\n`);
        console.log(`   Airdrop: curl http://138.197.116.81:56001/airdrop/${wallet.address}/1000\n`);
    }
} else if (command === 'show') {
    const wallet = loadWallet();
    if (wallet) {
        console.log('📍 Current Escrow Wallet:\n');
        console.log('='.repeat(60) + '\n');
        console.log(`   Address:     ${wallet.address}\n`);
        console.log(`   Private Key: ${wallet.privateKey}\n`);
        console.log('='.repeat(60) + '\n');
        console.log('📋 Environment variables for deployment:\n');
        console.log(`   ESCROW_ADDRESS=${wallet.address}`);
        console.log(`   ESCROW_PRIVATE_KEY=${wallet.privateKey}\n`);
    } else {
        console.log('❌ No wallet found. Run: node wallet.js generate\n');
    }
} else {
    console.log('Usage:\n');
    console.log('   node wallet.js generate   - Create new escrow wallet');
    console.log('   node wallet.js show       - Show existing wallet\n');
}
