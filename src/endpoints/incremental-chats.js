/**
 * Express router for incremental chat save and load endpoints.
 *
 * Registers under `/api/chats` alongside the existing chatsRouter.
 * New routes: /append, /patch, /meta/patch, /get-delta (+ group variants).
 *
 * Architecture: this file is the only integration point with Express.
 * Core logic lives in src/incremental/*.js (pure functions, fully unit-tested).
 */

import express from 'express';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { appendMessages } from '../incremental/append.js';
import { patchMessages } from '../incremental/patch.js';
import { patchMetadata } from '../incremental/meta.js';
import { getChatDelta } from '../incremental/delta.js';
import { isPathUnderParent } from '../util.js';

export const router = express.Router();

// ─── Character Chat Endpoints ───────────────────────────────────────────────

router.post('/append', async function (request, response) {
    try {
        const avatarUrl = request.body.avatar_url;
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Missing avatar_url.' });
        }
        const cardName = String(avatarUrl).replace('.png', '');
        const fileName = String(request.body.file_name || '').trim();
        if (!fileName) {
            return response.status(400).send({ error: 'Missing file_name.' });
        }

        const chatFileName = fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const messages = Array.isArray(request.body.messages)
            ? request.body.messages
            : (request.body.message ? [request.body.message] : []);

        if (messages.length === 0) {
            return response.status(400).send({ error: 'No messages provided.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);
        const chatMetadata = request.body.chat_metadata || {};

        const result = appendMessages({
            chatFilePath,
            messages,
            chatMetadata,
            integrity,
            force,
        });

        return response.send({
            ok: true,
            appended: result.appended,
            skipped: result.skipped,
            created: result.created,
            integrity: result.integrity,
        });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        console.error('POST /api/chats/append error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

router.post('/patch', async function (request, response) {
    try {
        const avatarUrl = request.body.avatar_url;
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Missing avatar_url.' });
        }
        const cardName = String(avatarUrl).replace('.png', '');
        const fileName = String(request.body.file_name || '').trim();
        if (!fileName) {
            return response.status(400).send({ error: 'Missing file_name.' });
        }

        const chatFileName = fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const operations = Array.isArray(request.body.operations)
            ? request.body.operations
            : (request.body.operation ? [request.body.operation] : []);

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No operations provided.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);

        const result = patchMessages({
            chatFilePath,
            operations,
            integrity,
            force,
        });

        return response.send({
            ok: true,
            applied: result.applied,
            total_messages: result.totalMessages,
            integrity: result.integrity,
        });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        if (error.code === 'CHAT_NOT_FOUND') {
            return response.status(404).send({ error: 'Chat not found.' });
        }
        if (error.code === 'INVALID_PATCH') {
            return response.status(400).send({ error: error.message });
        }
        console.error('POST /api/chats/patch error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

router.post('/meta/patch', async function (request, response) {
    try {
        const avatarUrl = request.body.avatar_url;
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Missing avatar_url.' });
        }
        const cardName = String(avatarUrl).replace('.png', '');
        const fileName = String(request.body.file_name || '').trim();
        if (!fileName) {
            return response.status(400).send({ error: 'Missing file_name.' });
        }

        const chatFileName = fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const metadata = request.body.chat_metadata;
        if (!metadata || typeof metadata !== 'object') {
            return response.status(400).send({ error: 'Missing or invalid chat_metadata.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);

        const result = patchMetadata({
            chatFilePath,
            metadata,
            integrity,
            force,
        });

        return response.send({ ok: true, integrity: result.integrity });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        if (error.code === 'CHAT_NOT_FOUND') {
            return response.status(404).send({ error: 'Chat not found.' });
        }
        console.error('POST /api/chats/meta/patch error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

// ─── Group Chat Endpoints ───────────────────────────────────────────────────

router.post('/group/append', async function (request, response) {
    try {
        const id = request.body.id;
        if (!id) {
            return response.status(400).send({ error: 'Missing group chat id.' });
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const messages = Array.isArray(request.body.messages)
            ? request.body.messages
            : (request.body.message ? [request.body.message] : []);

        if (messages.length === 0) {
            return response.status(400).send({ error: 'No messages provided.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);
        const chatMetadata = request.body.chat_metadata || {};

        const result = appendMessages({
            chatFilePath,
            messages,
            chatMetadata,
            integrity,
            force,
        });

        return response.send({
            ok: true,
            appended: result.appended,
            skipped: result.skipped,
            created: result.created,
            integrity: result.integrity,
        });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        console.error('POST /api/chats/group/append error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

router.post('/group/patch', async function (request, response) {
    try {
        const id = request.body.id;
        if (!id) {
            return response.status(400).send({ error: 'Missing group chat id.' });
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const operations = Array.isArray(request.body.operations)
            ? request.body.operations
            : (request.body.operation ? [request.body.operation] : []);

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No operations provided.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);

        const result = patchMessages({
            chatFilePath,
            operations,
            integrity,
            force,
        });

        return response.send({
            ok: true,
            applied: result.applied,
            total_messages: result.totalMessages,
            integrity: result.integrity,
        });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        if (error.code === 'CHAT_NOT_FOUND') {
            return response.status(404).send({ error: 'Chat not found.' });
        }
        if (error.code === 'INVALID_PATCH') {
            return response.status(400).send({ error: error.message });
        }
        console.error('POST /api/chats/group/patch error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

router.post('/group/meta/patch', async function (request, response) {
    try {
        const id = request.body.id;
        if (!id) {
            return response.status(400).send({ error: 'Missing group chat id.' });
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const metadata = request.body.chat_metadata;
        if (!metadata || typeof metadata !== 'object') {
            return response.status(400).send({ error: 'Missing or invalid chat_metadata.' });
        }

        const integrity = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);

        const result = patchMetadata({
            chatFilePath,
            metadata,
            integrity,
            force,
        });

        return response.send({ ok: true, integrity: result.integrity });
    } catch (error) {
        if (error.code === 'INTEGRITY_CONFLICT') {
            return response.status(409).send({
                error: 'integrity',
                current_integrity: error.currentIntegrity || '',
            });
        }
        if (error.code === 'CHAT_NOT_FOUND') {
            return response.status(404).send({ error: 'Chat not found.' });
        }
        console.error('POST /api/chats/group/meta/patch error:', error);
        return response.status(500).send({ error: 'Internal server error.' });
    }
});

// ─── Delta (Incremental Load) Endpoints ─────────────────────────────────────

router.post('/get-delta', async function (request, response) {
    try {
        const avatarUrl = request.body.avatar_url;
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Missing avatar_url.' });
        }
        const cardName = String(avatarUrl).replace('.png', '');
        const fileName = String(request.body.file_name || '').trim();
        if (!fileName) {
            return response.send({
                chat: [], chat_metadata: {}, from_index: 0,
                next_index: 0, total_messages: 0, has_more: false, integrity: '',
            });
        }

        const chatFileName = fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const fromIndex = Number(request.body.from_index) || 0;
        const limit = Number(request.body.limit) || 0;

        const result = getChatDelta({ chatFilePath, fromIndex, limit });
        return response.send(result);
    } catch (error) {
        console.error('POST /api/chats/get-delta error:', error);
        return response.send({
            chat: [], chat_metadata: {}, from_index: 0,
            next_index: 0, total_messages: 0, has_more: false, integrity: '',
        });
    }
});

router.post('/group/get-delta', async function (request, response) {
    try {
        const id = request.body.id;
        if (!id) {
            return response.status(400).send({ error: 'Missing group chat id.' });
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const fromIndex = Number(request.body.from_index) || 0;
        const limit = Number(request.body.limit) || 0;

        const result = getChatDelta({ chatFilePath, fromIndex, limit });
        return response.send(result);
    } catch (error) {
        console.error('POST /api/chats/group/get-delta error:', error);
        return response.send({
            chat: [], chat_metadata: {}, from_index: 0,
            next_index: 0, total_messages: 0, has_more: false, integrity: '',
        });
    }
});
