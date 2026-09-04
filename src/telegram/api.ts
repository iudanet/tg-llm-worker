import type {
    ApiResponse,
    EditMessageTextParams,
    SendDocumentParams,
    SendMessageDraftParams,
    SendMessageParams,
    SendRichMessageDraftParams,
    SendRichMessageParams,
    TelegramMessage,
} from './types';

const API_ROOT = 'https://api.telegram.org';

/**
 * TelegramApi is a thin typed wrapper over the Bot API HTTP interface.
 */
export class TelegramApi {
    private readonly token: string;

    constructor(token: string) {
        this.token = token;
    }

    private async call<T>(method: string, payload: unknown): Promise<ApiResponse<T>> {
        const response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = (await response.json()) as ApiResponse<T>;
        if (!body.ok) {
            console.error(JSON.stringify({
                msg: 'telegram api call failed',
                method,
                error_code: body.error_code,
                description: body.description,
            }));
        }
        return body;
    }

    sendMessage(params: SendMessageParams): Promise<ApiResponse<TelegramMessage>> {
        return this.call<TelegramMessage>('sendMessage', params);
    }

    editMessageText(params: EditMessageTextParams): Promise<ApiResponse<TelegramMessage>> {
        return this.call<TelegramMessage>('editMessageText', params);
    }

    /**
     * sendMessageDraft streams a partial answer while the model is still generating.
     * Черновик эфемерный: он не попадает в историю чата и живёт около 30 секунд,
     * поэтому финальный ответ всё равно нужно отправить обычным sendMessage.
     */
    sendMessageDraft(params: SendMessageDraftParams): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('sendMessageDraft', params);
    }

    /**
     * sendRichMessage delivers a structured answer without MarkdownV2 escaping.
     */
    sendRichMessage(params: SendRichMessageParams): Promise<ApiResponse<TelegramMessage>> {
        return this.call<TelegramMessage>('sendRichMessage', params);
    }

    sendRichMessageDraft(params: SendRichMessageDraftParams): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('sendRichMessageDraft', params);
    }

    setWebhook(params: {
        url: string;
        secret_token?: string;
        allowed_updates?: string[];
    }): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('setWebhook', params);
    }

    sendChatAction(chatId: number, action: 'typing'): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
    }

    /**
     * sendDocument uploads the answer as a file using a multipart request.
     */
    async sendDocument(params: SendDocumentParams): Promise<ApiResponse<TelegramMessage>> {
        const form = new FormData();
        form.append('chat_id', String(params.chat_id));
        if (params.message_thread_id !== undefined) {
            form.append('message_thread_id', String(params.message_thread_id));
        }
        if (params.caption) {
            form.append('caption', params.caption);
        }
        form.append('document', new Blob([params.content], { type: 'text/markdown' }), params.filename);

        const response = await fetch(`${API_ROOT}/bot${this.token}/sendDocument`, {
            method: 'POST',
            body: form,
        });
        const body = (await response.json()) as ApiResponse<TelegramMessage>;
        if (!body.ok) {
            console.error(JSON.stringify({
                msg: 'telegram api call failed',
                method: 'sendDocument',
                error_code: body.error_code,
                description: body.description,
            }));
        }
        return body;
    }
}
