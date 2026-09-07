/**
 * Worker environment bindings and runtime configuration.
 */
export interface Env {
    DATABASE: KVNamespace;

    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET?: string;

    OPENAI_API_KEY: string;
    OPENAI_API_BASE?: string;

    CHAT_MODEL?: string;
    SYSTEM_PROMPT?: string;
    CHAT_WHITE_LIST?: string;
    HISTORY_MAX_MESSAGES?: string;
    HISTORY_TTL_SECONDS?: string;
    STREAM_INTERVAL_MS?: string;
    DOCUMENT_THRESHOLD?: string;
    USE_RICH_MESSAGES?: string;
    VISION_ENABLED?: string;
    VISION_CONTEXT_IMAGES?: string;
    IMAGE_TTL_SECONDS?: string;
    IMAGE_MAX_BYTES?: string;
}

export interface Config {
    botToken: string;
    webhookSecret: string | null;
    apiKey: string;
    apiBase: string;
    model: string;
    systemPrompt: string | null;
    whiteList: Set<number>;
    historyMaxMessages: number;
    historyTtlSeconds: number;
    streamIntervalMs: number;
    documentThreshold: number;
    useRichMessages: boolean;
    visionEnabled: boolean;
    /** Сколько последних картинок разворачивать в запрос к модели. */
    visionContextImages: number;
    imageTtlSeconds: number;
    imageMaxBytes: number;
}

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_HISTORY_MAX_MESSAGES = 20;
const DEFAULT_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_STREAM_INTERVAL_MS = 1200;
// Ответы длиннее порога уходят файлом .md вместо нарезки на сообщения.
const DEFAULT_DOCUMENT_THRESHOLD = 4096;
// Картинки живут меньше истории: они тяжёлые, а ссылка на протухшую
// картинку деградирует в текстовую заглушку без ошибки.
const DEFAULT_IMAGE_TTL_SECONDS = 60 * 60 * 24;
// Каждая картинка едет в модель заново в каждом запросе, поэтому в контекст
// разворачиваем только несколько последних.
const DEFAULT_VISION_CONTEXT_IMAGES = 2;
// Telegram сам пережимает фото (обычно 100-300 КБ); лимит отсекает крупное.
const DEFAULT_IMAGE_MAX_BYTES = 1024 * 1024;

function parseIntOr(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * parseWhiteList turns a comma-separated list of Telegram ids into a lookup set.
 * Пустой список означает "никто не допущен" — бот молчит, а не открыт всем.
 */
export function parseWhiteList(raw: string | undefined): Set<number> {
    const result = new Set<number>();
    if (!raw) {
        return result;
    }
    for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) {
            continue;
        }
        const id = Number.parseInt(trimmed, 10);
        if (Number.isFinite(id)) {
            result.add(id);
        }
    }
    return result;
}

/**
 * loadConfig reads the runtime configuration from the worker environment.
 *
 * Отсутствие ключа модели здесь не является ошибкой: страница с инструкцией
 * должна открываться и на недонастроенном воркере, чтобы было видно, чего
 * не хватает. Наличие ключа проверяется там, где он реально нужен.
 */
export function loadConfig(env: Env): Config {
    if (!env.TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return {
        botToken: env.TELEGRAM_BOT_TOKEN,
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
        apiKey: env.OPENAI_API_KEY ?? '',
        apiBase: (env.OPENAI_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ''),
        model: env.CHAT_MODEL || DEFAULT_MODEL,
        systemPrompt: env.SYSTEM_PROMPT || null,
        whiteList: parseWhiteList(env.CHAT_WHITE_LIST),
        historyMaxMessages: parseIntOr(env.HISTORY_MAX_MESSAGES, DEFAULT_HISTORY_MAX_MESSAGES),
        historyTtlSeconds: parseIntOr(env.HISTORY_TTL_SECONDS, DEFAULT_HISTORY_TTL_SECONDS),
        streamIntervalMs: parseIntOr(env.STREAM_INTERVAL_MS, DEFAULT_STREAM_INTERVAL_MS),
        documentThreshold: parseIntOr(env.DOCUMENT_THRESHOLD, DEFAULT_DOCUMENT_THRESHOLD),
        useRichMessages: (env.USE_RICH_MESSAGES ?? 'true').toLowerCase() !== 'false',
        visionEnabled: (env.VISION_ENABLED ?? 'true').toLowerCase() !== 'false',
        visionContextImages: parseIntOr(env.VISION_CONTEXT_IMAGES, DEFAULT_VISION_CONTEXT_IMAGES),
        imageTtlSeconds: parseIntOr(env.IMAGE_TTL_SECONDS, DEFAULT_IMAGE_TTL_SECONDS),
        imageMaxBytes: parseIntOr(env.IMAGE_MAX_BYTES, DEFAULT_IMAGE_MAX_BYTES),
    };
}
