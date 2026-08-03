/**
 * Metadata deep-merge for chat files.
 *
 * Updates only the first line (header) of a JSONL chat file using deep merge,
 * without touching message lines. This dramatically reduces the transfer size
 * when only metadata (title, tags, settings) changes.
 */

import fs from 'node:fs';
import _ from 'lodash';
import { validateIntegrity, writeIntegrity, generateIntegrity } from './integrity.js';

/**
 * @typedef {Object} MetaPatchResult
 * @property {string} integrity - New integrity slug after the write.
 */

/**
 * Deep-merges metadata into the chat header (first line of the JSONL file).
 *
 * Only the header line is rewritten; message lines are preserved byte-for-byte.
 *
 * @param {object} options
 * @param {string} options.chatFilePath - Absolute path to the `.jsonl` file.
 * @param {object} options.metadata - Fields to merge into `chat_metadata`.
 * @param {string} [options.integrity=''] - Client-provided integrity slug.
 * @param {boolean} [options.force=false] - Skip integrity check.
 * @returns {MetaPatchResult}
 * @throws Error with code 'INTEGRITY_CONFLICT' on integrity mismatch.
 * @throws Error with code 'CHAT_NOT_FOUND' if file doesn't exist.
 */
export function patchMetadata({ chatFilePath, metadata, integrity = '', force = false }) {
    if (!fs.existsSync(chatFilePath)) {
        const error = new Error(`Chat file not found: ${chatFilePath}`);
        error.code = 'CHAT_NOT_FOUND';
        throw error;
    }

    // Integrity validation
    const validation = validateIntegrity(chatFilePath, integrity, force);
    if (!validation.valid) {
        const error = new Error(`Integrity mismatch: expected "${integrity}", server has "${validation.current}"`);
        error.code = 'INTEGRITY_CONFLICT';
        error.currentIntegrity = validation.current;
        throw error;
    }

    // Read the file as raw text, split into first line and the rest
    const content = fs.readFileSync(chatFilePath, 'utf8');
    const firstNewline = content.indexOf('\n');

    let headerLine, rest;
    if (firstNewline === -1) {
        headerLine = content;
        rest = '';
    } else {
        headerLine = content.substring(0, firstNewline);
        rest = content.substring(firstNewline); // includes the leading \n
    }

    // Parse and merge
    let header;
    try {
        header = JSON.parse(headerLine);
    } catch {
        const error = new Error(`Failed to parse chat header: ${chatFilePath}`);
        error.code = 'CHAT_NOT_FOUND';
        throw error;
    }

    if (!header.chat_metadata || typeof header.chat_metadata !== 'object') {
        header.chat_metadata = {};
    }

    // Deep merge metadata into chat_metadata
    _.merge(header.chat_metadata, metadata);

    // Write back: new header + unchanged rest
    const newHeaderLine = JSON.stringify(header);
    const newContent = newHeaderLine + rest;
    fs.writeFileSync(chatFilePath, newContent, 'utf8');

    // Rotate integrity
    const newIntegrity = generateIntegrity();
    writeIntegrity(chatFilePath, newIntegrity);

    return { integrity: newIntegrity };
}
