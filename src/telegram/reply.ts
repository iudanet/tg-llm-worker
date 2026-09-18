import type { TelegramApi } from './api';
import type { TelegramMessage } from './types';

/**
 * Destination is the address an answer goes back to.
 *
 * Раньше адрес существовал только как пара chat_id + message_thread_id,
 * которую каждый вызов собирал заново — их набралось под три десятка. Любая
 * правка маршрутизации требовала обойти все места и ничего не забыть.
 * Здесь адрес — одно значение, и создаётся он ровно в одном месте.
 */
export interface Destination {
    chatId: number;
    /** Топик внутри чата; отсутствует, если чат без топиков. */
    threadId?: number;
    /** Сообщение, вызвавшее ответ: к нему привязывается ветка обсуждения. */
    replyToMessageId?: number;
}

/**
 * destinationOf derives the answer address from an incoming message.
 *
 * Единственное место, где адрес извлекается из апдейта: если Telegram
 * поменяет способ адресации топиков, правка будет здесь, а не в 28 местах.
 */
export function destinationOf(message: TelegramMessage): Destination {
    return {
        chatId: message.chat.id,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
    };
}

/**
 * Replier sends messages to one destination.
 *
 * Обёртка поверх TelegramApi, знающая адрес: обработчикам больше не нужно
 * помнить, какие поля маршрутизации проставить, — они просто говорят «ответь».
 */
export class Replier {
    private readonly api: TelegramApi;
    private readonly destination: Destination;

    constructor(api: TelegramApi, destination: Destination) {
        this.api = api;
        this.destination = destination;
    }

    /** to returns the routing fields every send method needs. */
    get address(): Destination {
        return this.destination;
    }

    /**
     * text sends a plain notice: an error, a refusal, a status line.
     *
     * Отказ логируется и проглатывается: это служебные сообщения, и падение
     * на них не должно ломать обработку апдейта.
     */
    async text(message: string): Promise<void> {
        const response = await this.api.sendMessage({
            chat_id: this.destination.chatId,
            message_thread_id: this.destination.threadId,
            text: message,
        });
        if (!response.ok) {
            console.error(JSON.stringify({
                msg: 'notice delivery failed',
                chat_id: this.destination.chatId,
                description: response.description,
            }));
        }
    }
}
