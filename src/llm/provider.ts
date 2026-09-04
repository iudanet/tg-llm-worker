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

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
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
