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

// Tournament State
let activeTournament = null;
let tournamentCounter = 0;

/*
Tournament structure:
{
    id: 't1',
    name: 'Championship Night',
    size: 8 or 16,
    entryFee: 100,
    prizePool: 1000, // Extra prize added by admin
    players: [], // { oderId, username, wallet }
    bracket: [], // [[round1 matches], [round2 matches], ...]
    currentRound: 0,
    status: 'registration' | 'in_progress' | 'finished',
    winner: null,
    createdAt: Date.now()
}
*/

// Championship Interest Registration
let championshipInterest = [];
const CHAMPIONSHIP_FILE = path.join(__dirname, 'championship-interest.json');

function loadChampionshipInterest() {
    try {
        if (fs.existsSync(CHAMPIONSHIP_FILE)) {
            championshipInterest = JSON.parse(fs.readFileSync(CHAMPIONSHIP_FILE, 'utf8'));
            console.log(`[CHAMPIONSHIP] Loaded ${championshipInterest.length} registrations`);
        }
    } catch (e) {
        console.log('[CHAMPIONSHIP] No existing registrations file');
        championshipInterest = [];
    }
}

function saveChampionshipInterest() {
    try {
        fs.writeFileSync(CHAMPIONSHIP_FILE, JSON.stringify(championshipInterest, null, 2));
    } catch (e) {
        console.log('[CHAMPIONSHIP] Failed to save registrations:', e.message);
    }
}

// Load on startup
loadChampionshipInterest();

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

// Parse amount from instruction data bytes (handles both NativeTransfer variant 11 and old variant 2)
function parseTransferAmount(data) {
    if (!data || data.length < 4) return 0;

    // Handle nested data format: [[count], ...bytes]
    if (Array.isArray(data[0]) && data[0].length === 1) {
        data = data.slice(1);
    }

    // Read variant index as u32LE (first 4 bytes)
    const variant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);

    if (variant === 11) {
        // NativeTransfer: u32LE(11) + string(from) + string(to) + u64LE(amount)
        // String encoding: u64LE(len) + utf8 bytes
        let offset = 4;

        // Skip 'from' string: read u64LE length, then skip that many bytes
        if (offset + 8 > data.length) return 0;
        let fromLen = 0;
        for (let i = 0; i < 8; i++) fromLen += (data[offset + i] || 0) * Math.pow(256, i);
        offset += 8 + fromLen;

        // Skip 'to' string
        if (offset + 8 > data.length) return 0;
        let toLen = 0;
        for (let i = 0; i < 8; i++) toLen += (data[offset + i] || 0) * Math.pow(256, i);
        offset += 8 + toLen;

        // Read amount as u64LE
        if (offset + 8 > data.length) return 0;
        let lamports = BigInt(0);
        for (let i = 7; i >= 0; i--) {
            lamports = lamports * 256n + BigInt(data[offset + i] || 0);
        }
        return Number(lamports) / LAMPORTS_PER_XRS;
    }

    if (variant === 2 || data[0] === 2) {
        // Old transfer format: opcode 2 at byte 0, amount at bytes 4-11
        if (data.length >= 12) {
            let lamports = BigInt(0);
            for (let i = 11; i >= 4; i--) {
                lamports = lamports * 256n + BigInt(data[i] || 0);
            }
            return Number(lamports) / LAMPORTS_PER_XRS;
        }
    }

    return 0;
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
                return null;
            }
        }

        if (!Array.isArray(blocks) || blocks.length === 0) {
            console.log(`[DEPOSIT] No blocks returned`);
            return null;
        }

        // Sort by slot descending (newest first)
        blocks.sort((a, b) => (b.slot || 0) - (a.slot || 0));

        // Scan through blocks looking for matching transaction
        for (const block of blocks.slice(0, 50)) { // Check last 50 blocks
            if (!block.transactions || !Array.isArray(block.transactions)) continue;

            for (const tx of block.transactions) {
                try {
                    const accountKeys = tx.message?.accountKeys;
                    if (!accountKeys || accountKeys.length < 2) continue;

                    // Parse account keys - format varies
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
                        // NativeTransfer embeds from/to in instruction data, not just account keys
                        // Check instruction data for embedded addresses if account key match fails
                    } else {
                        // Account keys match — parse amount from instruction data
                        const instructions = tx.message?.instructions;
                        if (!instructions) continue;

                        const instrList = Array.isArray(instructions[0]) && instructions[0].length === 1
                            ? instructions.slice(1)
                            : instructions;

                        for (const instr of instrList) {
                            if (!instr || typeof instr !== 'object') continue;
                            const data = instr.data;
                            if (!data) continue;

                            const amount = parseTransferAmount(data);

                            if (amount >= minAmount) {
                                console.log(`[DEPOSIT] Found TX: ${fromAddr.slice(0,8)}... -> ${toAddr.slice(0,8)}... = ${amount} XRS (slot ${block.slot})`);
                                return { from: fromAddr, to: toAddr, amount, slot: block.slot };
                            }
                        }
                    }

                    // Fallback: parse NativeTransfer instruction data for embedded from/to addresses
                    const instructions = tx.message?.instructions;
                    if (!instructions) continue;

                    const instrList = Array.isArray(instructions[0]) && instructions[0].length === 1
                        ? instructions.slice(1)
                        : instructions;

                    for (const instr of instrList) {
                        if (!instr || typeof instr !== 'object') continue;
                        let data = instr.data;
                        if (!data) continue;

                        if (Array.isArray(data[0]) && data[0].length === 1) {
                            data = data.slice(1);
                        }

                        // Check if this is NativeTransfer (variant 11)
                        if (data.length < 4) continue;
                        const variant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
                        if (variant !== 11) continue;

                        // Parse from string
                        let offset = 4;
                        if (offset + 8 > data.length) continue;
                        let fromLen = 0;
                        for (let i = 0; i < 8; i++) fromLen += (data[offset + i] || 0) * Math.pow(256, i);
                        offset += 8;
                        if (offset + fromLen > data.length) continue;
                        const embeddedFrom = String.fromCharCode(...data.slice(offset, offset + fromLen));
                        offset += fromLen;

                        // Parse to string
                        if (offset + 8 > data.length) continue;
                        let toLen = 0;
                        for (let i = 0; i < 8; i++) toLen += (data[offset + i] || 0) * Math.pow(256, i);
                        offset += 8;
                        if (offset + toLen > data.length) continue;
                        const embeddedTo = String.fromCharCode(...data.slice(offset, offset + toLen));
                        offset += toLen;

                        // Check addresses match
                        if (embeddedFrom !== playerWallet || embeddedTo !== escrowWallet.address) continue;

                        // Parse amount
                        if (offset + 8 > data.length) continue;
                        let lamports = BigInt(0);
                        for (let i = 7; i >= 0; i--) {
                            lamports = lamports * 256n + BigInt(data[offset + i] || 0);
                        }
                        const amount = Number(lamports) / LAMPORTS_PER_XRS;

                        if (amount >= minAmount) {
                            console.log(`[DEPOSIT] Found NativeTransfer TX: ${embeddedFrom.slice(0,8)}... -> ${embeddedTo.slice(0,8)}... = ${amount} XRS (slot ${block.slot})`);
                            return { from: embeddedFrom, to: embeddedTo, amount, slot: block.slot };
                        }
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

// Fallback: check if escrow balance increased (balance-based deposit detection)
async function checkDepositByBalance(gameId, betAmount) {
    const currentBalance = await getBalance(escrowWallet.address);
    const expectedIncrease = betAmount;

    if (currentBalance >= lastEscrowBalance + expectedIncrease) {
        console.log(`[DEPOSIT] Balance-based detection: ${lastEscrowBalance} -> ${currentBalance} XRS (+${currentBalance - lastEscrowBalance})`);
        lastEscrowBalance = currentBalance;
        return true;
    }
    return false;
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

    // Primary: search for transaction from player to escrow in recent blocks
    const tx = await findDepositTransaction(playerWallet, betAmount);

    if (tx) {
        confirmedDeposits.set(depositKey, tx.slot);
        return true;
    }

    // Fallback: check if escrow balance increased by at least betAmount
    const balanceMatch = await checkDepositByBalance(gameId, betAmount);
    if (balanceMatch) {
        confirmedDeposits.set(depositKey, 'balance-check');
        console.log(`[DEPOSIT] Confirmed via balance check for ${playerWallet.slice(0,8)}...`);
        return true;
    }

    return false;
}

// Track pending payouts for manual processing if auto-payout fails
const pendingPayouts = [];

// ===== Bincode / Transaction Encoding Helpers =====
function u32LE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    return buf;
}

function u64LE(value) {
    const big = BigInt(value);
    const buf = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
        buf[i] = Number((big >> BigInt(i * 8)) & 0xFFn);
    }
    return buf;
}

function encodeString(str) {
    const encoded = Buffer.from(str, 'utf8');
    return Buffer.concat([u64LE(encoded.length), encoded]);
}

function encodeCompactU16(value) {
    const out = [];
    let v = value;
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>= 7; }
    out.push(v & 0x7f);
    return Buffer.from(out);
}

// Encode NativeTransfer instruction (variant 11) - for XRS coin transfers
function encodeNativeTransfer(from, to, amountLamports) {
    return Buffer.concat([
        u32LE(11),              // variant index: NativeTransfer
        encodeString(from),     // sender address
        encodeString(to),       // recipient address
        u64LE(amountLamports)   // amount in lamports
    ]);
}

// Pad base58-decoded pubkey to exactly 32 bytes
function padPubkey(decoded) {
    if (decoded.length === 32) return Buffer.from(decoded);
    const padded = Buffer.alloc(32, 0);
    Buffer.from(decoded).copy(padded, 32 - decoded.length);
    return padded;
}

// Build Solana legacy message
function buildMessage(signerPubkey, instructionData, blockhash) {
    const programId = Buffer.alloc(32, 0); // Pubkey::default()
    return Buffer.concat([
        Buffer.from([1, 0, 1]),             // header: 1 required sig, 0 readonly signed, 1 readonly unsigned
        encodeCompactU16(2),                // 2 accounts
        signerPubkey,                       // account[0] = signer
        programId,                          // account[1] = program_id
        blockhash,                          // 32 bytes recent blockhash
        encodeCompactU16(1),                // 1 instruction
        Buffer.from([1]),                   // program_id_index = 1 (account[1])
        encodeCompactU16(1),                // 1 account reference in instruction
        Buffer.from([0]),                   // account_index = 0 (signer)
        encodeCompactU16(instructionData.length),
        instructionData
    ]);
}

// Build signed transaction in Solana wire format
function assembleSignedTx(signature, messageBytes) {
    return Buffer.concat([
        encodeCompactU16(1),    // 1 signature
        signature,              // 64-byte Ed25519 signature
        messageBytes
    ]);
}

// Fetch recent blockhash from node
async function fetchRecentBlockhash() {
    // Try JSON-RPC first (port 50008)
    try {
        const rpcData = await new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'getRecentBlockhash', params: []
            });
            const req = http.request({
                hostname: '138.197.116.81',
                port: XRS_EXPLORER_PORT,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 5000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(postData);
            req.end();
        });

        if (rpcData?.result?.value?.blockhash) {
            const hex = rpcData.result.value.blockhash;
            const bytes = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            console.log(`[BLOCKHASH] Got from RPC: ${hex.slice(0, 16)}...`);
            return bytes;
        }
    } catch (e) {
        console.log(`[BLOCKHASH] RPC failed: ${e.message}, trying REST...`);
    }

    // Fallback: REST /blocks on port 56001
    const blocksData = await apiCall(XRS_NETWORK_PORT, '/blocks?limit=1');
    if (Array.isArray(blocksData) && blocksData.length > 0 && blocksData[0].hash) {
        const hash = blocksData[0].hash;
        if (Array.isArray(hash) && hash.length === 32) {
            console.log(`[BLOCKHASH] Got from REST /blocks`);
            return Buffer.from(hash);
        }
    }

    throw new Error('Could not fetch recent blockhash from either endpoint');
}

// Submit signed transaction to node
function submitTransaction(tx_base64) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({ tx_base64 });
        const req = http.request({
            hostname: '138.197.116.81',
            port: XRS_NETWORK_PORT,
            path: '/submit',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    // Node returns 200 even for errors - must check body
                    if (parsed.error) {
                        resolve({ ok: false, error: parsed.error, raw: data });
                    } else if (parsed.status === 'ok' || parsed.signature) {
                        resolve({ ok: true, signature: parsed.signature, raw: data });
                    } else {
                        resolve({ ok: false, error: 'Unknown response', raw: data });
                    }
                } catch (e) {
                    resolve({ ok: false, error: 'Invalid JSON response', raw: data });
                }
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timeout' }); });
        req.write(postData);
        req.end();
    });
}

// Send XRS payout using signed NativeTransfer transaction
async function sendPayout(toAddress, amount, reason) {
    try {
        const nacl = require('tweetnacl');
        const bs58 = require('bs58');

        const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_XRS));

        console.log(`[PAYOUT] Sending ${amount} XRS (${lamports} lamports) to ${toAddress.slice(0,8)}... (${reason})`);

        // 1. Encode NativeTransfer instruction (variant 11)
        const instructionData = encodeNativeTransfer(escrowWallet.address, toAddress, lamports);

        // 2. Fetch recent blockhash
        const blockhash = await fetchRecentBlockhash();

        // 3. Decode signer pubkey (pad to 32 bytes)
        const signerPubkey = padPubkey(bs58.decode(escrowWallet.address));

        // 4-5. Build message
        const messageBytes = buildMessage(signerPubkey, instructionData, blockhash);

        // 6. Sign with escrow private key
        const secretKey = bs58.decode(escrowWallet.privateKey);
        const signature = nacl.sign.detached(messageBytes, secretKey);

        if (signature.length !== 64) {
            throw new Error(`Bad signature length: ${signature.length}`);
        }

        // 7. Assemble signed transaction
        const signedTx = assembleSignedTx(Buffer.from(signature), messageBytes);
        const tx_base64 = signedTx.toString('base64');

        console.log(`[PAYOUT] Signed TX: ${signedTx.length} bytes, base64: ${tx_base64.length} chars`);

        // 8. Submit
        const result = await submitTransaction(tx_base64);

        if (result.ok) {
            console.log(`[PAYOUT] SUCCESS: ${amount} XRS to ${toAddress.slice(0,8)}... sig=${result.signature} (${reason})`);
            // Update tracked balance so deposit detection stays accurate
            lastEscrowBalance = Math.max(0, lastEscrowBalance - amount);
            return true;
        } else {
            console.log(`[PAYOUT] FAILED: ${result.error} | raw: ${result.raw}`);
            pendingPayouts.push({
                to: toAddress,
                amount: amount,
                reason: reason,
                timestamp: new Date().toISOString(),
                error: result.error || result.raw
            });
            console.log(`[PAYOUT] Added to pending payouts: ${amount} XRS to ${toAddress}`);
            return false;
        }
    } catch (e) {
        console.log(`[PAYOUT ERR] ${e.message}`);
        pendingPayouts.push({
            to: toAddress,
            amount: amount,
            reason: reason,
            timestamp: new Date().toISOString(),
            error: e.message
        });
        console.log(`[PAYOUT] Added to pending payouts: ${amount} XRS to ${toAddress}`);
        return false;
    }
}

// HTTP Server
const server = http.createServer((req, res) => {
    // CORS headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Proxy: Blockhash endpoint (for client-side WalletConnect tx building)
    if (req.url === '/api/xeris/blockhash') {
        fetchRecentBlockhash().then(bytes => {
            // Return as hex string for easy client consumption
            const hex = Buffer.from(bytes).toString('hex');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blockhash: hex, format: 'hex' }));
        }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }

    // Proxy: Submit signed transaction (for client-side WalletConnect deposits)
    if (req.url === '/api/xeris/submit' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { tx_base64 } = JSON.parse(body);
                if (!tx_base64 || !/^[A-Za-z0-9+/]+=*$/.test(tx_base64)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid base64 encoding' }));
                    return;
                }
                const result = await submitTransaction(tx_base64);
                if (result.ok) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', signature: result.signature }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: result.error }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
        });
        return;
    }

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
    
    // Tournament: Get current tournament
    if (req.url === '/api/tournament') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tournament: activeTournament }));
        return;
    }
    
    // Admin: Create tournament (POST with ?name=X&size=8&entry=100&prize=1000&key=secret)
    if (req.url.startsWith('/api/tournament/create')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const name = url.searchParams.get('name') || 'Championship Night';
        const size = parseInt(url.searchParams.get('size')) || 8;
        const entryFee = parseInt(url.searchParams.get('entry')) || 100;
        const prizePool = parseInt(url.searchParams.get('prize')) || 0;
        const adminKey = url.searchParams.get('key');
        
        // Simple admin auth - in production use proper auth
        if (adminKey !== (process.env.ADMIN_KEY || 'xerisadmin')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        if (activeTournament && activeTournament.status !== 'finished') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tournament already active' }));
            return;
        }
        
        activeTournament = {
            id: 't' + (++tournamentCounter),
            name,
            size: size === 16 ? 16 : 8,
            entryFee,
            prizePool,
            players: [],
            bracket: [],
            currentRound: 0,
            status: 'registration',
            winner: null,
            createdAt: Date.now()
        };
        
        // Broadcast tournament created
        broadcastTournament();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tournament: activeTournament }));
        console.log(`[TOURNAMENT] Created: ${name} (${size} players, ${entryFee} XRS entry, ${prizePool} XRS prize)`);
        return;
    }
    
    // Admin: Start tournament
    if (req.url.startsWith('/api/tournament/start')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const adminKey = url.searchParams.get('key');
        
        if (adminKey !== (process.env.ADMIN_KEY || 'xerisadmin')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        if (!activeTournament || activeTournament.status !== 'registration') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No tournament in registration' }));
            return;
        }
        
        if (activeTournament.players.length < activeTournament.size) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Need ${activeTournament.size} players, have ${activeTournament.players.length}` }));
            return;
        }
        
        startTournament();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tournament: activeTournament }));
        return;
    }
    
    // Championship Interest Registration
    if (req.url === '/api/championship/register' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const name = String(data.name || '').trim().slice(0, 30);
                const contact = String(data.contact || '').trim().slice(0, 50);
                const wallet = String(data.wallet || '').trim().slice(0, 60);
                
                if (!name || name.length < 2) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Name required' }));
                    return;
                }
                
                // Add to interest list
                championshipInterest.push({
                    name,
                    contact,
                    wallet,
                    timestamp: Date.now()
                });
                
                // Save to file
                saveChampionshipInterest();
                
                console.log(`[CHAMPIONSHIP] Interest registered: ${name} (${contact || 'no contact'})`);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, count: championshipInterest.length }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
        return;
    }
    
    // Championship Interest Count
    if (req.url === '/api/championship/count') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: championshipInterest.length }));
        return;
    }
    
    // Admin: View Championship Registrations
    if (req.url.startsWith('/api/championship/list')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const adminKey = url.searchParams.get('key');
        
        if (adminKey !== (process.env.ADMIN_KEY || 'xerisadmin')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            count: championshipInterest.length,
            registrations: championshipInterest 
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
        deposited: false,
        spectatingGame: null
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
            
            // Check if this wallet is in an active game (reconnection)
            let activeGame = null;
            let activeGameId = null;
            let playerColor = null;
            
            // Clear any pending disconnect timeout
            if (disconnectedPlayers.has(msg.wallet)) {
                const disconnectInfo = disconnectedPlayers.get(msg.wallet);
                activeGameId = disconnectInfo.gameId;
                playerColor = disconnectInfo.color;
                activeGame = games.get(activeGameId);
                disconnectedPlayers.delete(msg.wallet);
                console.log(`[RECONNECT] ${msg.wallet.slice(0,8)}... cleared disconnect timer`);
            } else if (msg.reconnect) {
                // Also check games directly
                for (const [gid, game] of games) {
                    if (game.started && !game.ended) {
                        if (game.whiteWallet === msg.wallet) {
                            activeGame = game;
                            activeGameId = gid;
                            playerColor = 'white';
                            break;
                        } else if (game.blackWallet === msg.wallet) {
                            activeGame = game;
                            activeGameId = gid;
                            playerColor = 'black';
                            break;
                        }
                    }
                }
            }
            
            // Update player reference in game if reconnecting
            if (activeGame && activeGameId) {
                if (playerColor === 'white') {
                    activeGame.white = playerId;
                } else {
                    activeGame.black = playerId;
                }
            }
            
            if (existingUser) {
                player.username = existingUser.username;
                
                // If reconnecting to active game
                if (activeGame) {
                    player.gameId = activeGameId;
                    player.color = playerColor;
                    player.deposited = true;
                    
                    send(player.ws, { 
                        type: 'wallet_connected', 
                        existingUsername: existingUser.username,
                        stats: existingUser
                    });
                    
                    // Send reconnected message with game state
                    send(player.ws, {
                        type: 'reconnected',
                        inGame: true,
                        gameId: activeGameId,
                        color: playerColor,
                        fen: activeGame.chess.fen(),
                        turn: activeGame.chess.turn() === 'w' ? 'white' : 'black',
                        inCheck: activeGame.chess.inCheck(),
                        pot: activeGame.pot,
                        whiteName: activeGame.whiteName,
                        blackName: activeGame.blackName
                    });
                    
                    console.log(`[RECONNECT] ${playerId} -> ${msg.wallet.slice(0,8)}... rejoined game ${activeGameId} as ${playerColor}`);
                } else {
                    send(player.ws, { 
                        type: 'wallet_connected', 
                        existingUsername: existingUser.username,
                        stats: existingUser
                    });
                    console.log(`[WALLET] ${playerId} -> ${msg.wallet.slice(0,8)}... (${existingUser.username})`);
                }
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
            handleChallenge(playerId, msg.targetId, challengeBet, msg.queued || false);
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
            
        case 'get_active_games':
            sendActiveGames(playerId);
            break;
            
        case 'spectate':
            handleSpectate(playerId, msg.gameId);
            break;
            
        case 'leave_spectate':
            handleLeaveSpectate(playerId);
            break;
            
        case 'get_tournament':
            send(player.ws, { type: 'tournament_update', tournament: activeTournament });
            break;
            
        case 'join_tournament':
            handleJoinTournament(playerId);
            break;
            
        case 'leave_tournament':
            handleLeaveTournament(playerId);
            break;
            
        case 'ping':
            send(player.ws, { type: 'pong' });
            break;
            
        case 'chat':
            handleChat(playerId, msg.text);
            break;
            
        case 'spectator_chat':
            handleSpectatorChat(playerId, msg.text);
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

// Spectate functions
function getActiveGames() {
    const activeGames = [];
    for (const [gameId, game] of games) {
        if (game.started) {
            activeGames.push({
                gameId,
                whiteName: game.whiteName,
                blackName: game.blackName,
                bet: game.bet,
                spectators: game.spectators?.length || 0
            });
        }
    }
    return activeGames;
}

function sendActiveGames(playerId) {
    const player = players.get(playerId);
    if (!player) return;
    
    send(player.ws, {
        type: 'active_games',
        games: getActiveGames()
    });
}

function handleSpectate(playerId, gameId) {
    const player = players.get(playerId);
    if (!player) return;
    
    // Can't spectate if already in a game
    if (player.gameId) {
        send(player.ws, { type: 'error', message: 'Leave your current game first' });
        return;
    }
    
    const game = games.get(gameId);
    if (!game || !game.started) {
        send(player.ws, { type: 'error', message: 'Game not found' });
        return;
    }
    
    // Add to spectators
    if (!game.spectators) game.spectators = [];
    if (!game.spectators.includes(playerId)) {
        game.spectators.push(playerId);
    }
    
    player.spectatingGame = gameId;
    
    // Send current game state
    send(player.ws, {
        type: 'spectate_start',
        gameId,
        whiteName: game.whiteName,
        blackName: game.blackName,
        bet: game.bet,
        pot: game.pot,
        fen: game.chess.fen(),
        turn: game.chess.turn() === 'w' ? 'white' : 'black',
        inCheck: game.chess.inCheck()
    });
    
    console.log(`[SPECTATE] ${player.username} watching ${gameId}`);
}

function handleLeaveSpectate(playerId) {
    const player = players.get(playerId);
    if (!player?.spectatingGame) return;
    
    const game = games.get(player.spectatingGame);
    if (game?.spectators) {
        game.spectators = game.spectators.filter(id => id !== playerId);
    }
    
    player.spectatingGame = null;
    send(player.ws, { type: 'spectate_ended' });
}

// Challenge functions
function handleChallenge(fromId, toId, bet, queued = false) {
    const from = players.get(fromId);
    const to = players.get(toId);
    
    if (!from || !to || !from.username || !to.username) {
        send(from?.ws, { type: 'error', message: 'Invalid challenge target' });
        return;
    }
    
    // Check if target is in a game
    if (to.gameId) {
        if (queued) {
            // Add to queue
            if (!to.challengeQueue) to.challengeQueue = [];
            
            // Don't allow duplicate queued challenges
            if (to.challengeQueue.some(q => q.fromId === fromId)) {
                send(from.ws, { type: 'error', message: 'You already have a queued challenge for this player' });
                return;
            }
            
            to.challengeQueue.push({ fromId, bet, timestamp: Date.now() });
            send(from.ws, { type: 'challenge_queued', toUsername: to.username });
            console.log(`[CHALLENGE] ${from.username} -> ${to.username} (QUEUED, ${bet} XRS)`);
        } else {
            send(from.ws, { type: 'player_in_game', toUsername: to.username, toId });
        }
        return;
    }
    
    // Check if challenger is in a game
    if (from.gameId) {
        send(from.ws, { type: 'error', message: 'Finish your current game first' });
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

function processQueuedChallenges(playerId) {
    const player = players.get(playerId);
    if (!player || !player.challengeQueue || player.challengeQueue.length === 0) return;
    if (player.gameId) return; // Still in a game
    
    // Get the oldest queued challenge
    const queued = player.challengeQueue.shift();
    if (!queued) return;
    
    const challenger = players.get(queued.fromId);
    if (!challenger || !challenger.ws || challenger.gameId) {
        // Challenger disconnected or in a game, try next
        if (player.challengeQueue.length > 0) {
            processQueuedChallenges(playerId);
        }
        return;
    }
    
    // Send the challenge now
    const challengeId = 'c' + (++challengeCounter);
    challenges.set(challengeId, { from: queued.fromId, to: playerId, timestamp: Date.now(), bet: queued.bet });
    
    send(player.ws, {
        type: 'challenge_received',
        challengeId,
        fromUsername: challenger.username,
        fromId: queued.fromId,
        bet: queued.bet,
        wasQueued: true
    });
    
    send(challenger.ws, {
        type: 'queued_challenge_sent',
        toUsername: player.username
    });
    
    console.log(`[CHALLENGE] ${challenger.username} -> ${player.username} (FROM QUEUE, ${queued.bet} XRS)`);
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
        bet: bet, // Store bet amount per game
        spectators: [] // Track spectators
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
                turn: game.chess.turn() === 'w' ? 'white' : 'black',
                inCheck: game.chess.inCheck()
            };
            
            // Send to players
            send(players.get(game.white)?.ws, moveData);
            send(players.get(game.black)?.ws, moveData);
            
            // Send to spectators
            if (game.spectators) {
                game.spectators.forEach(specId => {
                    const spec = players.get(specId);
                    if (spec) send(spec.ws, moveData);
                });
            }
            
            console.log(`[MOVE] ${player.gameId}: ${move.san}${game.chess.inCheck() ? '+' : ''}`);
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

function handleChat(playerId, text) {
    const player = players.get(playerId);
    if (!player?.gameId || !player.username || !text) return;
    
    const game = games.get(player.gameId);
    if (!game || !game.started) return;
    
    // Sanitize and limit text
    const safeText = String(text).trim().slice(0, 100);
    if (!safeText) return;
    
    const chatMsg = {
        type: 'chat',
        sender: player.username,
        text: safeText
    };
    
    // Send to both players
    const whitePlayer = players.get(game.white);
    const blackPlayer = players.get(game.black);
    if (whitePlayer) send(whitePlayer.ws, chatMsg);
    if (blackPlayer) send(blackPlayer.ws, chatMsg);
    
    // Also send to spectators
    if (game.spectators) {
        game.spectators.forEach(specId => {
            const spec = players.get(specId);
            if (spec) send(spec.ws, chatMsg);
        });
    }
}

function handleSpectatorChat(playerId, text) {
    const player = players.get(playerId);
    if (!player?.spectatingGame || !player.username || !text) return;
    
    const game = games.get(player.spectatingGame);
    if (!game || !game.started) return;
    
    // Sanitize and limit text
    const safeText = String(text).trim().slice(0, 100);
    if (!safeText) return;
    
    const chatMsg = {
        type: 'chat',
        sender: '👁️ ' + player.username, // Prefix to show they're a spectator
        text: safeText
    };
    
    // Send to both players
    const whitePlayer = players.get(game.white);
    const blackPlayer = players.get(game.black);
    if (whitePlayer) send(whitePlayer.ws, chatMsg);
    if (blackPlayer) send(blackPlayer.ws, chatMsg);
    
    // Also send to all spectators
    if (game.spectators) {
        game.spectators.forEach(specId => {
            const spec = players.get(specId);
            if (spec) send(spec.ws, chatMsg);
        });
    }
}

// Track disconnected players for reconnection grace period
const disconnectedPlayers = new Map(); // wallet -> { gameId, color, timestamp }

function handleDisconnect(playerId) {
    // Remove from all waiting pools
    for (const [bet, pid] of waitingPlayers) {
        if (pid === playerId) {
            waitingPlayers.delete(bet);
            break;
        }
    }
    
    const player = players.get(playerId);
    
    // Handle spectator disconnect
    if (player?.spectatingGame) {
        const game = games.get(player.spectatingGame);
        if (game?.spectators) {
            game.spectators = game.spectators.filter(id => id !== playerId);
        }
    }
    
    // Handle player in game disconnect - give grace period for reconnection
    if (player?.gameId && player?.wallet) {
        const game = games.get(player.gameId);
        if (game?.started && !game.ended) {
            // Store disconnect info for potential reconnection
            disconnectedPlayers.set(player.wallet, {
                gameId: player.gameId,
                color: player.color,
                timestamp: Date.now()
            });
            
            // Set timeout to forfeit if not reconnected (60 seconds)
            setTimeout(() => {
                const disconnectInfo = disconnectedPlayers.get(player.wallet);
                if (disconnectInfo && disconnectInfo.gameId === player.gameId) {
                    // Still disconnected, forfeit
                    const gameStillActive = games.get(player.gameId);
                    if (gameStillActive && gameStillActive.started && !gameStillActive.ended) {
                        const winner = player.color === 'white' ? 'black' : 'white';
                        endGame(player.gameId, winner, 'opponent disconnected');
                        console.log(`[FORFEIT] ${player.wallet.slice(0,8)}... timed out after 60s`);
                    }
                    disconnectedPlayers.delete(player.wallet);
                }
            }, 60000); // 60 second grace period
            
            console.log(`[DISCONNECT] ${player.wallet.slice(0,8)}... - 60s grace period started`);
            return; // Don't immediately end game
        } else if (game && !game.started) {
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
    if (!game || game.ended) return;
    
    // Mark as ended immediately to prevent double processing
    game.ended = true;
    
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
        // Refund both on draw — give remainder to white to avoid losing lamports
        const halfPot = Math.floor(game.pot / 2);
        const remainder = game.pot - halfPot * 2;
        if (game.whiteWallet) await sendPayout(game.whiteWallet, halfPot + remainder, 'draw-refund');
        if (game.blackWallet) await sendPayout(game.blackWallet, halfPot, 'draw-refund');
        payoutSuccess = true;
    }
    
    const endData = { 
        type: 'game_over', 
        winner: result,
        reason,
        pot: game.pot,
        bet: betAmount,
        prize: result === 'draw' ? Math.floor(game.pot / 2) : winnerPrize,
        payoutSuccess,
        whiteName: game.whiteName,
        blackName: game.blackName
    };
    
    // Notify players
    [game.white, game.black].forEach(id => {
        const p = players.get(id);
        if (p) {
            send(p.ws, endData);
            p.gameId = null;
            p.color = null;
            p.deposited = false;
            
            // Process queued challenges after a short delay
            setTimeout(() => processQueuedChallenges(id), 2000);
        }
    });
    
    // Notify spectators
    if (game.spectators) {
        const spectatorEndData = { ...endData, type: 'spectate_game_over' };
        game.spectators.forEach(specId => {
            const spec = players.get(specId);
            if (spec) {
                send(spec.ws, spectatorEndData);
                spec.spectatingGame = null;
            }
        });
    }
    
    games.delete(gameId);
    console.log(`[END] ${gameId}: ${result} wins (${reason}) - Prize: ${winnerPrize} XRS`);
    broadcastLobby();
    
    // Check if this was a tournament game
    if (game.tournamentId && activeTournament) {
        handleTournamentGameEnd(gameId, result);
    }
}

// TOURNAMENT FUNCTIONS
function broadcastTournament() {
    for (const [pid, p] of players) {
        if (p.username) {
            send(p.ws, { type: 'tournament_update', tournament: activeTournament });
        }
    }
}

function handleJoinTournament(playerId) {
    const player = players.get(playerId);
    if (!player || !player.username || !player.wallet) {
        send(player?.ws, { type: 'error', message: 'Connect wallet first' });
        return;
    }
    
    if (!activeTournament || activeTournament.status !== 'registration') {
        send(player.ws, { type: 'error', message: 'No tournament open for registration' });
        return;
    }
    
    if (activeTournament.players.length >= activeTournament.size) {
        send(player.ws, { type: 'error', message: 'Tournament is full' });
        return;
    }
    
    // Check if already registered
    if (activeTournament.players.some(p => p.oderId === playerId)) {
        send(player.ws, { type: 'error', message: 'Already registered' });
        return;
    }
    
    activeTournament.players.push({
        oderId: playerId,
        username: player.username,
        wallet: player.wallet
    });
    
    console.log(`[TOURNAMENT] ${player.username} joined (${activeTournament.players.length}/${activeTournament.size})`);
    broadcastTournament();
}

function handleLeaveTournament(playerId) {
    if (!activeTournament || activeTournament.status !== 'registration') return;
    
    activeTournament.players = activeTournament.players.filter(p => p.oderId !== playerId);
    broadcastTournament();
}

function startTournament() {
    if (!activeTournament || activeTournament.players.length < activeTournament.size) return;
    
    activeTournament.status = 'in_progress';
    
    // Shuffle players
    const shuffled = [...activeTournament.players].sort(() => Math.random() - 0.5);
    
    // Create first round bracket
    const round1 = [];
    for (let i = 0; i < shuffled.length; i += 2) {
        round1.push({
            player1: shuffled[i],
            player2: shuffled[i + 1],
            gameId: null,
            winner: null,
            status: 'pending'
        });
    }
    
    activeTournament.bracket = [round1];
    activeTournament.currentRound = 0;
    
    console.log(`[TOURNAMENT] Started: ${activeTournament.name}`);
    broadcastTournament();
    
    // Start first round matches
    startTournamentRound();
}

function startTournamentRound() {
    if (!activeTournament || activeTournament.status !== 'in_progress') return;
    
    const currentMatches = activeTournament.bracket[activeTournament.currentRound];
    if (!currentMatches) return;
    
    for (const match of currentMatches) {
        if (match.status === 'pending' && match.player1 && match.player2) {
            // Create tournament game
            createTournamentGame(match);
        }
    }
}

function createTournamentGame(match) {
    const p1 = players.get(match.player1.oderId);
    const p2 = players.get(match.player2.oderId);
    
    if (!p1 || !p2) {
        // Handle disconnected player - auto-win for other
        if (p1 && !p2) {
            match.winner = match.player1;
            match.status = 'complete';
        } else if (p2 && !p1) {
            match.winner = match.player2;
            match.status = 'complete';
        }
        broadcastTournament();
        checkRoundComplete();
        return;
    }
    
    const gameId = 'tg' + (++gameCounter);
    const chess = new Chess();
    
    // Randomize colors
    let whiteId = match.player1.oderId;
    let blackId = match.player2.oderId;
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
        whiteDeposit: true, // Auto-confirmed for tournament
        blackDeposit: true,
        started: true,
        pot: 0, // No pot for tournament games
        bet: 0,
        tournamentId: activeTournament.id,
        matchIndex: activeTournament.bracket[activeTournament.currentRound].indexOf(match)
    });
    
    match.gameId = gameId;
    match.status = 'in_progress';
    
    whitePlayer.gameId = gameId;
    whitePlayer.color = 'white';
    blackPlayer.gameId = gameId;
    blackPlayer.color = 'black';
    
    // Send game start
    const gameData = {
        type: 'tournament_game_start',
        gameId,
        fen: chess.fen(),
        turn: 'white',
        pot: 0,
        tournamentName: activeTournament.name,
        round: activeTournament.currentRound + 1
    };
    
    send(whitePlayer.ws, { ...gameData, color: 'white', whiteName: whitePlayer.username, blackName: blackPlayer.username });
    send(blackPlayer.ws, { ...gameData, color: 'black', whiteName: whitePlayer.username, blackName: blackPlayer.username });
    
    console.log(`[TOURNAMENT] Match: ${whitePlayer.username} vs ${blackPlayer.username}`);
    broadcastTournament();
}

function handleTournamentGameEnd(gameId, result) {
    const game = games.get(gameId);
    if (!game || !activeTournament) return;
    
    const currentMatches = activeTournament.bracket[activeTournament.currentRound];
    const match = currentMatches?.find(m => m.gameId === gameId);
    if (!match) return;
    
    // Determine winner
    if (result === 'white') {
        match.winner = match.player1.oderId === game.white ? match.player1 : match.player2;
    } else if (result === 'black') {
        match.winner = match.player1.oderId === game.black ? match.player1 : match.player2;
    } else {
        // Draw - replay needed (for simplicity, give to player1)
        match.winner = match.player1;
    }
    match.status = 'complete';
    
    console.log(`[TOURNAMENT] ${match.winner.username} advances!`);
    broadcastTournament();
    
    checkRoundComplete();
}

function checkRoundComplete() {
    if (!activeTournament) return;
    
    const currentMatches = activeTournament.bracket[activeTournament.currentRound];
    const allComplete = currentMatches.every(m => m.status === 'complete');
    
    if (!allComplete) return;
    
    // Get winners
    const winners = currentMatches.map(m => m.winner).filter(Boolean);
    
    if (winners.length === 1) {
        // Tournament complete!
        activeTournament.winner = winners[0];
        activeTournament.status = 'finished';
        
        // Calculate total prize
        const totalPrize = activeTournament.prizePool + (activeTournament.entryFee * activeTournament.size);
        
        // Send payout to winner
        if (winners[0].wallet && totalPrize > 0) {
            sendPayout(winners[0].wallet, totalPrize, 'tournament-win');
        }
        
        console.log(`[TOURNAMENT] WINNER: ${winners[0].username} takes ${totalPrize} XRS!`);
        broadcastTournament();
    } else {
        // Create next round
        const nextRound = [];
        for (let i = 0; i < winners.length; i += 2) {
            nextRound.push({
                player1: winners[i],
                player2: winners[i + 1] || null,
                gameId: null,
                winner: winners[i + 1] ? null : winners[i], // Auto-advance if odd
                status: winners[i + 1] ? 'pending' : 'complete'
            });
        }
        
        activeTournament.bracket.push(nextRound);
        activeTournament.currentRound++;
        
        console.log(`[TOURNAMENT] Round ${activeTournament.currentRound + 1} starting...`);
        broadcastTournament();
        
        // Start next round after short delay
        setTimeout(() => startTournamentRound(), 5000);
    }
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
