/**
 * Delta (incremental) chat loading.
 *
 * Reads a slice of messages from a JSONL chat file by index range.
 * Used to avoid transferring the entire chat history on page refresh
 * or when loading older messages ("Show More").
 *
 * References:
 *   - Luker's /get-delta: src/endpoints/chats.js:2789
 */

import fs from 'node:fs';
import { readIntegrity } from './integrity.js';

/**
 * @typedef {Object} DeltaResult
 * @property {object[]} chat - Messages in the requested range.
 * @property {object} chat_metadata - Chat header metadata.
 * @property {number} from_index - Actual start index of returned slice.
 * @property {number} next_index - Index after the last returned message.
 * @property {number} total_messages - Total number of messages in the chat.
 * @property {boolean} has_more - Whether there are more messages beyond next_index.
 * @property {string} integrity - Current integrity slug.
 */

/** @type {DeltaResult} */
const EMPTY_DELTA = {
    chat: [],
    chat_metadata: {},
    from_index: 0,
    next_index: 0,
    total_messages: 0,
    has_more: false,
    integrity: '',
};

/**
 * Reads a range of messages from a JSONL chat file.
 *
 * @param {object} options
 * @param {string} options.chatFilePath - Absolute path to the `.jsonl` file.
 * @param {number} [options.fromIndex=0] - Start index (0-based, message-only, excluding header).
 * @param {number} [options.limit=0] - Max messages to return (0 = all from fromIndex).
 * @returns {DeltaResult}
 */
export function getChatDelta({ chatFilePath, fromIndex = 0, limit = 0 }) {
    if (!fs.existsSync(chatFilePath)) {
        return { ...EMPTY_DELTA };
    }

    let content;
    try {
        content = fs.readFileSync(chatFilePath, 'utf8');
    } catch {
        return { ...EMPTY_DELTA };
    }

    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) {
        return { ...EMPTY_DELTA };
    }

    // First line is the header
    let chatMetadata = {};
    try {
        const header = JSON.parse(lines[0]);
        chatMetadata = header?.chat_metadata || {};
    } catch {
        // Header unparseable — continue with empty metadata
    }

    // Messages are lines[1..end]
    const messageLines = lines.slice(1);
    const total = messageLines.length;
    const start = Math.max(0, Math.min(fromIndex, total));
    const end = limit > 0 ? Math.min(start + limit, total) : total;

    const chatMessages = [];
    for (let i = start; i < end; i++) {
        try {
            chatMessages.push(JSON.parse(messageLines[i]));
        } catch {
            // Skip unparseable lines (shouldn't happen in well-formed files)
            chatMessages.push(null);
        }
    }

    const integrity = readIntegrity(chatFilePath) || '';

    return {
        chat: chatMessages.filter(Boolean),
        chat_metadata: chatMetadata,
        from_index: start,
        next_index: end,
        total_messages: total,
        has_more: end < total,
        integrity,
    };
}
