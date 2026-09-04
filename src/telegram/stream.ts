import type { TelegramApi } from './api';

export interface DraftStreamOptions {
    chatId: number;
    threadId?: number;
    /** Минимальный интервал между обновлениями черновика, мс. */
    intervalMs: number;
}

/**
 * DraftStreamer shows the answer as it is being generated.
 *
 * Черновик эфемерный и не остаётся в истории чата, поэтому финальный ответ
 * всегда отправляется отдельно. Обновления троттлятся: без этого частые
 * вызовы упираются в rate limit Telegram.
 */
export class DraftStreamer {
    private readonly api: TelegramApi;
    private readonly options: DraftStreamOptions;
    private readonly draftId: number;
    private lastSentAt = 0;
    private lastText = '';
    private disabled = false;

    constructor(api: TelegramApi, options: DraftStreamOptions) {
        this.api = api;
        this.options = options;
        // Один draft_id на весь ответ — Telegram анимирует дописывание текста.
        this.draftId = Date.now() % 2_147_483_647 || 1;
    }

    /** start shows a "Thinking…" placeholder before the first token arrives. */
    async start(): Promise<void> {
        await this.push('', true);
    }

    async update(text: string): Promise<void> {
        await this.push(text, false);
    }

    private async push(text: string, force: boolean): Promise<void> {
        if (this.disabled) {
            return;
        }
        const now = Date.now();
        if (!force && now - this.lastSentAt < this.options.intervalMs) {
            return;
        }
        if (!force && text === this.lastText) {
            return;
        }

        this.lastSentAt = now;
        this.lastText = text;

        const response = await this.api.sendMessageDraft({
            chat_id: this.options.chatId,
            message_thread_id: this.options.threadId,
            draft_id: this.draftId,
            // Черновик ограничен теми же 4096 символами, что и сообщение.
            text: text.slice(-4096),
            can_stop: true,
        });

        if (!response.ok) {
            // Метод доступен не всем чатам (нужен Forum Topic Mode, только личка).
            // Отключаем стриминг, но сам ответ это ломать не должно.
            this.disabled = true;
            console.error(JSON.stringify({
                msg: 'draft streaming disabled',
                description: response.description,
            }));
        }
    }
}
