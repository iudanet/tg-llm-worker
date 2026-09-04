import type { ChatMessage, ChatProvider, ContentPart, StreamCallbacks } from './provider';

interface OpenAIOptions {
    apiKey: string;
    apiBase: string;
    model: string;
}

/**
 * OpenAIProvider talks to the Chat Completions endpoint in streaming mode.
 */
export class OpenAIProvider implements ChatProvider {
    readonly name = 'openai';
    private readonly options: OpenAIOptions;

    constructor(options: OpenAIOptions) {
        this.options = options;
    }

    async stream(
        messages: ChatMessage[],
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
    ): Promise<string> {
        const response = await fetch(`${this.options.apiBase}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.options.apiKey}`,
            },
            body: JSON.stringify({
                model: this.options.model,
                messages: messages.map(toWireMessage),
                stream: true,
            }),
            signal,
        });

        if (!response.ok || !response.body) {
            const detail = await response.text().catch(() => '');
            throw new Error(`openai request failed: ${response.status} ${detail.slice(0, 500)}`);
        }

        return consumeSSE(response.body, callbacks);
    }
}

/**
 * toWireMessage converts the internal message shape to the OpenAI payload.
 */
function toWireMessage(message: ChatMessage): unknown {
    if (typeof message.content === 'string') {
        return { role: message.role, content: message.content };
    }
    return {
        role: message.role,
        content: message.content.map((part: ContentPart) => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text };
            }
            return { type: 'image_url', image_url: { url: part.url } };
        }),
    };
}

/**
 * consumeSSE reads a server-sent events stream and accumulates the answer.
 */
async function consumeSSE(body: ReadableStream<Uint8Array>, callbacks: StreamCallbacks): Promise<string> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let accumulated = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += value;

        // SSE-события разделены пустой строкой; последний фрагмент может быть неполным.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
            for (const line of event.split('\n')) {
                if (!line.startsWith('data:')) {
                    continue;
                }
                const data = line.slice(5).trim();
                if (data === '[DONE]') {
                    return accumulated;
                }
                const delta = extractDelta(data);
                if (delta) {
                    accumulated += delta;
                    await callbacks.onDelta(accumulated);
                }
            }
        }
    }
    return accumulated;
}

function extractDelta(data: string): string | null {
    try {
        const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
        };
        return parsed.choices?.[0]?.delta?.content ?? null;
    } catch {
        // Битый чанк не должен ронять весь ответ.
        console.error(JSON.stringify({ msg: 'failed to parse sse chunk' }));
        return null;
    }
}
