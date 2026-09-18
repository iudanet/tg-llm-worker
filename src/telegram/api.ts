import type {
    ApiResponse,
    EditMessageTextParams,
    SendDocumentParams,
    SendMessageDraftParams,
    SendMessageParams,
    SendRichMessageDraftParams,
    SendRichMessageParams,
    TelegramFile,
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

    /**
     * setMyCommands publishes the command menu for one scope.
     */
    setMyCommands(
        commands: Array<{ command: string; description: string }>,
        scope?: { type: string },
    ): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('setMyCommands', scope ? { commands, scope } : { commands });
    }

    deleteMyCommands(scope?: { type: string }): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('deleteMyCommands', scope ? { scope } : {});
    }

    /**
     * getFile resolves a file_id into a downloadable path.
     * Ограничение Bot API — файлы до 20 МБ.
     */
    getFile(fileId: string): Promise<ApiResponse<TelegramFile>> {
        return this.call<TelegramFile>('getFile', { file_id: fileId });
    }

    /**
     * downloadFile fetches file content by the path returned from getFile.
     * Возвращает null, если файл недоступен: протухший file_path — штатная
     * ситуация, диалог из-за неё ломаться не должен.
     */
    async downloadFile(filePath: string): Promise<ArrayBuffer | null> {
        const response = await fetch(`${API_ROOT}/file/bot${this.token}/${filePath}`);
        if (!response.ok) {
            console.error(JSON.stringify({
                msg: 'file download failed',
                status: response.status,
            }));
            return null;
        }
        return response.arrayBuffer();
    }

    /**
     * editForumTopic renames a topic.
     * Клиент Telegram присваивает новому топику имя «Новый чат», поэтому
     * осмысленный заголовок ставит бот — по первому сообщению пользователя.
     */
    editForumTopic(chatId: number, messageThreadId: number, name: string): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('editForumTopic', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
            name,
        });
    }

    /**
     * deleteForumTopic removes a topic together with all of its messages.
     * Работает и в приватном чате: Bot API не сообщает боту об удалении треда
     * пользователем, поэтому удаление инициирует сам бот по команде.
     */
    deleteForumTopic(chatId: number, messageThreadId: number): Promise<ApiResponse<boolean>> {
        return this.call<boolean>('deleteForumTopic', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
        });
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
        if (params.reply_parameters) {
            // multipart передаёт вложенные структуры только строкой JSON.
            form.append('reply_parameters', JSON.stringify(params.reply_parameters));
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
