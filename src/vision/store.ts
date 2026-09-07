import type { TelegramPhotoSize } from '../telegram/types';

/**
 * ImageScope identifies the conversation an image belongs to.
 * Совпадает по смыслу с ConversationKey: картинка живёт в том же топике,
 * что и история, которая на неё ссылается.
 */
export interface ImageScope {
    chatId: number;
    threadId?: number;
}

/**
 * imageKey builds the KV key for one image.
 *
 * Ключ строится на file_unique_id, а не на file_id: он стабилен для одного
 * файла, поэтому повторная присылка той же картинки переиспользует запись
 * вместо создания дубля.
 */
export function imageKey(scope: ImageScope, fileUniqueId: string): string {
    return scope.threadId === undefined
        ? `img:${scope.chatId}:${fileUniqueId}`
        : `img:${scope.chatId}:${scope.threadId}:${fileUniqueId}`;
}

/**
 * pickPhotoSize chooses the largest photo variant that fits the byte limit.
 *
 * Telegram присылает набор уже пережатых версий, поэтому своё уменьшение не
 * нужно — достаточно выбрать подходящую. Варианты без file_size оставляем:
 * поле необязательное, фактический размер проверяется после скачивания.
 * Возвращает null, если ни один вариант не проходит лимит.
 */
export function pickPhotoSize(
    sizes: TelegramPhotoSize[],
    maxBytes: number,
): TelegramPhotoSize | null {
    let best: TelegramPhotoSize | null = null;
    for (const candidate of sizes) {
        if (candidate.file_size !== undefined && candidate.file_size > maxBytes) {
            continue;
        }
        // Порядок массива в Bot API не зафиксирован — сравниваем по площади.
        if (best === null || candidate.width * candidate.height > best.width * best.height) {
            best = candidate;
        }
    }
    return best;
}

/**
 * ImageStore keeps image payloads outside the conversation blob.
 *
 * История в KV — единое значение, читаемое и записываемое на каждое
 * сообщение; base64-картинки в нём раздували бы каждую операцию. Поэтому
 * картинки лежат в своих ключах с более коротким TTL.
 */
export class ImageStore {
    private readonly kv: KVNamespace;
    private readonly ttlSeconds: number;

    constructor(kv: KVNamespace, ttlSeconds: number) {
        this.kv = kv;
        this.ttlSeconds = ttlSeconds;
    }

    async read(key: string): Promise<string | null> {
        return this.kv.get(key, 'text');
    }

    async write(key: string, base64: string): Promise<void> {
        await this.kv.put(key, base64, { expirationTtl: this.ttlSeconds });
    }
}

/**
 * toBase64 encodes downloaded bytes for a data: URL.
 *
 * btoa работает с latin-1, поэтому байты переводим в строку порциями:
 * спред большого массива в String.fromCharCode упирается в лимит аргументов.
 */
export function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    return btoa(binary);
}
