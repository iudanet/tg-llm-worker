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
    BATCH_WINDOW_MS?: string;
    BATCH_MAX_WAIT_MS?: string;
    TRANSCRIBE_ENABLED?: string;
    TRANSCRIBE_MODEL?: string;
    AUDIO_MAX_BYTES?: string;
}

export interface Config {
    botToken: string;
    /**
     * Обязателен: без него POST /webhook принимал бы апдейты от кого угодно,
     * а whitelist проверяет from.id из того же тела запроса — то есть стал бы
     * декоративным. Секрет — единственное, что делает его реальной защитой.
     */
    webhookSecret: string;
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
    /** Окно ожидания соседних сообщений перед ответом, мс. 0 — выключено. */
    batchWindowMs: number;
    /** Потолок суммарного ожидания серии, мс: дальше отвечаем тем, что есть. */
    batchMaxWaitMs: number;
    transcribeEnabled: boolean;
    transcribeModel: string;
    audioMaxBytes: number;
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
// Пересылка и комментарий к ней приходят двумя апдейтами: ждём соседей,
// чтобы ответить один раз и по полному вопросу.
const DEFAULT_BATCH_WINDOW_MS = 1500;
// waitUntil живёт 30 с, и из них ответ модели тоже должен успеть уложиться.
// 8 с на сбор серии оставляют ~20 с на генерацию и доставку.
const DEFAULT_BATCH_MAX_WAIT_MS = 8000;
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
// Предел эндпоинта транскрипции — 25 МБ; getFile отдаёт максимум 20 МБ,
// поэтому реальным ограничением остаётся Bot API.
const DEFAULT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

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
 * requireHttps rejects a plaintext API base.
 * По http ключ ушёл бы в заголовке Authorization открытым текстом.
 */
function requireHttps(apiBase: string): string {
    if (!apiBase.startsWith('https://')) {
        throw new Error('OPENAI_API_BASE must use https');
    }
    return apiBase;
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
    // Fail closed: недонастроенный воркер не должен принимать апдейты вовсе.
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
        throw new Error('TELEGRAM_WEBHOOK_SECRET is not configured');
    }
    return {
        botToken: env.TELEGRAM_BOT_TOKEN,
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
        apiKey: env.OPENAI_API_KEY ?? '',
        apiBase: requireHttps(
            (env.OPENAI_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ''),
        ),
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
        batchWindowMs: parseIntOr(env.BATCH_WINDOW_MS, DEFAULT_BATCH_WINDOW_MS),
        batchMaxWaitMs: parseIntOr(env.BATCH_MAX_WAIT_MS, DEFAULT_BATCH_MAX_WAIT_MS),
        transcribeEnabled: (env.TRANSCRIBE_ENABLED ?? 'true').toLowerCase() !== 'false',
        transcribeModel: env.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
        audioMaxBytes: parseIntOr(env.AUDIO_MAX_BYTES, DEFAULT_AUDIO_MAX_BYTES),
    };
}
