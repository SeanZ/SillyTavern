/**
 * Fast Load Module — frontend loading optimizations.
 *
 * Provides:
 * 1. fetchChatDelta() — load a range of messages instead of the full chat
 * 2. fetchBootstrap() — single-request startup data aggregation
 * 3. loadChatTail() — load only the N most recent messages for fast rendering
 *
 * These functions are additive — they don't replace existing load paths but
 * provide faster alternatives that call sites can opt into.
 *
 * References:
 *   - Luker's get-delta usage: public/script.js:3211
 *   - Luker's bootstrap: src/endpoints/bootstrap.js
 */

import { getRequestHeaders } from '../script.js';

// ─── Chat Delta Loading ─────────────────────────────────────────────────────

/**
 * @typedef {Object} DeltaResponse
 * @property {object[]} chat - Messages in the requested range.
 * @property {object} chat_metadata - Chat header metadata.
 * @property {number} from_index - Start index of returned slice.
 * @property {number} next_index - Index after last returned message.
 * @property {number} total_messages - Total messages in the chat.
 * @property {boolean} has_more - Whether there are older messages.
 * @property {string} integrity - Current integrity slug.
 */

/**
 * Load a range of messages from a character chat.
 *
 * @param {object} options
 * @param {string} options.avatarUrl - Character avatar filename.
 * @param {string} options.fileName - Chat file name.
 * @param {number} [options.fromIndex=0] - Start index.
 * @param {number} [options.limit=0] - Max messages (0 = all from fromIndex).
 * @returns {Promise<DeltaResponse|null>} Null on failure.
 */
export async function fetchChatDelta({ avatarUrl, fileName, fromIndex = 0, limit = 0 }) {
    try {
        const response = await fetch('/api/chats/get-delta', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: avatarUrl,
                file_name: fileName,
                from_index: fromIndex,
                limit,
            }),
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('[FastLoad] fetchChatDelta failed:', error);
        return null;
    }
}

/**
 * Load a range of messages from a group chat.
 *
 * @param {object} options
 * @param {string} options.groupChatId - Group chat ID.
 * @param {number} [options.fromIndex=0] - Start index.
 * @param {number} [options.limit=0] - Max messages (0 = all from fromIndex).
 * @returns {Promise<DeltaResponse|null>} Null on failure.
 */
export async function fetchGroupChatDelta({ groupChatId, fromIndex = 0, limit = 0 }) {
    try {
        const response = await fetch('/api/chats/group/get-delta', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                id: groupChatId,
                from_index: fromIndex,
                limit,
            }),
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('[FastLoad] fetchGroupChatDelta failed:', error);
        return null;
    }
}

/**
 * Load only the tail (most recent N messages) of a chat.
 * The caller can render these immediately and lazy-load older messages later.
 *
 * @param {object} options
 * @param {string} [options.avatarUrl] - Character avatar (character chats).
 * @param {string} [options.fileName] - Chat file name (character chats).
 * @param {string} [options.groupChatId] - Group chat ID (group chats).
 * @param {number} [options.tailSize=50] - Number of recent messages to load.
 * @returns {Promise<DeltaResponse|null>} Null on failure.
 */
export async function loadChatTail({ avatarUrl, fileName, groupChatId, tailSize = 50 }) {
    // First, get total message count by requesting 0 messages from index 0
    const isGroup = Boolean(groupChatId);

    const probeBody = isGroup
        ? { id: groupChatId, from_index: 0, limit: 0 }
        : { avatar_url: avatarUrl, file_name: fileName, from_index: 0, limit: 0 };

    const probeUrl = isGroup ? '/api/chats/group/get-delta' : '/api/chats/get-delta';

    try {
        // We can't know total_messages without first requesting — but the endpoint
        // returns total_messages even for limit=0 requests. However, limit=0 means
        // "return all from fromIndex", so we use limit=1 from a high index to probe.
        // Actually, a simpler approach: request from index MAX_SAFE_INTEGER with limit=1,
        // which will clamp to the end and tell us total_messages.
        const probeResponse = await fetch(probeUrl, {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...probeBody,
                from_index: Number.MAX_SAFE_INTEGER,
                limit: 1,
            }),
        });

        if (!probeResponse.ok) return null;
        const probe = await probeResponse.json();
        const total = probe.total_messages || 0;

        if (total === 0) {
            return {
                chat: [],
                chat_metadata: probe.chat_metadata || {},
                from_index: 0,
                next_index: 0,
                total_messages: 0,
                has_more: false,
                integrity: probe.integrity || '',
            };
        }

        // Now load the tail
        const startIndex = Math.max(0, total - tailSize);
        const fetchBody = isGroup
            ? { id: groupChatId, from_index: startIndex, limit: tailSize }
            : { avatar_url: avatarUrl, file_name: fileName, from_index: startIndex, limit: tailSize };

        const response = await fetch(probeUrl, {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify(fetchBody),
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('[FastLoad] loadChatTail failed:', error);
        return null;
    }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BootstrapResponse
 * @property {string[]} avatars - Avatar filenames.
 * @property {object|null} settings - User settings object.
 */

/**
 * Fetch aggregated startup data in a single request.
 * Saves multiple sequential RTTs on high-latency connections.
 *
 * @returns {Promise<BootstrapResponse|null>} Null if endpoint unavailable.
 */
export async function fetchBootstrap() {
    try {
        const response = await fetch('/api/bootstrap', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) {
                console.debug('[FastLoad] /api/bootstrap not available (old server?)');
            }
            return null;
        }
        return await response.json();
    } catch (error) {
        console.warn('[FastLoad] fetchBootstrap failed:', error);
        return null;
    }
}
