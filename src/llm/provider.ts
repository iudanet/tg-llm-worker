/**
 * TextPart and ImagePart keep the message shape open for multimodal input.
 * MVP отправляет только текст, но структура уже готова к картинкам.
 */
export interface TextPart {
    type: 'text';
    text: string;
}

export interface ImagePart {
    type: 'image';
    /** data: URL или https-ссылка на изображение */
    url: string;
}

/**
 * ImageRefPart points at an image kept outside the conversation blob.
 *
 * Хранится только в KV и никогда не уходит провайдеру: картинки лежат в
 * отдельных ключах, чтобы блоб истории не раздувался, а перед запросом
 * ссылка разворачивается в ImagePart (см. vision/hydrate).
 */
export interface ImageRefPart {
    type: 'image_ref';
    /** Ключ картинки в KV */
    key: string;
    /** file_id для повторного скачивания, если ключ уже протух */
    fileId: string;
    mime: string;
}

/** Части, которые понимает провайдер. */
export type ContentPart = TextPart | ImagePart;

/** Части, которые могут лежать в истории. */
export type StoredContentPart = TextPart | ImageRefPart;

/** Сообщение, готовое к отправке провайдеру. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
}

/**
 * StoredChatMessage is the on-disk shape kept in KV.
 * Отличается от ChatMessage тем, что картинка представлена ссылкой:
 * тип не даст случайно отправить image_ref провайдеру.
 */
export interface StoredChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | StoredContentPart[];
}

export interface StreamCallbacks {
    /** onDelta вызывается на каждый кусок текста от модели */
    onDelta: (accumulated: string) => Promise<void>;
}

/**
 * ChatProvider is the seam that keeps a second LLM vendor cheap to add.
 */
export interface ChatProvider {
    readonly name: string;
    stream: (
        messages: ChatMessage[],
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
    ) => Promise<string>;
}
