'use strict';

const { parentPort } = require('worker_threads');

const fetch = require('node-fetch');
const { redis, notifyQueue } = require('../lib/db');
const settings = require('../lib/settings');
const logger = require('../lib/logger');
const packageData = require('../package.json');
const he = require('he');

function getAccountKey(account) {
    return `iad:${account}`;
}

async function metrics(logger, key, method, ...args) {
    try {
        parentPort.postMessage({
            cmd: 'metrics',
            key,
            method,
            args
        });
    } catch (err) {
        logger.error({ msg: 'Failed to post metrics to parent', err });
    }
}

notifyQueue.process('*', async job => {
    // validate if we should even process this webhook
    let accountExists = await redis.exists(getAccountKey(job.data.account));
    if (!accountExists) {
        logger.debug({ msg: 'Account is not enabled', action: 'webhook', event: job.name, account: job.data.account });
        return;
    }
    let webhooks = await settings.get('webhooks');
    if (!webhooks) {
        logger.debug({ msg: 'Webhook URL is not set', action: 'webhook', event: job.name, account: job.data.account });
        return;
    }

    let webhookEvents = await settings.get('webhookEvents');
    if (webhookEvents && !webhookEvents.includes('*') && !webhookEvents.includes(job.name)) {
        logger.trace({ msg: 'Webhook event not in whitelist', action: 'webhook', event: job.name, account: job.data.account, webhookEvents, data: job.data });
        return;
    }

    logger.trace({ msg: 'Received new notification', webhooks, event: job.name, data: job.data });
    if (!job.data.path) {
        // ignore non-message related events
        return;
    }

    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': `${packageData.name}/${packageData.version} (+https://imapapi.com)`
    };

    let parsed = new URL(webhooks);
    let username, password;

    if (parsed.username) {
        username = he.decode(parsed.username);
        parsed.username = '';
    }

    if (parsed.password) {
        password = he.decode(parsed.password);
        parsed.password = '';
    }

    if (username || password) {
        headers.Authorization = `Basic ${Buffer.from(he.encode(username || '') + ':' + he.encode(password || '')).toString('base64')}`;
    }

    try {
        let res = await fetch(parsed.toString(), {
            method: 'post',
            body: JSON.stringify(job.data),
            headers
        });

        if (!res.ok) {
            throw new Error(`Invalid response: ${res.status} ${res.statusText}`);
        }

        metrics(logger, 'webhooks', 'inc', {
            event: job.name,
            status: 'success'
        });
    } catch (err) {
        logger.error({ msg: 'Failed posting webhook', webhooks, event: job.name, err });

        metrics(logger, 'webhooks', 'inc', {
            event: job.name,
            status: 'fail'
        });

        throw err;
    }
});
