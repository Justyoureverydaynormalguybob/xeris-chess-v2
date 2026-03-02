/**
 * Xeris Transaction Builder (client-side, zero dependencies)
 * Handles bincode encoding + Solana wire format for window.xeris wallet signing
 */
const XerisTx = (() => {
    // Base58 alphabet
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = {};
    for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

    function base58Decode(str) {
        if (str.length === 0) return new Uint8Array(0);
        const bytes = [0];
        for (const c of str) {
            let carry = ALPHABET_MAP[c];
            if (carry === undefined) throw new Error('Invalid base58 character: ' + c);
            for (let j = 0; j < bytes.length; j++) {
                carry += bytes[j] * 58;
                bytes[j] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
        }
        // Leading '1's = leading zero bytes
        for (const c of str) {
            if (c !== '1') break;
            bytes.push(0);
        }
        return new Uint8Array(bytes.reverse());
    }

    function base58DecodePubkey(str) {
        const raw = base58Decode(str);
        if (raw.length === 32) return raw;
        // Pad with leading zeros if < 32 bytes
        const padded = new Uint8Array(32);
        padded.set(raw, 32 - raw.length);
        return padded;
    }

    // Bincode primitives
    function u32LE(value) {
        const buf = new Uint8Array(4);
        buf[0] = value & 0xff;
        buf[1] = (value >> 8) & 0xff;
        buf[2] = (value >> 16) & 0xff;
        buf[3] = (value >> 24) & 0xff;
        return buf;
    }

    function u64LE(value) {
        const big = BigInt(value);
        const buf = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            buf[i] = Number((big >> BigInt(i * 8)) & 0xFFn);
        }
        return buf;
    }

    function encodeString(str) {
        const encoded = new TextEncoder().encode(str);
        return concat([u64LE(encoded.length), encoded]);
    }

    function concat(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const result = new Uint8Array(total);
        let offset = 0;
        for (const a of arrays) { result.set(a, offset); offset += a.length; }
        return result;
    }

    // Solana compact-u16 encoding
    function encodeCompactU16(value) {
        const out = [];
        let v = value;
        while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>= 7; }
        out.push(v & 0x7f);
        return new Uint8Array(out);
    }

    // NativeTransfer instruction (variant 11) - for XRS coin transfers
    function encodeNativeTransfer(from, to, amountLamports) {
        return concat([
            u32LE(11),
            encodeString(from),
            encodeString(to),
            u64LE(amountLamports)
        ]);
    }

    // Build Solana legacy message
    function buildMessage(signerPubkey, instructionData, blockhash) {
        const programId = new Uint8Array(32); // all zeros = Pubkey::default()
        return concat([
            new Uint8Array([1, 0, 1]),           // header
            encodeCompactU16(2),                 // 2 accounts
            signerPubkey,                        // account[0] = signer
            programId,                           // account[1] = program_id
            blockhash,                           // 32 bytes
            encodeCompactU16(1),                 // 1 instruction
            new Uint8Array([1]),                 // program_id_index = 1
            encodeCompactU16(1),                 // 1 account in instruction
            new Uint8Array([0]),                 // account index = 0
            encodeCompactU16(instructionData.length),
            instructionData
        ]);
    }

    // Wrap message in unsigned transaction (for wallet signing)
    function buildUnsignedTx(messageBytes) {
        const numSigs = encodeCompactU16(1);
        const emptySig = new Uint8Array(64); // placeholder
        return concat([numSigs, emptySig, messageBytes]);
    }

    // Assemble signed transaction (for node submission)
    function assembleSignedTx(signature, messageBytes) {
        if (signature.length !== 64) throw new Error('Signature must be 64 bytes, got ' + signature.length);
        return concat([encodeCompactU16(1), signature, messageBytes]);
    }

    // Extract 64-byte sig from wallet response (handles all formats)
    function extractSignature(walletResult) {
        if (walletResult && typeof walletResult === 'object'
            && !ArrayBuffer.isView(walletResult) && !Array.isArray(walletResult)) {
            if (walletResult.signature) {
                const sig = walletResult.signature instanceof Uint8Array
                    ? walletResult.signature : new Uint8Array(walletResult.signature);
                if (sig.length === 64) return sig;
            }
            if (walletResult.signedTransaction) {
                const txBytes = typeof walletResult.signedTransaction === 'string'
                    ? fromBase64(walletResult.signedTransaction)
                    : new Uint8Array(walletResult.signedTransaction);
                return extractSigFromTxBytes(txBytes);
            }
        }
        if (typeof walletResult === 'string') {
            return extractSigFromTxBytes(fromBase64(walletResult));
        }
        const bytes = walletResult instanceof Uint8Array
            ? walletResult : new Uint8Array(walletResult);
        if (bytes.length === 64) return bytes;
        if (bytes.length > 64) return extractSigFromTxBytes(bytes);
        throw new Error('Unexpected wallet response: ' + bytes.length + ' bytes');
    }

    function extractSigFromTxBytes(bytes) {
        if (bytes[0] === 1) {
            const isBincode = bytes[1]===0 && bytes[2]===0 && bytes[3]===0
                           && bytes[4]===0 && bytes[5]===0 && bytes[6]===0 && bytes[7]===0;
            if (isBincode && bytes.length >= 72) return bytes.slice(8, 72);
            return bytes.slice(1, 65);
        }
        let offset = 0;
        let count = bytes[offset] & 0x7f;
        if (bytes[offset] & 0x80) { offset++; count |= (bytes[offset] & 0x7f) << 7; }
        offset++;
        if (count >= 1 && offset + 64 <= bytes.length) return bytes.slice(offset, offset + 64);
        throw new Error('Could not extract signature from tx bytes');
    }

    // Base64 helpers
    function toBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function fromBase64(str) {
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Full sign + resolve helper: wallet result → base64 tx ready for /submit
    function resolveSignedTx(walletResult, messageBytes) {
        const sig = extractSignature(walletResult);
        const signedTx = assembleSignedTx(sig, messageBytes);
        return toBase64(signedTx);
    }

    // Fetch blockhash from our server proxy
    async function fetchRecentBlockhash() {
        const r = await fetch('/api/xeris/blockhash');
        const data = await r.json();
        if (data.error) throw new Error(data.error);

        if (data.format === 'hex' && typeof data.blockhash === 'string') {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(data.blockhash.substr(i * 2, 2), 16);
            return bytes;
        }
        if (Array.isArray(data.blockhash) && data.blockhash.length === 32) {
            return new Uint8Array(data.blockhash);
        }
        throw new Error('Unexpected blockhash format');
    }

    // Public API
    return {
        base58Decode,
        base58DecodePubkey,
        encodeNativeTransfer,
        buildMessage,
        buildUnsignedTx,
        assembleSignedTx,
        extractSignature,
        resolveSignedTx,
        fetchRecentBlockhash,
        toBase64,
        fromBase64,
        u32LE,
        u64LE,
        encodeString,
        concat,
        encodeCompactU16
    };
})();
