import type { HandlerDeps } from '../deps';
import type {
    ChatMessage,
    ImageRefPart,
    StoredChatMessage,
} from '../llm/provider';
import type { PendingMessage } from '../batch/buffer';
import type { ConversationKey } from '../storage/history';
import type { TelegramMessage } from '../telegram/types';
import { deliverAnswer } from '../telegram/deliver';
import { destinationOf, Replier } from '../telegram/reply';
import { DraftStreamer } from '../telegram/stream';
import { topicNameFrom } from '../telegram/title';
import { isLastInBatch, mergeBatch, shouldWaitLonger } from '../batch/buffer';
import { hydrateForLlm } from '../vision/hydrate';
import { toBase64 } from '../vision/store';

/** defaultSleep — пауза окна; в воркере это wall time, лимит CPU не тратится. */
function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * enqueue buffers one message and answers only for the last of a burst.
 *
 * Пересылка и комментарий к ней приходят двумя независимыми апдейтами:
 * без буфера бот отвечал на каждый по отдельности, а вторая запись истории
 * перетирала первую. Здесь сообщение копится в KV, затем выжидается окно,
 * и отвечает только тот апдейт, после которого ничего не пришло.
 *
 * Ограничение KV: атомарности нет, записи расходятся между локациями. Если
 * апдейты попали в разные изоляты, оба могут счесть себя последними — тогда
 * поведение деградирует до прежнего, но ничего не ломается.
 */
export async function enqueue(
    message: TelegramMessage,
    deps: HandlerDeps,
    content: PendingMessage['content'],
): Promise<void> {
    const scope = { chatId: message.chat.id, threadId: message.message_thread_id };
    const pending: PendingMessage = { id: message.message_id, content };

    // Окно выключено — отвечаем сразу, но через ту же нормализацию,
    // чтобы поведение не зависело от настройки.
    if (deps.config.batchWindowMs <= 0) {
        const single = mergeBatch({ messages: [pending] });
        if (single) {
            await runTurn(single, message, deps);
        }
        return;
    }

    await deps.batches.append(scope, pending);

    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? (() => Date.now());
    const deadline = now() + deps.config.batchMaxWaitMs;

    // Окно скользящее: каждое новое сообщение продлевает ожидание, поэтому
    // серия любой длины склеивается, пока паузы внутри неё меньше окна.
    // Потолок по времени обязателен: waitUntil живёт 30 с, и ответ модели
    // тоже должен в них уложиться, поэтому непрерывный поток сообщений
    // не может держать нас сколько угодно.
    let batch = await deps.batches.load(scope);
    while (true) {
        await sleep(deps.config.batchWindowMs);
        batch = await deps.batches.load(scope);
        if (!shouldWaitLonger(batch, deps.config.batchWindowMs, now())) {
            break;
        }
        if (now() >= deadline) {
            // Серия ещё идёт, но ждать больше нельзя — отвечаем тем, что есть.
            console.error(JSON.stringify({
                msg: 'batch wait capped',
                chat_id: message.chat.id,
                pending: batch.messages.length,
            }));
            break;
        }
    }

    if (!isLastInBatch(batch, message.message_id)) {
        // Ответит более позднее сообщение — оно видит всю пачку.
        return;
    }

    const merged = mergeBatch(batch);
    if (!merged) {
        return;
    }
    // Чистим буфер до ответа: иначе следующий вопрос склеится с этой пачкой.
    await deps.batches.clear(scope);
    await runTurn(merged, message, deps);
}

/**
 * runTurn drives one exchange: stream the answer, deliver it, persist history.
 * Общий путь для текста и картинок — различие только в составе сообщения.
 */
export async function runTurn(
    userMessage: StoredChatMessage,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const to = destinationOf(message);
    const replier = new Replier(deps.api, to);
    const key: ConversationKey = { chatId: to.chatId, threadId: to.threadId };
    const history = await deps.history.load(key);

    // Пустая история = первое сообщение в топике: только здесь ставим имя,
    // чтобы не перебивать заголовок, заданный пользователем вручную.
    if (history.length === 0) {
        await nameTopic(message, deps);
    }

    const stored: StoredChatMessage[] = [...history, userMessage];
    // Ссылки на картинки разворачиваются в data-URL только здесь: в KV
    // и дальше по коду они остаются ссылками.
    const conversation: ChatMessage[] = await hydrateForLlm(stored, {
        reader: deps.images,
        refetcher: { refetch: ref => refetchImage(ref, deps) },
        contextImages: deps.config.visionContextImages,
        enabled: deps.config.visionEnabled,
    });
    if (deps.config.systemPrompt) {
        conversation.unshift({ role: 'system', content: deps.config.systemPrompt });
    }

    const streamer = new DraftStreamer(deps.api, {
        chatId: to.chatId,
        threadId: to.threadId,
        intervalMs: deps.config.streamIntervalMs,
    });
    await streamer.start();

    // Копим ответ здесь, а не внутри провайдера: при обрыве по таймауту
    // исключение уносит всё, что накопилось у него внутри, а этот текст
    // остаётся — и его ещё можно доставить.
    let partial = '';
    const controller = new AbortController();
    // waitUntil убивает воркер примерно на 30-й секунде, и тогда пропадает
    // и ответ, и история: черновик эфемерный, он просто протухает. Рвём
    // генерацию заранее, чтобы успеть отправить хотя бы часть.
    const timer = setTimeout(() => controller.abort(), deps.config.generationTimeoutMs);

    let answer: string;
    let truncated = false;
    try {
        answer = await deps.provider.stream(conversation, {
            onDelta: accumulated => {
                partial = accumulated;
                return streamer.update(accumulated);
            },
        }, controller.signal);
    } catch (error) {
        if (controller.signal.aborted && partial.trim() !== '') {
            // Успели получить часть ответа — она полезнее, чем ничего.
            console.error(JSON.stringify({
                msg: 'generation timed out, delivering partial answer',
                chat_id: to.chatId,
                length: partial.length,
                timeout_ms: deps.config.generationTimeoutMs,
            }));
            answer = `${partial}\n\n[…ответ обрезан по таймауту, попросите продолжить]`;
            truncated = true;
        } else {
            console.error(JSON.stringify({
                msg: 'llm request failed',
                chat_id: to.chatId,
                aborted: controller.signal.aborted,
                error: error instanceof Error ? error.message : String(error),
            }));
            await replier.text(controller.signal.aborted
                ? 'Модель не успела ответить за отведённое время. Попробуйте переспросить короче.'
                : 'Не удалось получить ответ от модели. Попробуйте ещё раз.');
            return;
        }
    } finally {
        clearTimeout(timer);
    }

    await deliverAnswer(deps.api, answer, {
        ...to,
        documentThreshold: deps.config.documentThreshold,
        useRichMessages: deps.config.useRichMessages,
    });

    // В историю кладём текст без служебной пометки: она адресована человеку,
    // а модели в следующем запросе только мешает.
    const forHistory = truncated ? partial : answer;
    await deps.history.save(key, [...stored, { role: 'assistant', content: forHistory }]);
}

/**
 * nameTopic titles a fresh topic after the user's first message.
 *
 * Клиент Telegram называет новый топик «Новый чат» — осмысленный заголовок
 * ставит бот. Неудача переименования сознательно игнорируется: имя топика
 * косметика, из-за него ответ пользователю ломаться не должен.
 */
async function nameTopic(message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const threadId = message.message_thread_id;
    if (threadId === undefined) {
        // Вне топиков переименовывать нечего.
        return;
    }
    const source = message.text ?? message.caption ?? '';
    const name = topicNameFrom(source);
    if (!name) {
        return;
    }

    const result = await deps.api.editForumTopic(message.chat.id, threadId, name);
    if (!result.ok) {
        console.error(JSON.stringify({
            msg: 'editForumTopic failed',
            chat_id: message.chat.id,
            message_thread_id: threadId,
            description: result.description,
        }));
    }
}

/**
 * refetchImage pulls an image back from Telegram after its KV entry expired.
 * TTL картинки короче TTL истории, поэтому такой промах — ожидаемый случай.
 */
async function refetchImage(ref: ImageRefPart, deps: HandlerDeps): Promise<string | null> {
    const file = await deps.api.getFile(ref.fileId);
    if (!file.ok || !file.result?.file_path) {
        return null;
    }
    const buffer = await deps.api.downloadFile(file.result.file_path);
    if (!buffer) {
        return null;
    }
    const base64 = toBase64(buffer);
    // Возвращаем в KV, чтобы следующий вопрос по этой картинке не качал её снова.
    await deps.images.write(ref.key, base64);
    return base64;
}
