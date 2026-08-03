/**
 * JSON Patch operations for chat messages.
 *
 * Applies RFC 6902-style operations to messages in a JSONL chat file.
 * The patch is applied to the message array (excluding the header line),
 * with idempotency support for safe retries.
 */

import fs from 'node:fs';
import _ from 'lodash';
import { validateIntegrity, writeIntegrity, generateIntegrity } from './integrity.js';

/**
 * Reads and parses a JSONL chat file into header + messages.
 * @param {string} chatFilePath
 * @returns {{ header: object, messages: object[] } | null}
 */
export function readChatFile(chatFilePath) {
    try {
        const content = fs.readFileSync(chatFilePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) return null;

        const header = JSON.parse(lines[0]);
        const messages = lines.slice(1).map(l => JSON.parse(l));
        return { header, messages };
    } catch {
        return null;
    }
}

/**
 * Writes header + messages back to JSONL format.
 * @param {string} chatFilePath
 * @param {object} header
 * @param {object[]} messages
 */
export function writeChatFile(chatFilePath, header, messages) {
    const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(chatFilePath, lines, 'utf8');
}

/**
 * Parses a JSON Pointer path like "/42/mes" into parts.
 * @param {string} patchPath - RFC 6901 JSON Pointer.
 * @returns {(string|number)[]}
 */
function parsePath(patchPath) {
    if (!patchPath || patchPath === '/') return [];
    const parts = patchPath.split('/').slice(1); // remove leading empty string
    return parts.map(p => {
        const num = Number(p);
        return Number.isInteger(num) && num >= 0 ? num : p;
    });
}

/**
 * Gets a nested value from an object using path parts.
 * @param {any} obj
 * @param {(string|number)[]} parts
 * @returns {any}
 */
function getNestedValue(obj, parts) {
    let current = obj;
    for (const part of parts) {
        if (current == null) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Sets a nested value on an object using path parts.
 * @param {any} obj
 * @param {(string|number)[]} parts
 * @param {any} value
 */
function setNestedValue(obj, parts, value) {
    if (parts.length === 0) return;
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null) {
            current[parts[i]] = typeof parts[i + 1] === 'number' ? [] : {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * @typedef {Object} PatchOperation
 * @property {string} op - "replace" | "remove" | "add"
 * @property {string} path - JSON Pointer (e.g. "/42" or "/42/mes")
 * @property {any} [value] - Value for replace/add operations.
 */

/**
 * @typedef {Object} PatchResult
 * @property {number} applied - Number of operations actually applied (non-idempotent).
 * @property {number} totalMessages - Total messages after patching.
 * @property {string} integrity - New integrity slug.
 */

/**
 * Applies patch operations to messages in a chat file.
 *
 * @param {object} options
 * @param {string} options.chatFilePath - Absolute path to the `.jsonl` file.
 * @param {PatchOperation[]} options.operations - Patch operations to apply.
 * @param {string} [options.integrity=''] - Client-provided integrity slug.
 * @param {boolean} [options.force=false] - Skip integrity check.
 * @returns {PatchResult}
 * @throws Error with code 'INTEGRITY_CONFLICT' on integrity mismatch.
 * @throws Error with code 'CHAT_NOT_FOUND' if file doesn't exist.
 * @throws Error with code 'INVALID_PATCH' for invalid operations.
 */
export function patchMessages({ chatFilePath, operations, integrity = '', force = false }) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return { applied: 0, totalMessages: 0, integrity: '' };
    }

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

    // Read current state
    const chatData = readChatFile(chatFilePath);
    if (!chatData) {
        const error = new Error(`Failed to parse chat file: ${chatFilePath}`);
        error.code = 'CHAT_NOT_FOUND';
        throw error;
    }

    const { header, messages } = chatData;
    let applied = 0;

    // Apply operations sequentially
    for (const op of operations) {
        const parts = parsePath(op.path);
        if (parts.length === 0) {
            const error = new Error(`Invalid patch path: ${op.path}`);
            error.code = 'INVALID_PATCH';
            throw error;
        }

        const index = parts[0];
        if (typeof index !== 'number') {
            const error = new Error(`First path segment must be a message index: ${op.path}`);
            error.code = 'INVALID_PATCH';
            throw error;
        }

        switch (op.op) {
            case 'replace': {
                if (parts.length === 1) {
                    // Whole message replacement
                    if (index >= messages.length) {
                        const error = new Error(`Index out of bounds: ${index} >= ${messages.length}`);
                        error.code = 'INVALID_PATCH';
                        throw error;
                    }
                    // Idempotent: skip if already equal
                    if (_.isEqual(messages[index], op.value)) break;
                    messages[index] = op.value;
                    applied++;
                } else {
                    // Field-level replacement (e.g. "/42/mes")
                    if (index >= messages.length) {
                        const error = new Error(`Index out of bounds: ${index} >= ${messages.length}`);
                        error.code = 'INVALID_PATCH';
                        throw error;
                    }
                    const fieldParts = parts.slice(1);
                    const currentValue = getNestedValue(messages[index], fieldParts);
                    // Idempotent: skip if already equal
                    if (_.isEqual(currentValue, op.value)) break;
                    setNestedValue(messages[index], fieldParts, op.value);
                    applied++;
                }
                break;
            }
            case 'remove': {
                if (parts.length !== 1) {
                    // Field-level remove
                    if (index >= messages.length) break; // already removed, idempotent
                    const fieldParts = parts.slice(1);
                    const parent = fieldParts.length > 1
                        ? getNestedValue(messages[index], fieldParts.slice(0, -1))
                        : messages[index];
                    const lastKey = fieldParts[fieldParts.length - 1];
                    if (parent && lastKey in parent) {
                        delete parent[lastKey];
                        applied++;
                    }
                } else {
                    // Whole message removal
                    if (index >= messages.length) break; // already removed, idempotent
                    messages.splice(index, 1);
                    applied++;
                }
                break;
            }
            case 'add': {
                if (parts.length !== 1) {
                    const error = new Error(`"add" only supports message-level paths: ${op.path}`);
                    error.code = 'INVALID_PATCH';
                    throw error;
                }
                // Idempotent: if message at index already equals value, skip
                if (index < messages.length && _.isEqual(messages[index], op.value)) break;
                // Insert at index (or append if index === length)
                if (index > messages.length) {
                    const error = new Error(`Index out of bounds for add: ${index} > ${messages.length}`);
                    error.code = 'INVALID_PATCH';
                    throw error;
                }
                messages.splice(index, 0, op.value);
                applied++;
                break;
            }
            default: {
                const error = new Error(`Unsupported patch operation: ${op.op}`);
                error.code = 'INVALID_PATCH';
                throw error;
            }
        }
    }

    // Write back
    if (applied > 0) {
        writeChatFile(chatFilePath, header, messages);
    }

    // Rotate integrity (even if no ops applied, to confirm receipt)
    const newIntegrity = generateIntegrity();
    writeIntegrity(chatFilePath, newIntegrity);

    return { applied, totalMessages: messages.length, integrity: newIntegrity };
}
