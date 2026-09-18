/**
 * Minimal subset of the Telegram Bot API types this bot actually consumes.
 */
export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
    has_topics_enabled?: boolean;
}

export interface TelegramChat {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
}

export interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

/** Источник пересланного сообщения (Bot API 7.0+). */
export interface TelegramForwardOrigin {
    type: 'user' | 'hidden_user' | 'chat' | 'channel';
    sender_user?: TelegramUser;
    sender_user_name?: string;
    chat?: TelegramChat;
    author_signature?: string;
}

/**
 * Voice note or audio file. Telegram отдаёт голосовые в OGG/Opus,
 * поэтому mime_type пригодится при отправке на распознавание.
 */
export interface TelegramVoice {
    file_id: string;
    file_unique_id?: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
    file_name?: string;
}

export interface TelegramMessage {
    message_id: number;
    message_thread_id?: number;
    is_topic_message?: boolean;
    from?: TelegramUser;
    chat: TelegramChat;
    date: number;
    text?: string;
    caption?: string;
    /** Заполнено, если сообщение переслано. */
    forward_origin?: TelegramForwardOrigin;
    /** Общий идентификатор альбома: фото из одной отправки склеиваются. */
    media_group_id?: string;
    entities?: unknown[];
    photo?: TelegramPhotoSize[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
    voice?: TelegramVoice;
    audio?: TelegramVoice;
    video?: { file_id: string };
    sticker?: { file_id: string };
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
}

export interface SendMessageParams {
    chat_id: number;
    message_thread_id?: number;
    text: string;
    parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    reply_parameters?: {
        message_id: number;
        allow_sending_without_reply?: boolean;
    };
    link_preview_options?: {
        is_disabled?: boolean;
    };
}

export interface EditMessageTextParams {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
}

/**
 * Bot API 9.3 (2025-12-31), available to all bots since 9.5 (2026-03-01).
 * Работает только в приватных чатах и требует включённого Forum Topic Mode.
 */
export interface SendMessageDraftParams {
    chat_id: number;
    message_thread_id?: number;
    draft_id: number;
    text?: string;
    parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    can_stop?: boolean;
    keep_on_stop?: boolean;
}

/**
 * File as returned by getFile. Работает только с файлами до 20 МБ;
 * file_path действителен не меньше часа, потом запрашивается заново.
 */
export interface TelegramFile {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
}

export interface ApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
}

export interface SendDocumentParams {
    chat_id: number;
    message_thread_id?: number;
    filename: string;
    content: string;
    caption?: string;
    reply_parameters?: {
        message_id: number;
        allow_sending_without_reply?: boolean;
    };
}

export interface SendRichMessageParams {
    chat_id: number;
    message_thread_id?: number;
    rich_message: import('./rich').InputRichMessage;
    reply_parameters?: {
        message_id: number;
        allow_sending_without_reply?: boolean;
    };
}

export interface SendRichMessageDraftParams {
    chat_id: number;
    message_thread_id?: number;
    draft_id: number;
    rich_message: import('./rich').InputRichMessage;
    can_stop?: boolean;
    keep_on_stop?: boolean;
}
