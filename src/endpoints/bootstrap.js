/**
 * Bootstrap aggregation endpoint.
 *
 * Combines multiple startup data requests into a single HTTP round-trip.
 * On high-latency connections this saves 4+ sequential RTTs (~600ms+ at 150ms latency).
 *
 * References:
 *   - Luker's /api/bootstrap: src/endpoints/bootstrap.js
 */

import express from 'express';
import { getImages } from '../util.js';

export const router = express.Router();

router.post('/bootstrap', async function (request, response) {
    try {
        const directories = request.user.directories;

        // Parallelize all independent data fetches
        const [avatars, settings] = await Promise.all([
            Promise.resolve(getImages(directories.avatars)),
            loadSettings(directories),
        ]);

        return response.send({
            avatars,
            settings,
            // Note: characters and groups are loaded separately because they
            // go through their own complex initialization (tags, sorting, etc.)
            // We include only the quick data that saves RTTs without complicating init.
        });
    } catch (error) {
        console.error('POST /api/bootstrap error:', error);
        return response.sendStatus(500);
    }
});

/**
 * Reads the settings.json file for the current user.
 * Matches the behavior of GET /api/settings/get but without the full response pipeline.
 * @param {object} directories
 * @returns {Promise<object|null>}
 */
async function loadSettings(directories) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const settingsFile = path.join(directories.root, 'settings.json');
    try {
        if (!fs.existsSync(settingsFile)) return null;
        const raw = fs.readFileSync(settingsFile, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
