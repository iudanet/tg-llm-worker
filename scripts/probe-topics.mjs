#!/usr/bin/env node
/**
 * probe-topics — спрашивает у самого Telegram, что работает в личных топиках.
 *
 * Документация про топики в личных чатах неполна, а догадки по симптомам уже
 * дважды оказались неверными. Этот скрипт не чинит ничего: он отправляет
 * настоящие запросы и печатает ответы API — чтобы дальше решать по фактам.
 *
 * Запуск:
 *   node scripts/probe-topics.mjs <chat_id> <message_thread_id>
 *
 * chat_id и message_thread_id берутся из вывода local-bridge.mjs.
 */

import { readFileSync } from 'node:fs';

const [chatId, threadId] = process.argv.slice(2);
if (!chatId) {
    console.error('Использование: node scripts/probe-topics.mjs <chat_id> [message_thread_id]');
    process.exit(1);
}

function token() {
    let raw;
    try {
        raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    } catch {
        console.error('Нет .dev.vars — создайте его рядом с wrangler.toml (см. README).');
        process.exit(1);
    }
    const match = /TELEGRAM_BOT_TOKEN\s*=\s*"?([^"\n]+)"?/.exec(raw);
    if (!match) {
        console.error('В .dev.vars нет TELEGRAM_BOT_TOKEN.');
        process.exit(1);
    }
    return match[1];
}

const API = `https://api.telegram.org/bot${token()}`;

async function probe(label, method, payload) {
    const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await response.json();
    const verdict = body.ok ? 'OK' : `FAIL ${body.error_code}: ${body.description}`;
    console.log(`\n[${label}] ${method} → ${verdict}`);
    if (body.ok && body.result?.message_thread_id !== undefined) {
        console.log(`  ответ лёг в тред: ${body.result.message_thread_id}`);
    } else if (body.ok && body.result?.message_id) {
        console.log('  ответ отправлен, message_thread_id в ответе отсутствует');
    }
    return body;
}

async function main() {
    console.log(`Проверяю chat_id=${chatId}, message_thread_id=${threadId ?? '(не задан)'}`);

    // Кто мы и включены ли топики в личных чатах.
    const me = await probe('bot', 'getMe', {});
    if (me.result?.has_topics_enabled !== undefined) {
        console.log(`  has_topics_enabled: ${me.result.has_topics_enabled}`);
    }

    // Базовая отправка без адреса треда — контрольный выстрел.
    await probe('без треда', 'sendMessage', {
        chat_id: Number(chatId),
        text: 'probe: без message_thread_id',
    });

    if (!threadId) {
        console.log('\nmessage_thread_id не задан — проверки треда пропущены.');
        return;
    }

    // Вариант 1: как сейчас в коде.
    await probe('message_thread_id', 'sendMessage', {
        chat_id: Number(chatId),
        message_thread_id: Number(threadId),
        text: 'probe: message_thread_id',
    });

    // Вариант 2: параметр для чатов прямых сообщений (Bot API 9.2).
    await probe('direct_messages_topic_id', 'sendMessage', {
        chat_id: Number(chatId),
        direct_messages_topic_id: Number(threadId),
        text: 'probe: direct_messages_topic_id',
    });

    // Вариант 3: удаление топика — работает ли вообще в личном чате.
    await probe('deleteForumTopic', 'deleteForumTopic', {
        chat_id: Number(chatId),
        message_thread_id: Number(threadId),
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
