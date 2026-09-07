import type {
    ChatMessage,
    ContentPart,
    ImageRefPart,
    StoredChatMessage,
    StoredContentPart,
} from '../llm/provider';

/** Текст вместо картинки, которая не попала в контекст по лимиту. */
const DEGRADED_TEXT = '[изображение из предыдущего сообщения]';
/** Текст вместо картинки, которой уже нет ни в KV, ни в Telegram. */
const MISSING_TEXT = '[изображение недоступно]';

export interface ImageReader {
    read: (key: string) => Promise<string | null>;
}

/**
 * ImageRefetcher pulls an image back from Telegram when its KV entry expired.
 */
export interface ImageRefetcher {
    refetch: (ref: ImageRefPart) => Promise<string | null>;
}

export interface HydrateOptions {
    reader: ImageReader;
    refetcher: ImageRefetcher;
    /** Сколько последних картинок разворачивать в запрос. */
    contextImages: number;
    enabled: boolean;
}

/**
 * hydrateForLlm turns the stored history into messages the provider accepts.
 *
 * Модель не помнит картинки между запросами: чтобы отвечать на вопросы по
 * ранее присланному изображению, его нужно приложить снова. Но каждая
 * картинка тарифицируется в каждом запросе, поэтому разворачиваем только
 * несколько последних, а более старые заменяем текстом — диалог сохраняет
 * связность, а стоимость остаётся предсказуемой.
 */
export async function hydrateForLlm(
    history: StoredChatMessage[],
    options: HydrateOptions,
): Promise<ChatMessage[]> {
    const keep = options.enabled ? collectKeptKeys(history, options.contextImages) : new Set<string>();

    const result: ChatMessage[] = [];
    for (const message of history) {
        if (typeof message.content === 'string') {
            result.push({ role: message.role, content: message.content });
            continue;
        }
        const parts: ContentPart[] = [];
        for (const part of message.content) {
            parts.push(await hydratePart(part, keep, options));
        }
        result.push({ role: message.role, content: parts });
    }
    return result;
}

/**
 * collectKeptKeys picks the keys of the newest images allowed into the request.
 */
function collectKeptKeys(history: StoredChatMessage[], limit: number): Set<string> {
    if (limit <= 0) {
        return new Set();
    }
    const keys: string[] = [];
    for (const message of history) {
        if (typeof message.content === 'string') {
            continue;
        }
        for (const part of message.content) {
            if (part.type === 'image_ref') {
                keys.push(part.key);
            }
        }
    }
    return new Set(keys.slice(-limit));
}

async function hydratePart(
    part: StoredContentPart,
    keep: Set<string>,
    options: HydrateOptions,
): Promise<ContentPart> {
    if (part.type === 'text') {
        return part;
    }
    // Картинка вне лимита и так станет текстом — не тратим на неё чтение и скачивание.
    if (!keep.has(part.key)) {
        return { type: 'text', text: DEGRADED_TEXT };
    }

    const stored = await options.reader.read(part.key);
    if (stored) {
        return { type: 'image', url: dataUrl(part.mime, stored) };
    }

    // TTL картинки короче TTL истории, поэтому промах ожидаем: пробуем
    // перекачать по file_id, и лишь потом сдаёмся.
    const refetched = await options.refetcher.refetch(part);
    return refetched
        ? { type: 'image', url: dataUrl(part.mime, refetched) }
        : { type: 'text', text: MISSING_TEXT };
}

function dataUrl(mime: string, base64: string): string {
    return `data:${mime};base64,${base64}`;
}
