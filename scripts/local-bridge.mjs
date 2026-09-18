#!/usr/bin/env node
/**
 * local-bridge — мост между Telegram и локальным `wrangler dev`.
 *
 * Telegram не может доставить webhook на localhost, поэтому апдейты забираем
 * сами через getUpdates и отдаём воркеру обычным POST. Заодно печатаем сырой
 * апдейт: именно его нам не хватало, чтобы понять, что приходит в топиках
 * личного чата.
 *
 * Запуск:
 *   1) npm run dev                  (в одном терминале)
 *   2) node scripts/local-bridge.mjs (в другом)
 *
 * Важно: webhook должен быть снят, иначе getUpdates вернёт 409 —
 * Telegram отдаёт апдейты либо в webhook, либо в getUpdates, но не в оба.
 */

import { readFileSync } from 'node:fs';

const WORKER_URL = process.env.WORKER_URL ?? 'http://127.0.0.1:8787/webhook';

/** Читаем секреты из .dev.vars — там же, откуда их берёт wrangler dev. */
function loadDevVars() {
    const vars = {};
    let raw;
    try {
        raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    } catch {
        console.error('Нет .dev.vars — создайте его (см. README).');
        process.exit(1);
    }
    for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
        if (match) {
            vars[match[1]] = match[2];
        }
    }
    return vars;
}

const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET } = loadDevVars();
if (!TOKEN || !SECRET) {
    console.error('В .dev.vars нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET.');
    process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function api(method, payload) {
    const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
    });
    return response.json();
}

/** Снимаем webhook: иначе getUpdates вернёт 409 Conflict. */
async function releaseWebhook() {
    const info = await api('getWebhookInfo');
    if (info.result?.url) {
        console.log(`Снимаю webhook ${info.result.url}`);
        await api('deleteWebhook');
        console.log('Webhook снят. Верните его потом через страницу /init.');
    }
}

/**
 * Печатаем поля, из-за которых всё и затевалось: адрес треда и его признаки.
 */
function describeRouting(message) {
    if (!message) {
        return;
    }
    console.log('  → chat.id          :', message.chat?.id, `(${message.chat?.type})`);
    console.log('  → message_id       :', message.message_id);
    console.log('  → message_thread_id:', message.message_thread_id ?? '(нет)');
    console.log('  → is_topic_message :', message.is_topic_message ?? '(нет)');
    if (message.direct_messages_topic) {
        console.log('  → direct_messages_topic:', JSON.stringify(message.direct_messages_topic));
    }
    if (message.reply_to_message) {
        console.log('  → reply_to_message.message_id:', message.reply_to_message.message_id);
    }
}

async function forward(update) {
    console.log('\n=== СЫРОЙ АПДЕЙТ ===');
    console.log(JSON.stringify(update, null, 2));
    describeRouting(update.message);

    const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': SECRET,
        },
        body: JSON.stringify(update),
    });
    console.log(`  ← воркер ответил: ${response.status} ${await response.text()}`);
}

async function main() {
    await releaseWebhook();
    const me = await api('getMe');
    console.log(`Бот: @${me.result?.username}. Мост слушает, воркер: ${WORKER_URL}`);
    console.log('Пишите боту в Telegram — апдейты пойдут сюда.\n');

    let offset = 0;
    for (;;) {
        const updates = await api('getUpdates', { offset, timeout: 25 });
        if (!updates.ok) {
            console.error('getUpdates:', updates.description);
            await new Promise(resolve => setTimeout(resolve, 3000));
            continue;
        }
        for (const update of updates.result) {
            offset = update.update_id + 1;
            await forward(update);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
