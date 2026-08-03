import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getChatDelta } from '../../src/incremental/delta.js';
import { writeIntegrity } from '../../src/incremental/integrity.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-delta-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createChatFile(chatPath, header, messages) {
    const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(chatPath, lines, 'utf8');
}

const header = { chat_metadata: { title: 'Test' }, user_name: 'u', character_name: 'c' };

function makeMessages(count) {
    return Array.from({ length: count }, (_, i) => ({
        name: i % 2 === 0 ? 'User' : 'AI',
        mes: `Message ${i}`,
        send_date: `2024-01-01T00:00:${String(i).padStart(2, '0')}`,
    }));
}

describe('getChatDelta', () => {
    test('returns empty result for missing file', () => {
        const result = getChatDelta({ chatFilePath: path.join(tmpDir, 'nope.jsonl') });
        expect(result.chat).toEqual([]);
        expect(result.total_messages).toBe(0);
        expect(result.has_more).toBe(false);
    });

    test('returns all messages when fromIndex=0 and no limit', () => {
        const chatPath = path.join(tmpDir, 'full.jsonl');
        const messages = makeMessages(5);
        createChatFile(chatPath, header, messages);

        const result = getChatDelta({ chatFilePath: chatPath });
        expect(result.chat).toHaveLength(5);
        expect(result.from_index).toBe(0);
        expect(result.next_index).toBe(5);
        expect(result.total_messages).toBe(5);
        expect(result.has_more).toBe(false);
        expect(result.chat_metadata.title).toBe('Test');
    });

    test('returns slice with fromIndex', () => {
        const chatPath = path.join(tmpDir, 'slice.jsonl');
        const messages = makeMessages(10);
        createChatFile(chatPath, header, messages);

        const result = getChatDelta({ chatFilePath: chatPath, fromIndex: 7 });
        expect(result.chat).toHaveLength(3);
        expect(result.from_index).toBe(7);
        expect(result.next_index).toBe(10);
        expect(result.has_more).toBe(false);
        expect(result.chat[0].mes).toBe('Message 7');
    });

    test('returns limited slice with fromIndex + limit', () => {
        const chatPath = path.join(tmpDir, 'limited.jsonl');
        const messages = makeMessages(20);
        createChatFile(chatPath, header, messages);

        const result = getChatDelta({ chatFilePath: chatPath, fromIndex: 5, limit: 3 });
        expect(result.chat).toHaveLength(3);
        expect(result.from_index).toBe(5);
        expect(result.next_index).toBe(8);
        expect(result.total_messages).toBe(20);
        expect(result.has_more).toBe(true);
        expect(result.chat[0].mes).toBe('Message 5');
        expect(result.chat[2].mes).toBe('Message 7');
    });

    test('clamps fromIndex to total when out of bounds', () => {
        const chatPath = path.join(tmpDir, 'oob.jsonl');
        const messages = makeMessages(3);
        createChatFile(chatPath, header, messages);

        const result = getChatDelta({ chatFilePath: chatPath, fromIndex: 100 });
        expect(result.chat).toHaveLength(0);
        expect(result.from_index).toBe(3);
        expect(result.next_index).toBe(3);
        expect(result.has_more).toBe(false);
    });

    test('includes integrity slug when sidecar exists', () => {
        const chatPath = path.join(tmpDir, 'with-integrity.jsonl');
        createChatFile(chatPath, header, makeMessages(2));
        writeIntegrity(chatPath, 'my-uuid');

        const result = getChatDelta({ chatFilePath: chatPath });
        expect(result.integrity).toBe('my-uuid');
    });

    test('handles empty chat (header only)', () => {
        const chatPath = path.join(tmpDir, 'empty.jsonl');
        createChatFile(chatPath, header, []);

        const result = getChatDelta({ chatFilePath: chatPath });
        expect(result.chat).toHaveLength(0);
        expect(result.total_messages).toBe(0);
        expect(result.chat_metadata.title).toBe('Test');
    });

    test('loading last N messages (tail load pattern)', () => {
        const chatPath = path.join(tmpDir, 'tail.jsonl');
        const messages = makeMessages(100);
        createChatFile(chatPath, header, messages);

        // Load last 20 messages
        const result = getChatDelta({ chatFilePath: chatPath, fromIndex: 80, limit: 20 });
        expect(result.chat).toHaveLength(20);
        expect(result.from_index).toBe(80);
        expect(result.next_index).toBe(100);
        expect(result.has_more).toBe(false);
        expect(result.chat[0].mes).toBe('Message 80');
        expect(result.chat[19].mes).toBe('Message 99');
    });
});
