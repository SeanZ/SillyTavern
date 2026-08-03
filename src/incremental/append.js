/**
 * Append messages to a chat JSONL file.
 *
 * Core operation for incremental saves: when the user sends a new message or
 * the AI generates a reply, only the new message(s) need to be appended —
 * not the entire chat history.
 */

import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { validateIntegrity, readIntegrity, writeIntegrity, generateIntegrity } from './integrity.js';

/**
 * Reads the last non-empty line from a file without loading the entire file.
 * For JSONL files this is the last message.
 * @param {string} filePath
 * @returns {string | null}
 */
function readLastLine(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        return lines.length > 0 ? lines[lines.length - 1] : null;
    } catch {
        return null;
    }
}

/**
 * Strips transient fields from a message for dedup comparison.
 * @param {object} msg
 * @returns {object}
 */
function stripTransientFields(msg) {
    const clone = _.cloneDeep(msg);
    if (clone.extra) {
        delete clone.extra.gen_id;
    }
    return clone;
}

/**
 * @typedef {Object} AppendResult
 * @property {number} appended - Number of messages actually appended (after dedup).
 * @property {number} skipped - Number of messages skipped due to dedup.
 * @property {boolean} created - Whether the chat file was newly created.
 * @property {string} integrity - New integrity slug after the write.
 */

/**
 * Appends messages to a chat JSONL file with deduplication and integrity check.
 *
 * @param {object} options
 * @param {string} options.chatFilePath - Absolute path to the `.jsonl` file.
 * @param {object[]} options.messages - Messages to append.
 * @param {object} [options.chatMetadata={}] - Metadata for header (used only on create).
 * @param {string} [options.integrity=''] - Client-provided integrity slug.
 * @param {boolean} [options.force=false] - Skip integrity check.
 * @returns {AppendResult}
 */
export function appendMessages({ chatFilePath, messages, chatMetadata = {}, integrity = '', force = false }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { appended: 0, skipped: 0, created: false, integrity: '' };
    }

    const fileExists = fs.existsSync(chatFilePath);

    // Integrity validation
    if (fileExists) {
        const validation = validateIntegrity(chatFilePath, integrity, force);
        if (!validation.valid) {
            const error = new Error(`Integrity mismatch: expected "${integrity}", server has "${validation.current}"`);
            error.code = 'INTEGRITY_CONFLICT';
            error.currentIntegrity = validation.current;
            throw error;
        }
    }

    // If file doesn't exist, create it with header + messages
    if (!fileExists) {
        const dir = path.dirname(chatFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const header = {
            chat_metadata: chatMetadata || {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
        fs.writeFileSync(chatFilePath, lines, 'utf8');

        const newIntegrity = generateIntegrity();
        writeIntegrity(chatFilePath, newIntegrity);
        return { appended: messages.length, skipped: 0, created: true, integrity: newIntegrity };
    }

    // Dedup: compare new messages against the last stored message
    const lastLine = readLastLine(chatFilePath);
    let lastMessage = null;
    if (lastLine) {
        try {
            lastMessage = JSON.parse(lastLine);
        } catch {
            // If last line is unparseable, skip dedup
        }
    }

    const dedupedMessages = [...messages];
    let skipped = 0;

    if (lastMessage && dedupedMessages.length > 0) {
        const lastStripped = stripTransientFields(lastMessage);
        const firstNewStripped = stripTransientFields(dedupedMessages[0]);
        if (_.isEqual(lastStripped, firstNewStripped)) {
            dedupedMessages.shift();
            skipped++;
        }
    }

    if (dedupedMessages.length === 0) {
        // All messages were duplicates; return current integrity without writing
        const currentIntegrity = readIntegrity(chatFilePath) || '';
        return { appended: 0, skipped, created: false, integrity: currentIntegrity };
    }

    // Append to file
    const serialized = dedupedMessages.map(m => JSON.stringify(m)).join('\n');
    fs.appendFileSync(chatFilePath, '\n' + serialized, 'utf8');

    // Rotate integrity
    const newIntegrity = generateIntegrity();
    writeIntegrity(chatFilePath, newIntegrity);

    return { appended: dedupedMessages.length, skipped, created: false, integrity: newIntegrity };
}
