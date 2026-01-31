/**
 * XERIS CHESS v2 - With XRS Betting
 * Run: npm install ws chess.js tweetnacl bs58 && node server.js
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Chess } = require('chess.js');

// Config
const PORT = process.env.PORT || 3001;
const DEFAULT_BET_AMOUNT = 100;
const MIN_BET = 10;
const MAX_BET = 100000;
const FEE_PERCENT = 1;
const WINNER_PERCENT = 99;
const DEV_WALLET = process.env.DEV_WALLET || null;

// XRS API - Real endpoints
const XRS_NODE = 'http://138.197.116.81';
const XRS_EXPLORER_PORT = 50008;
const XRS_NETWORK_PORT = 56001;
const LAMPORTS_PER_XRS = 1000000000; // 1 XRS = 1,000,000,000 lamports

// DEV MODE - Set to false for real blockchain verification
const DEV_MODE = false;

// Escrow wallet - from env vars (production) or file (development)
let escrowWallet = loadOrCreateEscrow();

function loadOrCreateEscrow() {
    // Check for environment variables first (for production deployment)
    if (process.env.ESCROW_PRIVATE_KEY && process.env.ESCROW_ADDRESS) {
        console.log(`[ESCROW] Loaded from environment: ${process.env.ESCROW_ADDRESS.slice(0, 12)}...`);
        return {
            address: process.env.ESCROW_ADDRESS,
            privateKey: process.env.ESCROW_PRIVATE_KEY
        };
    }
    
    // Fall back to file-based wallet (for local development)
    const keyFile = path.join(__dirname, 'escrow-wallet.json');
    try {
        if (fs.existsSync(keyFile)) {
            const data = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
            console.log(`[ESCROW] Loaded from file: ${data.address}`);
            return data;
        }
    } catch (e) {
        console.log(`[ESCROW] Error loading file: ${e.message}`);
    }
    
    // Create new escrow wallet
    const nacl = require('tweetnacl');
    const bs58 = require('bs58');
    const keypair = nacl.sign.keyPair();
    const address = bs58.encode(keypair.publicKey);
    const privateKey = bs58.encode(keypair.secretKey);
    
    const wallet = { address, privateKey };
    fs.writeFileSync(keyFile, JSON.stringify(wallet, null, 2));
    console.log(`[ESCROW] Created NEW wallet: ${address}`);
    console.log(`[ESCROW] ⚠️ Fund this wallet before games can start!`);
    console.log(`[ESCROW] For production, set ESCROW_ADDRESS and ESCROW_PRIVATE_KEY env vars`);
    return wallet;
}

// User database (persistent)
const usersFile = path.join(__dirname, 'users.json');
let users = {}; // wallet -> { username, wins, losses, earnings }

function loadUsers() {
    try {
        if (fs.existsSync(usersFile)) {
            users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            console.log(`[USERS] Loaded ${Object.keys(users).length} users`);
        }
    } catch (e) {
        console.log(`[USERS] Error loading: ${e.message}`);
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    } catch (e) {
        console.log(`[USERS] Error saving: ${e.message}`);
    }
}

function getUser(wallet) {
    return users[wallet] || null;
}

function createUser(wallet, username) {
    users[wallet] = { username, wins: 0, losses: 0, earnings: 0 };
    saveUsers();
    return users[wallet];
}

function updateUserStats(wallet, won, prize = 0, betAmount = DEFAULT_BET_AMOUNT) {
    if (!users[wallet]) return;
    if (won) {
        users[wallet].wins++;
        users[wallet].earnings += prize;
    } else {
        users[wallet].losses++;
        users[wallet].earnings -= betAmount;
    }
    saveUsers();
}

function getLeaderboard() {
    return Object.entries(users)
        .map(([wallet, u]) => ({ wallet: wallet.slice(0, 8) + '...', username: u.username, wins: u.wins, losses: u.losses, earnings: u.earnings }))
        .sort((a, b) => b.wins - a.wins || b.earnings - a.earnings)
        .slice(0, 20);
}

// Global stats
let globalStats = { totalGames: 0, totalWagered: 0 };
const statsFile = path.join(__dirname, 'stats.json');

function loadStats() {
    try {
        if (fs.existsSync(statsFile)) {
            globalStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        }
    } catch (e) {}
}

function saveStats() {
    try {
        fs.writeFileSync(statsFile, JSON.stringify(globalStats));
    } catch (e) {}
}

loadUsers();
loadStats();

// State
const players = new Map();
const games = new Map();
const challenges = new Map(); // challengeId -> { from, to, timestamp, bet }
const waitingPlayers = new Map(); // bet amount -> playerId
let gameCounter = 0;
let challengeCounter = 0;

// HTTP API call helper
function apiCall(port, endpoint) {
    return new Promise((resolve, reject) => {
        const url = `${XRS_NODE}:${port}${endpoint}`;
        console.log(`[API] GET ${url}`);
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ error: 'Invalid JSON', raw: data });
                }
            });
        }).on('error', e => resolve({ error: e.message }));
    });
}

// Check XRS balance (returns XRS, not lamports)
async function getBalance(address) {
    try {
        const res = await apiCall(XRS_EXPLORER_PORT, `/wallet/${address}`);
        const lamports = res.balance || 0;
        const xrs = lamports / LAMPORTS_PER_XRS;
        console.log(`[DEBUG] Balance for ${address.slice(0,8)}...: ${lamports} lamports = ${xrs} XRS`);
        return xrs;
    } catch (e) {
        console.log(`[ERR] Balance check failed: ${e.message}`);
        return 0;
    }
}

// Track escrow balance for deposit detection
let lastEscrowBalance = 0;

// Base58 alphabet for encoding
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
    if (bytes.length === 0) return '';
    
    // Convert bytes to a big integer
    let num = BigInt(0);
    for (const byte of bytes) {
        num = num * BigInt(256) + BigInt(byte);
    }
    
    // Convert to base58
    let result = '';
    while (num > 0) {
        const remainder = Number(num % BigInt(58));
        result = BASE58_ALPHABET[remainder] + result;
        num = num / BigInt(58);
    }
    
    // Add leading '1's for leading zero bytes
    for (const byte of bytes) {
        if (byte === 0) result = '1' + result;
        else break;
    }
    
    return result || '1';
}

// Fetch and parse transactions from blocks to find deposits
async function findDepositTransaction(playerWallet, minAmount) {
    try {
        console.log(`[DEPOSIT] Searching for ${minAmount} XRS from ${playerWallet.slice(0,8)}... to escrow`);
        
        // Fetch blocks from explorer API
        const url = `${XRS_NODE}:${XRS_EXPLORER_PORT}/blocks`;
        
        const response = await new Promise((resolve, reject) => {
            http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', e => reject(e));
        });
        
        let blocks;
        try {
            blocks = JSON.parse(response);
        } catch (e) {
            // Handle truncated JSON
            const lastBracket = response.lastIndexOf('}]');
            if (lastBracket > 0) {
                blocks = JSON.parse(response.substring(0, lastBracket + 2));
            } else {
                console.log(`[DEPOSIT] Failed to parse blocks JSON`);
                return false;
            }
        }
        
        if (!Array.isArray(blocks) || blocks.length === 0) {
            console.log(`[DEPOSIT] No blocks returned`);
            return false;
        }
        
        // Sort by slot descending (newest first)
        blocks.sort((a, b) => (b.slot || 0) - (a.slot || 0));
        
        const minLamports = minAmount * LAMPORTS_PER_XRS;
        let foundTx = null;
        
        // Scan through blocks looking for matching transaction
        for (const block of blocks.slice(0, 50)) { // Check last 50 blocks
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            
            for (const tx of block.transactions) {
                try {
                    const accountKeys = tx.message?.accountKeys;
                    if (!accountKeys || accountKeys.length < 3) continue;
                    
                    // Parse account keys - format: [[count], [from_bytes], [to_bytes], [program_bytes]]
                    let fromAddr = '', toAddr = '';
                    
                    // Check if first element is a count array
                    if (Array.isArray(accountKeys[0]) && accountKeys[0].length === 1) {
                        // Format: [[count], [addr1], [addr2], ...]
                        if (Array.isArray(accountKeys[1]) && accountKeys[1].length === 32) {
                            fromAddr = base58Encode(new Uint8Array(accountKeys[1]));
                        }
                        if (Array.isArray(accountKeys[2]) && accountKeys[2].length === 32) {
                            toAddr = base58Encode(new Uint8Array(accountKeys[2]));
                        }
                    } else {
                        // Direct format: [[addr1_32], [addr2_32], ...]
                        if (Array.isArray(accountKeys[0]) && accountKeys[0].length === 32) {
                            fromAddr = base58Encode(new Uint8Array(accountKeys[0]));
                        }
                        if (Array.isArray(accountKeys[1]) && accountKeys[1].length === 32) {
                            toAddr = base58Encode(new Uint8Array(accountKeys[1]));
                        }
                    }
                    
                    // Check if this is a transfer FROM player TO escrow
                    if (fromAddr !== playerWallet || toAddr !== escrowWallet.address) {
                        continue;
                    }
                    
                    // Parse amount from instruction data
                    // Format: instructions: [[count], {programIdIndex, accounts, data: [[count], 2, 0, 0, 0, ...amount_bytes...]}]
                    const instructions = tx.message?.instructions;
                    if (!instructions) continue;
                    
                    let amount = 0;
                    const instrList = Array.isArray(instructions[0]) && instructions[0].length === 1 
                        ? instructions.slice(1) 
                        : instructions;
                    
                    for (const instr of instrList) {
                        if (!instr || typeof instr !== 'object') continue;
                        
                        let data = instr.data;
                        if (!data) continue;
                        
                        // Handle nested data format: [[count], 2, 0, 0, 0, ...bytes...]
                        if (Array.isArray(data[0]) && data[0].length === 1) {
                            data = data.slice(1);
                        }
                        
                        // Transfer instruction: data[0] = 2 (transfer opcode)
                        // Amount is in bytes 4-11 (little-endian u64)
                        if (data.length >= 12 && data[0] === 2) {
                            // Read little-endian u64 from bytes 4-11
                            let lamports = BigInt(0);
                            for (let i = 11; i >= 4; i--) {
                                lamports = lamports * BigInt(256) + BigInt(data[i] || 0);
                            }
                            amount = Number(lamports) / LAMPORTS_PER_XRS;
                        }
                    }
                    
                    console.log(`[DEPOSIT] Found TX: ${fromAddr.slice(0,8)}... -> ${toAddr.slice(0,8)}... = ${amount} XRS`);
                    
                    if (amount >= minAmount) {
                        foundTx = {
                            from: fromAddr,
                            to: toAddr,
                            amount: amount,
                            slot: block.slot
                        };
                        console.log(`[DEPOSIT] ✓ Valid deposit found in slot ${block.slot}!`);
                        return foundTx;
                    }
                } catch (txErr) {
                    // Skip malformed transactions
                    continue;
                }
            }
        }
        
        console.log(`[DEPOSIT] No matching transaction found`);
        return null;
    } catch (e) {
        console.log(`[DEPOSIT ERR] ${e.message}`);
        return null;
    }
}

// Track confirmed deposits to avoid double-counting
const confirmedDeposits = new Map(); // "gameId:playerId" -> slot number

// Check for incoming deposit from specific player
async function checkDeposit(gameId, playerId, playerWallet, betAmount = DEFAULT_BET_AMOUNT) {
    const depositKey = `${gameId}:${playerId}`;
    
    // Already confirmed this deposit?
    if (confirmedDeposits.has(depositKey)) {
        return true;
    }
    
    // Search for transaction from player to escrow
    const tx = await findDepositTransaction(playerWallet, betAmount);
    
    if (tx) {
        // Mark as confirmed so we don't count it again
        confirmedDeposits.set(depositKey, tx.slot);
        return true;
    }
    
    return false;
}

// Track pending payouts for manual processing if auto-payout fails
const pendingPayouts = [];

// Send XRS payout - builds Solana-compatible transaction
async function sendPayout(toAddress, amount, reason) {
    try {
        const nacl = require('tweetnacl');
        const bs58 = require('bs58');
        
        // Convert amount to lamports
        const lamports = Math.floor(amount * LAMPORTS_PER_XRS);
        
        console.log(`[PAYOUT] Attempting ${amount} XRS to ${toAddress.slice(0,8)}... (${reason})`);
        
        // First try: Use airdrop endpoint (simpler, works from escrow funds indirectly)
        // This is a workaround while we debug the /submit transaction format
        const airdropUrl = `http://138.197.116.81:56001/airdrop/${toAddress}/${Math.floor(amount)}`;
        console.log(`[PAYOUT] Trying airdrop: ${airdropUrl}`);
        
        return new Promise((resolve, reject) => {
            http.get(airdropUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log(`[PAYOUT] Airdrop response: ${data}`);
                    if (data.toLowerCase().includes('sent') || data.toLowerCase().includes('airdrop')) {
                        console.log(`[PAYOUT] ✓ ${amount} XRS sent to ${toAddress.slice(0,8)}... via airdrop (${reason})`);
                        resolve(true);
                    } else {
                        console.log(`[PAYOUT] Airdrop failed, trying signed transaction...`);
                        // Fallback: try signed transaction
                        sendSignedTransaction(toAddress, lamports, reason).then(resolve);
                    }
                });
            }).on('error', (e) => {
                console.log(`[PAYOUT] Airdrop error: ${e.message}, trying signed transaction...`);
                sendSignedTransaction(toAddress, lamports, reason).then(resolve);
            });
        });
    } catch (e) {
        console.log(`[PAYOUT ERR] ${e.message}`);
        pendingPayouts.push({
            to: toAddress,
            amount: amount,
            reason: reason,
            timestamp: new Date().toISOString(),
            error: e.message
        });
        console.log(`[PAYOUT] Manual payout needed: ${amount} XRS to ${toAddress}`);
        return false;
    }
}

// Signed transaction payout (backup method)
async function sendSignedTransaction(toAddress, lamports, reason) {
    try {
        const nacl = require('tweetnacl');
        const bs58 = require('bs58');
        
        // Get escrow keypair
        const secretKey = bs58.decode(escrowWallet.privateKey);
        const publicKey = bs58.decode(escrowWallet.address);
        const toPublicKey = bs58.decode(toAddress);
        
        // System program address (all zeros)
        const systemProgram = Buffer.alloc(32, 0);
        
        // Recent blockhash (32 bytes)
        const recentBlockhash = Buffer.alloc(32, 0);
        
        // Transfer instruction data: [2 (u32 LE), amount (u64 LE)]
        const instructionData = Buffer.alloc(12);
        instructionData.writeUInt32LE(2, 0);
        instructionData.writeBigUInt64LE(BigInt(lamports), 4);
        
        // Build the message
        const message = Buffer.concat([
            Buffer.from([1, 0, 1]),  // Header
            Buffer.from([3]),        // 3 accounts
            Buffer.from(publicKey),
            Buffer.from(toPublicKey),
            systemProgram,
            recentBlockhash,
            Buffer.from([1]),        // 1 instruction
            Buffer.from([2]),        // program index
            Buffer.from([2]),        // accounts length
            Buffer.from([0, 1]),     // account indices
            Buffer.from([instructionData.length]),
            instructionData
        ]);
        
        // Sign
        const signature = nacl.sign.detached(message, secretKey);
        
        // Build transaction
        const transaction = Buffer.concat([
            Buffer.from([1]),
            Buffer.from(signature),
            message
        ]);
        
        const tx_base64 = transaction.toString('base64');
        const postData = JSON.stringify({ tx_base64 });
        
        console.log(`[PAYOUT] Signed TX size: ${transaction.length} bytes`);
        
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '138.197.116.81',
                port: 56001,
                path: '/submit',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log(`[PAYOUT] Submit response: ${data}`);
                    if (data.toLowerCase().includes('submit') || data.toLowerCase().includes('success')) {
                        resolve(true);
                    } else {
                        const amount = Number(lamports) / LAMPORTS_PER_XRS;
                        pendingPayouts.push({
                            to: toAddress,
                            amount: amount,
                            reason: reason,
                            timestamp: new Date().toISOString(),
                            error: data
                        });
                        console.log(`[PAYOUT] Manual payout needed: ${amount} XRS to ${toAddress}`);
                        resolve(false);
                    }
                });
            });
            req.on('error', (e) => {
                const amount = Number(lamports) / LAMPORTS_PER_XRS;
                pendingPayouts.push({
                    to: toAddress,
                    amount: amount,
                    reason: reason,
                    timestamp: new Date().toISOString(),
                    error: e.message
                });
                console.log(`[PAYOUT] Manual payout needed: ${amount} XRS to ${toAddress}`);
                resolve(false);
            });
            req.write(postData);
            req.end();
        });
    } catch (e) {
        console.log(`[PAYOUT ERR] Signed TX: ${e.message}`);
        return false;
    }
}

// HTTP Server
const server = http.createServer((req, res) => {
    // CORS headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // API endpoints
    if (req.url === '/api/escrow') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ address: escrowWallet.address, defaultBet: DEFAULT_BET_AMOUNT, minBet: MIN_BET, maxBet: MAX_BET }));
        return;
    }
    
    // Stats for frontend
    if (req.url === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalGames: globalStats.totalGames,
            totalWagered: globalStats.totalWagered,
            onlinePlayers: players.size,
            leaderboard: getLeaderboard().slice(0, 3)
        }));
        return;
    }
    
    // Admin: View pending payouts
    if (req.url === '/api/pending-payouts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            count: pendingPayouts.length,
            payouts: pendingPayouts,
            totalOwed: pendingPayouts.reduce((sum, p) => sum + p.amount, 0)
        }));
        return;
    }
    
    // Admin: Server status
    if (req.url === '/api/admin') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            escrow: escrowWallet.address,
            activePlayers: players.size,
            activeGames: games.size,
            pendingPayouts: pendingPayouts.length,
            confirmedDeposits: confirmedDeposits.size,
            totalUsers: Object.keys(users).length
        }));
        return;
    }
    
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);
    
    if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(fs.readFileSync(filePath));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const playerId = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
    players.set(playerId, { 
        ws, 
        gameId: null, 
        color: null,
        wallet: null,
        deposited: false 
    });
    
    console.log(`[+] ${playerId} connected`);
    send(ws, { type: 'connected', playerId, escrow: escrowWallet.address, defaultBet: DEFAULT_BET_AMOUNT, minBet: MIN_BET, maxBet: MAX_BET });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessage(playerId, msg);
        } catch (e) {
            console.log(`[ERR] ${e.message}`);
        }
    });
    
    ws.on('close', () => {
        console.log(`[-] ${playerId} disconnected`);
        handleDisconnect(playerId);
        players.delete(playerId);
    });
});

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

async function handleMessage(playerId, msg) {
    const player = players.get(playerId);
    if (!player) return;
    
    console.log(`[MSG] ${playerId}: ${msg.type}`);
    
    switch (msg.type) {
        case 'connect_wallet':
            player.wallet = msg.wallet;
            const existingUser = getUser(msg.wallet);
            if (existingUser) {
                player.username = existingUser.username;
                send(player.ws, { 
                    type: 'wallet_connected', 
                    existingUsername: existingUser.username,
                    stats: existingUser
                });
                console.log(`[WALLET] ${playerId} -> ${msg.wallet.slice(0,8)}... (${existingUser.username})`);
            } else {
                send(player.ws, { type: 'wallet_connected', existingUsername: null });
                console.log(`[WALLET] ${playerId} -> ${msg.wallet.slice(0,8)}... (new user)`);
            }
            break;
            
        case 'set_username':
            if (!player.wallet) {
                send(player.ws, { type: 'error', message: 'Connect wallet first' });
                return;
            }
            const username = msg.username.trim().slice(0, 15);
            if (username.length < 3) {
                send(player.ws, { type: 'error', message: 'Username too short' });
                return;
            }
            player.username = username;
            const newUser = createUser(player.wallet, username);
            send(player.ws, { type: 'username_set', username, stats: newUser });
            console.log(`[USER] ${player.wallet.slice(0,8)}... set username: ${username}`);
            broadcastLobby();
            break;
            
        case 'get_lobby':
            sendLobbyUpdate(playerId);
            break;
            
        case 'find_game':
            if (!player.wallet || !player.username) {
                send(player.ws, { type: 'error', message: 'Connect wallet first' });
                return;
            }
            const bet = Math.min(MAX_BET, Math.max(MIN_BET, parseInt(msg.bet) || DEFAULT_BET_AMOUNT));
            await findGame(playerId, bet);
            break;
            
        case 'challenge':
            const challengeBet = Math.min(MAX_BET, Math.max(MIN_BET, parseInt(msg.bet) || DEFAULT_BET_AMOUNT));
            handleChallenge(playerId, msg.targetId, challengeBet);
            break;
            
        case 'accept_challenge':
            handleAcceptChallenge(playerId, msg.challengeId);
            break;
            
        case 'decline_challenge':
            handleDeclineChallenge(playerId, msg.challengeId);
            break;
            
        case 'check_deposit':
            await verifyDeposit(playerId);
            break;
            
        case 'move':
            handleMove(playerId, msg);
            break;
            
        case 'resign':
            handleResign(playerId);
            break;
            
        case 'cancel_search':
            // Remove from all waiting pools
            for (const [bet, pid] of waitingPlayers) {
                if (pid === playerId) {
                    waitingPlayers.delete(bet);
                    break;
                }
            }
            send(player.ws, { type: 'search_cancelled' });
            // Also cancel any pending challenges
            for (const [cid, c] of challenges) {
                if (c.from === playerId || c.to === playerId) {
                    challenges.delete(cid);
                }
            }
            break;
            
        case 'cancel_game':
            // Cancel before game starts
            if (player.gameId) {
                const game = games.get(player.gameId);
                if (game && !game.started) {
                    // Notify opponent
                    const otherId = player.color === 'white' ? game.black : game.white;
                    const other = players.get(otherId);
                    if (other) {
                        send(other.ws, { type: 'game_cancelled' });
                        other.gameId = null;
                    }
                    games.delete(player.gameId);
                    player.gameId = null;
                }
            }
            break;
    }
}

// Lobby functions
function sendLobbyUpdate(playerId) {
    const player = players.get(playerId);
    if (!player) return;
    
    const playersList = [];
    for (const [pid, p] of players) {
        if (p.username && p.wallet) {
            const user = getUser(p.wallet) || { wins: 0, losses: 0 };
            playersList.push({
                oderId: pid,
                username: p.username,
                wins: user.wins,
                losses: user.losses,
                inGame: !!p.gameId
            });
        }
    }
    
    send(player.ws, {
        type: 'lobby_update',
        players: playersList,
        leaderboard: getLeaderboard(),
        stats: {
            totalGames: globalStats.totalGames,
            totalWagered: globalStats.totalWagered
        }
    });
}

function broadcastLobby() {
    for (const [pid, p] of players) {
        if (p.username && !p.gameId) {
            sendLobbyUpdate(pid);
        }
    }
}

// Challenge functions
function handleChallenge(fromId, toId, bet) {
    const from = players.get(fromId);
    const to = players.get(toId);
    
    if (!from || !to || !from.username || !to.username) {
        send(from?.ws, { type: 'error', message: 'Invalid challenge target' });
        return;
    }
    
    if (to.gameId) {
        send(from.ws, { type: 'error', message: 'Player is already in a game' });
        return;
    }
    
    const challengeId = 'c' + (++challengeCounter);
    challenges.set(challengeId, { from: fromId, to: toId, timestamp: Date.now(), bet });
    
    send(to.ws, {
        type: 'challenge_received',
        challengeId,
        fromUsername: from.username,
        fromId,
        bet
    });
    
    console.log(`[CHALLENGE] ${from.username} -> ${to.username} (${bet} XRS)`);
}

function handleAcceptChallenge(playerId, challengeId) {
    const challenge = challenges.get(challengeId);
    if (!challenge || challenge.to !== playerId) return;
    
    challenges.delete(challengeId);
    
    // Create game between challenger and accepter with the challenge bet
    createGame(challenge.from, challenge.to, challenge.bet);
}

function handleDeclineChallenge(playerId, challengeId) {
    const challenge = challenges.get(challengeId);
    if (!challenge || challenge.to !== playerId) return;
    
    const from = players.get(challenge.from);
    const to = players.get(challenge.to);
    
    challenges.delete(challengeId);
    
    if (from) {
        send(from.ws, { type: 'challenge_declined', username: to?.username || 'Player' });
    }
    
    console.log(`[CHALLENGE] Declined by ${to?.username}`);
}

// Create game between two players
function createGame(whiteId, blackId, bet = DEFAULT_BET_AMOUNT) {
    const white = players.get(whiteId);
    const black = players.get(blackId);
    
    if (!white || !black) return;
    
    const gameId = 'g' + (++gameCounter);
    const chess = new Chess();
    
    // Randomize colors
    if (Math.random() < 0.5) {
        [whiteId, blackId] = [blackId, whiteId];
    }
    
    const whitePlayer = players.get(whiteId);
    const blackPlayer = players.get(blackId);
    
    games.set(gameId, {
        chess,
        white: whiteId,
        black: blackId,
        whiteWallet: whitePlayer.wallet,
        blackWallet: blackPlayer.wallet,
        whiteName: whitePlayer.username,
        blackName: blackPlayer.username,
        whiteDeposit: false,
        blackDeposit: false,
        started: false,
        pot: 0,
        bet: bet // Store bet amount per game
    });
    
    whitePlayer.gameId = gameId;
    whitePlayer.color = 'white';
    whitePlayer.deposited = false;
    
    blackPlayer.gameId = gameId;
    blackPlayer.color = 'black';
    blackPlayer.deposited = false;
    
    // Send deposit requests
    const depositInfo = {
        type: 'deposit_required',
        gameId,
        escrow: escrowWallet.address,
        amount: bet
    };
    
    send(whitePlayer.ws, { ...depositInfo, color: 'white', opponentUsername: blackPlayer.username });
    send(blackPlayer.ws, { ...depositInfo, color: 'black', opponentUsername: whitePlayer.username });
    
    console.log(`[MATCH] ${gameId}: ${whitePlayer.username} (W) vs ${blackPlayer.username} (B) - ${bet} XRS`);
    broadcastLobby();
}

async function findGame(playerId, bet = DEFAULT_BET_AMOUNT) {
    const player = players.get(playerId);
    if (!player || player.gameId) return;
    
    // Check if someone is waiting at this bet amount
    const waitingId = waitingPlayers.get(bet);
    
    if (waitingId && waitingId !== playerId) {
        const opponent = players.get(waitingId);
        if (!opponent || !opponent.wallet || !opponent.username) {
            // Invalid opponent, replace them
            waitingPlayers.set(bet, playerId);
            send(player.ws, { type: 'waiting' });
            return;
        }
        
        // Match found at same bet level
        waitingPlayers.delete(bet);
        createGame(playerId, waitingId, bet);
    } else {
        // Add to waiting pool for this bet amount
        waitingPlayers.set(bet, playerId);
        send(player.ws, { type: 'waiting' });
        console.log(`[WAIT] ${player.username || playerId} (${bet} XRS)`);
    }
}

async function verifyDeposit(playerId) {
    const player = players.get(playerId);
    if (!player?.gameId || !player.wallet) return;
    
    const game = games.get(player.gameId);
    if (!game || game.started) return;
    
    const betAmount = game.bet || DEFAULT_BET_AMOUNT;
    
    // Check if this player already deposited
    if (player.deposited) {
        send(player.ws, { type: 'deposit_confirmed' });
        return;
    }
    
    let hasDeposit = false;
    
    if (DEV_MODE) {
        // Auto-confirm in dev mode - no real blockchain check
        console.log(`[DEV] Auto-confirming deposit for ${playerId}`);
        hasDeposit = true;
    } else {
        // Real blockchain verification - search for transaction from player to escrow
        hasDeposit = await checkDeposit(player.gameId, playerId, player.wallet, betAmount);
    }
    
    if (hasDeposit) {
        player.deposited = true;
        if (player.color === 'white') {
            game.whiteDeposit = true;
        } else {
            game.blackDeposit = true;
        }
        game.pot += betAmount;
        
        send(player.ws, { type: 'deposit_confirmed' });
        console.log(`[DEPOSIT] ${playerId} (${player.wallet.slice(0,8)}...) confirmed (${betAmount} XRS) - Pot: ${game.pot} XRS`);
        
        // Check if both deposited
        if (game.whiteDeposit && game.blackDeposit) {
            startGame(player.gameId);
        } else {
            // Notify opponent
            const otherId = player.color === 'white' ? game.black : game.white;
            const other = players.get(otherId);
            if (other) {
                send(other.ws, { type: 'opponent_deposited' });
            }
        }
    } else {
        send(player.ws, { 
            type: 'deposit_not_found', 
            message: `No deposit found from your wallet. Send exactly ${betAmount} XRS to the escrow address and try again.`
        });
    }
}

function startGame(gameId) {
    const game = games.get(gameId);
    if (!game || game.started) return;
    
    game.started = true;
    
    // Update global stats
    globalStats.totalGames++;
    globalStats.totalWagered += game.pot;
    saveStats();
    
    const gameInfo = { 
        type: 'game_start', 
        gameId, 
        fen: game.chess.fen(), 
        turn: 'white',
        pot: game.pot,
        winnerPrize: Math.floor(game.pot * WINNER_PERCENT / 100),
        whiteName: game.whiteName || 'White',
        blackName: game.blackName || 'Black'
    };
    
    send(players.get(game.white)?.ws, { ...gameInfo, color: 'white' });
    send(players.get(game.black)?.ws, { ...gameInfo, color: 'black' });
    
    console.log(`[GAME] ${gameId}: ${game.whiteName} vs ${game.blackName} - Pot: ${game.pot} XRS`);
    broadcastLobby();
}

function handleMove(playerId, msg) {
    const player = players.get(playerId);
    if (!player?.gameId) return;
    
    const game = games.get(player.gameId);
    if (!game || !game.started) return;
    
    const turn = game.chess.turn() === 'w' ? 'white' : 'black';
    if (turn !== player.color) {
        send(player.ws, { type: 'error', message: 'Not your turn' });
        return;
    }
    
    try {
        const move = game.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
        
        if (move) {
            const moveData = {
                type: 'move',
                from: msg.from, to: msg.to, san: move.san,
                fen: game.chess.fen(),
                turn: game.chess.turn() === 'w' ? 'white' : 'black'
            };
            
            send(players.get(game.white)?.ws, moveData);
            send(players.get(game.black)?.ws, moveData);
            
            console.log(`[MOVE] ${player.gameId}: ${move.san}`);
            checkGameOver(player.gameId);
        } else {
            send(player.ws, { type: 'invalid_move' });
        }
    } catch (e) {
        send(player.ws, { type: 'invalid_move' });
    }
}

function handleResign(playerId) {
    const player = players.get(playerId);
    if (!player?.gameId) return;
    
    const game = games.get(player.gameId);
    if (!game) return;
    
    const winner = player.color === 'white' ? 'black' : 'white';
    endGame(player.gameId, winner, 'resignation');
}

function handleDisconnect(playerId) {
    // Remove from all waiting pools
    for (const [bet, pid] of waitingPlayers) {
        if (pid === playerId) {
            waitingPlayers.delete(bet);
            break;
        }
    }
    
    const player = players.get(playerId);
    if (player?.gameId) {
        const game = games.get(player.gameId);
        if (game?.started) {
            const winner = player.color === 'white' ? 'black' : 'white';
            endGame(player.gameId, winner, 'opponent disconnected');
        } else if (game) {
            // Game not started - refund deposits
            refundDeposits(player.gameId, 'opponent left before game started');
        }
    }
}

async function refundDeposits(gameId, reason) {
    const game = games.get(gameId);
    if (!game) return;
    
    const betAmount = game.bet || DEFAULT_BET_AMOUNT;
    const endData = { type: 'game_cancelled', reason };
    
    for (const id of [game.white, game.black]) {
        const p = players.get(id);
        if (p) {
            send(p.ws, endData);
            if (p.deposited && p.wallet) {
                await sendPayout(p.wallet, betAmount, 'refund');
            }
            p.gameId = null;
            p.color = null;
            p.deposited = false;
        }
    }
    
    games.delete(gameId);
    console.log(`[CANCEL] ${gameId}: ${reason}`);
}

function checkGameOver(gameId) {
    const game = games.get(gameId);
    if (!game || !game.chess.isGameOver()) return;
    
    let result, reason;
    if (game.chess.isCheckmate()) {
        result = game.chess.turn() === 'w' ? 'black' : 'white';
        reason = 'checkmate';
    } else {
        result = 'draw';
        reason = game.chess.isStalemate() ? 'stalemate' : 'draw';
    }
    
    endGame(gameId, result, reason);
}

async function endGame(gameId, result, reason) {
    const game = games.get(gameId);
    if (!game) return;
    
    const betAmount = game.bet || DEFAULT_BET_AMOUNT;
    const winnerPrize = Math.floor(game.pot * WINNER_PERCENT / 100);
    const fee = game.pot - winnerPrize;
    
    // Determine winner wallet and update stats
    let winnerWallet = null;
    let loserWallet = null;
    let winnerColor = result;
    
    if (result === 'white') {
        winnerWallet = game.whiteWallet;
        loserWallet = game.blackWallet;
        updateUserStats(game.whiteWallet, true, winnerPrize, betAmount);
        updateUserStats(game.blackWallet, false, 0, betAmount);
    } else if (result === 'black') {
        winnerWallet = game.blackWallet;
        loserWallet = game.whiteWallet;
        updateUserStats(game.blackWallet, true, winnerPrize, betAmount);
        updateUserStats(game.whiteWallet, false, 0, betAmount);
    }
    
    // Send payout
    let payoutSuccess = false;
    if (winnerWallet && game.pot > 0) {
        payoutSuccess = await sendPayout(winnerWallet, winnerPrize, `win-${reason}`);
        
        // Send fee to dev wallet
        if (DEV_WALLET && fee > 0) {
            await sendPayout(DEV_WALLET, fee, 'fee');
        }
    } else if (result === 'draw' && game.pot > 0) {
        // Refund both on draw
        const refund = Math.floor(game.pot / 2);
        if (game.whiteWallet) await sendPayout(game.whiteWallet, refund, 'draw-refund');
        if (game.blackWallet) await sendPayout(game.blackWallet, refund, 'draw-refund');
        payoutSuccess = true;
    }
    
    const endData = { 
        type: 'game_over', 
        winner: result,
        reason,
        pot: game.pot,
        bet: betAmount,
        prize: result === 'draw' ? Math.floor(game.pot / 2) : winnerPrize,
        payoutSuccess
    };
    
    [game.white, game.black].forEach(id => {
        const p = players.get(id);
        if (p) {
            send(p.ws, endData);
            p.gameId = null;
            p.color = null;
            p.deposited = false;
        }
    });
    
    games.delete(gameId);
    console.log(`[END] ${gameId}: ${result} wins (${reason}) - Prize: ${winnerPrize} XRS`);
    broadcastLobby();
}

// Startup
async function startup() {
    const balance = await getBalance(escrowWallet.address);
    lastEscrowBalance = balance; // Initialize for deposit tracking
    
    const modeText = DEV_MODE ? '⚠️  DEV MODE - Deposits auto-confirmed!' : '🔒 PRODUCTION - Real blockchain verification';
    console.log(`
╔════════════════════════════════════════════════════════╗
║          ♟️  XERIS CHESS v2 - XRS BETTING  ♟️           ║
║                                                        ║
║  Bets: ${MIN_BET}-${MAX_BET} XRS | Winner: ${WINNER_PERCENT}% | Fee: ${FEE_PERCENT}%            ║
╠════════════════════════════════════════════════════════╣
║  ${modeText}
╠════════════════════════════════════════════════════════╣
║  Escrow: ${escrowWallet.address.slice(0,20)}...         ║
║  Balance: ${balance} XRS                                       
╠════════════════════════════════════════════════════════╣
║  API: ${XRS_NODE}:${XRS_EXPLORER_PORT}
║  http://localhost:${PORT}                                 ║
╚════════════════════════════════════════════════════════╝
    `);
    
    if (!DEV_MODE && balance < DEFAULT_BET_AMOUNT * 2) {
        console.log(`[WARN] Low escrow balance! Send XRS to: ${escrowWallet.address}`);
    }
}

server.listen(PORT, () => startup());
