import type { Config } from './config';
import type { ChatProvider } from './llm/provider';
import type { BatchBuffer } from './batch/buffer';
import type { HistoryStore } from './storage/history';
import type { ImageStore } from './vision/store';
import type { TelegramApi } from './telegram/api';

/**
 * HandlerDeps is everything the handlers reach the outside world through.
 *
 * Живёт отдельно от обработчиков: домены (команды, медиа, диалог) ссылаются
 * на этот тип, а на handler.ts — нет, иначе импорты замкнулись бы в кольцо.
 */
export interface HandlerDeps {
    api: TelegramApi;
    provider: ChatProvider;
    history: HistoryStore;
    /** Хранилище картинок: отдельные ключи, чтобы не раздувать историю. */
    images: ImageStore;
    /** Буфер соседних сообщений, чтобы отвечать один раз на пачку. */
    batches: BatchBuffer;
    config: Config;
    /** Пауза перед проверкой буфера; в тестах подменяется. */
    sleep?: (ms: number) => Promise<void>;
    /** Текущее время; в тестах подменяется вместе с sleep. */
    now?: () => number;
}
