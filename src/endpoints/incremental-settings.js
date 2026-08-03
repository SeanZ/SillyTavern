/**
 * Incremental settings patch endpoint.
 *
 * Allows the frontend to send only changed settings fields (deep merge)
 * instead of the full settings JSON on every toggle/slider change.
 *
 * References:
 *   - Luker's /api/settings/patch: src/endpoints/settings.js:397
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';

export const router = express.Router();

router.post('/patch', async function (request, response) {
    try {
        const patch = request.body;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return response.status(400).send({ error: 'Expected a JSON object with fields to merge.' });
        }

        const settingsFile = path.join(request.user.directories.root, 'settings.json');

        let currentSettings = {};
        try {
            if (fs.existsSync(settingsFile)) {
                const raw = fs.readFileSync(settingsFile, 'utf8');
                currentSettings = JSON.parse(raw);
            }
        } catch (err) {
            console.error('Failed to read settings for patch:', err);
            return response.status(500).send({ error: 'Failed to read current settings.' });
        }

        // Deep merge the patch into current settings
        _.merge(currentSettings, patch);

        // Write back
        fs.writeFileSync(settingsFile, JSON.stringify(currentSettings, null, 4), 'utf8');

        return response.send({ result: 'ok' });
    } catch (error) {
        console.error('POST /api/settings/patch error:', error);
        return response.status(500).send({ error: 'Failed to patch settings.' });
    }
});
