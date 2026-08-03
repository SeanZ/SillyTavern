import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendMessages } from '../../src/incremental/append.js';
import { readIntegrity, writeIntegrity } from '../../src/incremental/integrity.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-append-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createChatFile(chatPath, header, messages) {
    const dir = path.dirname(chatPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(chatPath, lines, 'utf8');
}

function readMessages(chatPath) {
    const content = fs.readFileSync(chatPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.map(l => JSON.parse(l));
}

describe('appendMessages', () => {
    test('returns early for empty messages array', () => {
        const chatPath = path.join(tmpDir, 'chat.jsonl');
        const result = appendMessages({ chatFilePath: chatPath, messages: [] });
        expect(result.appended).toBe(0);
        expect(result.created).toBe(false);
    });

    test('creates new chat file with header + messages', () => {
        const chatPath = path.join(tmpDir, 'chats', 'new.jsonl');
        const msg = { name: 'AI', is_user: false, mes: 'Hello!', send_date: '2024-01-01' };

        const result = appendMessages({
            chatFilePath: chatPath,
            messages: [msg],
            chatMetadata: { title: 'Test Chat' },
        });

        expect(result.created).toBe(true);
        expect(result.appended).toBe(1);
        expect(result.integrity).toBeTruthy();

        const all = readMessages(chatPath);
        expect(all[0].chat_metadata.title).toBe('Test Chat');
        expect(all[1].mes).toBe('Hello!');
    });

    test('appends to existing chat file', () => {
        const chatPath = path.join(tmpDir, 'existing.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        const msg1 = { name: 'User', is_user: true, mes: 'Hi' };
        createChatFile(chatPath, header, [msg1]);
        writeIntegrity(chatPath, 'slug-1');

        const msg2 = { name: 'AI', is_user: false, mes: 'Hello!' };
        const result = appendMessages({
            chatFilePath: chatPath,
            messages: [msg2],
            integrity: 'slug-1',
        });

        expect(result.appended).toBe(1);
        expect(result.created).toBe(false);
        expect(result.integrity).not.toBe('slug-1');

        const all = readMessages(chatPath);
        expect(all.length).toBe(3); // header + msg1 + msg2
        expect(all[2].mes).toBe('Hello!');
    });

    test('deduplicates messages matching the last stored message', () => {
        const chatPath = path.join(tmpDir, 'dedup.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        const msg = { name: 'AI', is_user: false, mes: 'Same message' };
        createChatFile(chatPath, header, [msg]);
        writeIntegrity(chatPath, 'slug-1');

        const result = appendMessages({
            chatFilePath: chatPath,
            messages: [msg],
            integrity: 'slug-1',
        });

        expect(result.appended).toBe(0);
        expect(result.skipped).toBe(1);

        const all = readMessages(chatPath);
        expect(all.length).toBe(2); // header + original msg (no duplicate)
    });

    test('dedup ignores gen_id in extra field', () => {
        const chatPath = path.join(tmpDir, 'dedup-genid.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        const stored = { name: 'AI', mes: 'Hi', extra: { gen_id: 'old-gen' } };
        createChatFile(chatPath, header, [stored]);
        writeIntegrity(chatPath, 'slug-1');

        const incoming = { name: 'AI', mes: 'Hi', extra: { gen_id: 'new-gen' } };
        const result = appendMessages({
            chatFilePath: chatPath,
            messages: [incoming],
            integrity: 'slug-1',
        });

        expect(result.appended).toBe(0);
        expect(result.skipped).toBe(1);
    });

    test('throws on integrity mismatch', () => {
        const chatPath = path.join(tmpDir, 'conflict.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        createChatFile(chatPath, header, []);
        writeIntegrity(chatPath, 'server-slug');

        const msg = { name: 'User', mes: 'New' };
        expect(() => {
            appendMessages({
                chatFilePath: chatPath,
                messages: [msg],
                integrity: 'stale-slug',
            });
        }).toThrow();

        try {
            appendMessages({ chatFilePath: chatPath, messages: [msg], integrity: 'stale-slug' });
        } catch (e) {
            expect(e.code).toBe('INTEGRITY_CONFLICT');
            expect(e.currentIntegrity).toBe('server-slug');
        }
    });

    test('force=true bypasses integrity check', () => {
        const chatPath = path.join(tmpDir, 'force.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        createChatFile(chatPath, header, []);
        writeIntegrity(chatPath, 'server-slug');

        const msg = { name: 'User', mes: 'Forced' };
        const result = appendMessages({
            chatFilePath: chatPath,
            messages: [msg],
            integrity: 'wrong-slug',
            force: true,
        });

        expect(result.appended).toBe(1);
    });

    test('appends multiple messages at once', () => {
        const chatPath = path.join(tmpDir, 'multi.jsonl');
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        createChatFile(chatPath, header, []);
        writeIntegrity(chatPath, 'slug-1');

        const messages = [
            { name: 'User', mes: 'One' },
            { name: 'AI', mes: 'Two' },
        ];
        const result = appendMessages({ chatFilePath: chatPath, messages, integrity: 'slug-1' });

        expect(result.appended).toBe(2);
        const all = readMessages(chatPath);
        expect(all.length).toBe(3); // header + 2 messages
    });
});
