import type { Env } from './config';
import type { TelegramUpdate } from './telegram/types';
import { loadConfig } from './config';
import { handleUpdate } from './handler';
import { OpenAIProvider } from './llm/openai';
import { indexPage, initWebhook } from './routes';
import { KVHistoryStore } from './storage/history';
import { TelegramApi } from './telegram/api';
import { BatchBuffer } from './batch/buffer';
import { ImageStore } from './vision/store';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        let config;
        try {
            config = loadConfig(env);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ msg: 'invalid configuration', error: detail }));
            // Детали — только в лог: наружу отдаём нейтральный текст.
            return new Response('Worker is not configured', { status: 500 });
        }

        const url = new URL(request.url);
        const api = new TelegramApi(config.botToken);

        // Служебные страницы раскрывают конфигурацию и меняют привязку webhook,
        // поэтому доступны только по тому же секрету, что защищает вебхук.
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/init')) {
            if (!isAuthorized(url, config)) {
                return new Response('Not found', { status: 404 });
            }
            return url.pathname === '/'
                ? indexPage(request, config)
                : initWebhook(request, api, config);
        }
        if (request.method === 'POST' && url.pathname === '/webhook') {
            return handleWebhook(request, env, ctx, api, config);
        }
        return new Response('Not found', { status: 404 });
    },
};

/**
 * safeEqual compares two secrets without leaking their length difference.
 * Практически timing-атака здесь неэксплуатируема из-за сетевого шума,
 * но постоянное по времени сравнение ничего не стоит.
 */
function safeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    if (left.byteLength !== right.byteLength) {
        return false;
    }
    return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * isAuthorized guards the service pages with the webhook secret.
 * Секрет передаётся в query-параметре: страницы открываются из браузера,
 * где заголовок не проставить.
 */
function isAuthorized(url: URL, config: ReturnType<typeof loadConfig>): boolean {
    const provided = url.searchParams.get('token');
    return provided !== null && safeEqual(provided, config.webhookSecret);
}

async function handleWebhook(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    api: TelegramApi,
    config: ReturnType<typeof loadConfig>,
): Promise<Response> {
    // Секрет обязателен (loadConfig это гарантирует): без проверки апдейт
    // мог бы прислать кто угодно, а whitelist доверяет from.id из тела.
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (provided === null || !safeEqual(provided, config.webhookSecret)) {
        console.error(JSON.stringify({ msg: 'webhook secret mismatch' }));
        return new Response('Forbidden', { status: 403 });
    }

    let update: TelegramUpdate;
    try {
        update = await request.json() as TelegramUpdate;
    } catch {
        return new Response('Bad request', { status: 400 });
    }

    if (!config.apiKey) {
        console.error(JSON.stringify({ msg: 'OPENAI_API_KEY is not configured' }));
        return new Response('OK', { status: 200 });
    }

    const deps = {
        api,
        provider: new OpenAIProvider({
            apiKey: config.apiKey,
            apiBase: config.apiBase,
            model: config.model,
        }),
        history: new KVHistoryStore(env.DATABASE, config.historyMaxMessages, config.historyTtlSeconds),
        // Картинки живут в том же namespace, но своими ключами и с меньшим TTL.
        images: new ImageStore(env.DATABASE, config.imageTtlSeconds),
        // 60 с — минимальный TTL KV; окно ожидания измеряется секундами.
        batches: new BatchBuffer(env.DATABASE, 60),
        config,
    };

    // Отвечаем Telegram сразу: иначе он повторит доставку, пока модель думает.
    ctx.waitUntil(
        handleUpdate(update, deps).catch((error: unknown) => {
            console.error(JSON.stringify({
                msg: 'update handling failed',
                update_id: update.update_id,
                error: error instanceof Error ? error.message : String(error),
            }));
        }),
    );
    return new Response('OK', { status: 200 });
}
