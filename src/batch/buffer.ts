import type { StoredChatMessage, StoredContentPart } from '../llm/provider';

/**
 * PendingMessage is one user message waiting to be answered together
 * with the ones that arrive right after it.
 */
export interface PendingMessage {
    /** message_id Telegram: по нему определяется, кто пришёл последним. */
    id: number;
    content: string | StoredContentPart[];
}

export interface PendingBatch {
    messages: PendingMessage[];
}

export interface BatchScope {
    chatId: number;
    threadId?: number;
}

/**
 * pendingKey builds the KV key holding the buffer of one conversation.
 */
export function pendingKey(scope: BatchScope): string {
    return scope.threadId === undefined
        ? `pending:${scope.chatId}`
        : `pending:${scope.chatId}:${scope.threadId}`;
}

/**
 * BatchBuffer collects messages that arrive within one short window.
 *
 * Telegram доставляет пересылку и комментарий к ней как два независимых
 * апдейта, поэтому бот отвечал дважды и вторая запись истории перетирала
 * первую. Буфер собирает их в одну пачку.
 *
 * Ограничение: KV не даёт атомарных операций, а записи расходятся между
 * локациями. Если апдейты попали в разные изоляты, оба могут счесть себя
 * последними — тогда поведение деградирует до прежнего (два ответа), но
 * ничего не ломается.
 */
export class BatchBuffer {
    private readonly kv: KVNamespace;
    private readonly ttlSeconds: number;

    constructor(kv: KVNamespace, ttlSeconds: number) {
        this.kv = kv;
        this.ttlSeconds = ttlSeconds;
    }

    async load(scope: BatchScope): Promise<PendingBatch> {
        const raw = await this.kv.get(pendingKey(scope), 'json') as PendingBatch | null;
        return raw && Array.isArray(raw.messages) ? raw : { messages: [] };
    }

    async append(scope: BatchScope, message: PendingMessage): Promise<PendingBatch> {
        const batch = await this.load(scope);
        const messages = appendPending(batch.messages, message);
        // TTL страхует от зависшего буфера: окно ожидания — секунды,
        // поэтому минимальный TTL KV с запасом достаточен.
        await this.kv.put(pendingKey(scope), JSON.stringify({ messages }), {
            expirationTtl: this.ttlSeconds,
        });
        return { messages };
    }

    async clear(scope: BatchScope): Promise<void> {
        await this.kv.delete(pendingKey(scope));
    }
}

/**
 * appendPending adds a message to the buffer, keeping it free of duplicates.
 * Telegram может доставить один апдейт повторно, а дубль в контексте
 * выглядел бы как повтор вопроса пользователем.
 */
export function appendPending(
    messages: PendingMessage[],
    incoming: PendingMessage,
): PendingMessage[] {
    const withoutDuplicate = messages.filter(entry => entry.id !== incoming.id);
    return [...withoutDuplicate, incoming].sort((a, b) => a.id - b.id);
}

/**
 * isLastInBatch tells whether this message should produce the answer.
 *
 * Отвечает пришедший последним, а не первым: к моменту его окна в буфере
 * уже лежит вся пачка, поэтому ответ получается один и по полному контексту.
 */
export function isLastInBatch(batch: PendingBatch, messageId: number): boolean {
    for (const entry of batch.messages) {
        if (entry.id > messageId) {
            return false;
        }
    }
    return true;
}

/** Вопрос по умолчанию, если пришли только картинки без подписи. */
export const IMAGE_ONLY_QUESTION = 'Что на этом изображении?';

/**
 * mergeBatch turns a buffered batch into one message for the model.
 *
 * Части склеиваются в одно сообщение user: пересланный текст и комментарий
 * к нему — это один вопрос, а не два.
 */
export function mergeBatch(batch: PendingBatch): StoredChatMessage | null {
    if (batch.messages.length === 0) {
        return null;
    }

    const parts: StoredContentPart[] = [];
    for (const entry of batch.messages) {
        if (typeof entry.content === 'string') {
            parts.push({ type: 'text', text: entry.content });
            continue;
        }
        parts.push(...entry.content);
    }

    // Картинка без подписи: вопрос подставляем здесь, а не при приёме, —
    // в альбоме подпись может прийти отдельным сообщением. Ставим первым,
    // чтобы вопрос читался до картинки и в истории.
    if (!parts.some(part => part.type === 'text')) {
        parts.unshift({ type: 'text', text: IMAGE_ONLY_QUESTION });
    }

    const merged = mergeAdjacentText(parts);
    // Одиночный текст храним строкой — история остаётся компактной.
    if (merged.length === 1 && merged[0]?.type === 'text') {
        return { role: 'user', content: merged[0].text };
    }
    return { role: 'user', content: merged };
}

/**
 * mergeAdjacentText joins neighbouring text parts with a blank line.
 * Модель получает связный текст, а не набор обрывков.
 */
function mergeAdjacentText(parts: StoredContentPart[]): StoredContentPart[] {
    const result: StoredContentPart[] = [];
    for (const part of parts) {
        const previous = result.at(-1);
        if (part.type === 'text' && previous?.type === 'text') {
            result[result.length - 1] = {
                type: 'text',
                text: `${previous.text}\n\n${part.text}`,
            };
            continue;
        }
        result.push(part);
    }
    return result;
}
