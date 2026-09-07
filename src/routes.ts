import type { Config } from './config';
import type { TelegramApi } from './telegram/api';
import { BOT_COMMANDS } from './handler';

/**
 * escapeHtml neutralises markup in interpolated values.
 *
 * Значения приходят из конфигурации оператора и ответов Telegram, поэтому
 * практической XSS здесь нет — но страницу видно только владельцу секрета,
 * а код уйдёт в паблик и будет копироваться.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * renderPage wraps content into a minimal self-contained HTML document.
 */
function renderPage(title: string, body: string): Response {
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
    :root { color-scheme: light dark; }
    body {
        margin: 0 auto; padding: 2rem 1.25rem; max-width: 46rem;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    pre { padding: .75rem 1rem; overflow-x: auto; border-radius: 6px; background: rgba(127,127,127,.12); }
    .ok { color: #15803d; } .err { color: #b91c1c; }
    a.button {
        display: inline-block; padding: .55rem 1.1rem; border-radius: 6px;
        background: #2563eb; color: #fff; text-decoration: none; font-weight: 600;
    }
    footer { margin-top: 2.5rem; font-size: 13px; opacity: .65; }
</style>
</head>
<body>${body}
<footer>tg-llm-worker</footer>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // Страница содержит секрет в ссылках — не кэшируем и не отдаём
            // его во внешние запросы через Referer.
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
    });
}

/**
 * indexPage explains how to connect the bot and links to the webhook binding.
 */
export function indexPage(request: Request, config: Config): Response {
    const origin = new URL(request.url).origin;
    const keyNote = config.apiKey
        ? ''
        : '<p class="err">OPENAI_API_KEY не задан: <code>npx wrangler secret put OPENAI_API_KEY</code></p>';

    return renderPage('tg-llm-worker', `
<h1>tg-llm-worker</h1>
<p>Воркер запущен на <code>${escapeHtml(origin)}</code>.</p>
<h2>Подключение</h2>
<p>Чтобы Telegram начал слать сообщения этому воркеру, нужно привязать webhook:</p>
<p><a class="button" href="./init?token=${encodeURIComponent(config.webhookSecret)}">Привязать webhook</a></p>
${keyNote}
<h2>Текущая конфигурация</h2>
<pre>модель:            ${escapeHtml(config.model)}
API base:          ${escapeHtml(config.apiBase)}
whitelist:         ${config.whiteList.size} пользователей
история:           до ${config.historyMaxMessages} сообщений, TTL ${Math.round(config.historyTtlSeconds / 3600)} ч
порог файла:       ${config.documentThreshold} символов
rich messages:     ${config.useRichMessages ? 'включены' : 'выключены'}</pre>
<h2>Команды бота</h2>
<pre>/new   — очистить контекст
/help  — справка</pre>
<h2>Требования для стриминга</h2>
<p>Метод <code>sendMessageDraft</code> работает только в личных чатах и требует
включённого Forum Topic Mode: @BotFather → Bot Settings → Group Privacy → Forum Topic Mode.
Если он выключен, бот просто пришлёт готовый ответ без постепенного отображения.</p>
`);
}

/**
 * initWebhook binds the Telegram webhook to this worker's URL.
 */
export async function initWebhook(request: Request, api: TelegramApi, config: Config): Promise<Response> {
    const origin = new URL(request.url).origin;
    const webhookUrl = `${origin}/webhook`;

    const result = await api.setWebhook({
        url: webhookUrl,
        secret_token: config.webhookSecret,
        allowed_updates: ['message'],
    });

    // Меню команд живёт на стороне Telegram и переживает смену воркера.
    // Telegram хранит его по скоупам, и узкий перекрывает default, поэтому
    // сначала чистим скоупы, которые мог занять предыдущий бот.
    for (const type of ['all_private_chats', 'all_group_chats', 'all_chat_administrators']) {
        await api.deleteMyCommands({ type });
    }
    const commands = await api.setMyCommands(BOT_COMMANDS);
    const commandsStatus = commands.ok
        ? `<p class="ok">Меню команд обновлено: ${BOT_COMMANDS.map(c => `/${c.command}`).join(', ')}</p>`
        : `<p class="err">Не удалось обновить меню команд: ${escapeHtml(commands.description ?? 'неизвестная ошибка')}</p>`;

    const status = result.ok
        ? `<p class="ok">Webhook привязан к <code>${escapeHtml(webhookUrl)}</code></p>`
        : `<p class="err">Не удалось привязать webhook: ${escapeHtml(result.description ?? 'неизвестная ошибка')}</p>`;

    return renderPage('tg-llm-worker — init', `
<h1>Привязка webhook</h1>
${status}
${commandsStatus}
<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
<p><a href="./?token=${encodeURIComponent(config.webhookSecret)}">← назад</a></p>
`);
}
