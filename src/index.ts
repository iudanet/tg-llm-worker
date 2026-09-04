import type { Env } from './config';
import type { TelegramUpdate } from './telegram/types';
import { loadConfig } from './config';
import { handleUpdate } from './handler';
import { OpenAIProvider } from './llm/openai';
import { indexPage, initWebhook } from './routes';
import { KVHistoryStore } from './storage/history';
import { TelegramApi } from './telegram/api';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        let config;
        try {
            config = loadConfig(env);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ msg: 'invalid configuration', error: detail }));
            return new Response(`Configuration error: ${detail}`, { status: 500 });
        }

        const url = new URL(request.url);
        const api = new TelegramApi(config.botToken);

        if (request.method === 'GET' && url.pathname === '/') {
            return indexPage(request, config);
        }
        if (request.method === 'GET' && url.pathname === '/init') {
            return initWebhook(request, api, config);
        }
        if (request.method === 'POST' && url.pathname === '/webhook') {
            return handleWebhook(request, env, ctx, api, config);
        }
        return new Response('Not found', { status: 404 });
    },
};

async function handleWebhook(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    api: TelegramApi,
    config: ReturnType<typeof loadConfig>,
): Promise<Response> {
    // Telegram присылает секрет в заголовке; без проверки webhook может дёрнуть кто угодно.
    if (config.webhookSecret) {
        const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (provided !== config.webhookSecret) {
            console.error(JSON.stringify({ msg: 'webhook secret mismatch' }));
            return new Response('Forbidden', { status: 403 });
        }
    }

    let update: TelegramUpdate;
    try {
        update = await request.json() as TelegramUpdate;
    } catch {
        return new Response('Bad request', { status: 400 });
    }

    const deps = {
        api,
        provider: new OpenAIProvider({
            apiKey: config.apiKey,
            apiBase: config.apiBase,
            model: config.model,
        }),
        history: new KVHistoryStore(env.DATABASE, config.historyMaxMessages, config.historyTtlSeconds),
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
