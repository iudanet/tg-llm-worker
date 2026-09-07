import type { Config } from './config';
import type {
    ChatMessage,
    ChatProvider,
    ImageRefPart,
    StoredChatMessage,
} from './llm/provider';
import type { BatchBuffer, PendingMessage } from './batch/buffer';
import type { ConversationKey, HistoryStore } from './storage/history';
import type { ImageStore } from './vision/store';
import type { TelegramApi } from './telegram/api';
import type {
    TelegramMessage,
    TelegramPhotoSize,
    TelegramUpdate,
    TelegramVoice,
} from './telegram/types';
import { deliverAnswer } from './telegram/deliver';
import { DraftStreamer } from './telegram/stream';
import { topicNameFrom } from './telegram/title';
import { audioFileName, transcribe, TranscribeError } from './audio/transcribe';
import { BUILD_COMMIT, BUILD_VERSION } from './version';
import { isLastInBatch, mergeBatch, shouldWaitLonger } from './batch/buffer';
import { hydrateForLlm } from './vision/hydrate';
import { imageKey, pickPhotoSize, toBase64 } from './vision/store';

/**
 * BOT_COMMANDS публикуется в меню Telegram при инициализации воркера.
 * Порядок важен: Telegram показывает команды именно в этом порядке,
 * а /start — первое, что видит новый пользователь.
 */
export const BOT_COMMANDS = [
    { command: 'start', description: 'Начать диалог' },
    { command: 'new', description: 'Очистить контекст и начать заново' },
    { command: 'delete', description: 'Удалить этот топик вместе с контекстом' },
    { command: 'info', description: 'Версия и возможности бота' },
    { command: 'help', description: 'Справка по боту' },
];

const START_TEXT = [
    'Привет! Задайте вопрос — отвечу с помощью языковой модели.',
    '',
    'Контекст диалога помню, /new его очищает. Подробнее — /help.',
].join('\n');

const HELP_TEXT = [
    'Команды:',
    '/start — начать диалог',
    '/new — начать новый диалог (очистить контекст)',
    '/delete — удалить этот топик вместе с контекстом',
    '/info — версия и возможности',
    '/help — эта справка',
    '',
    'История хранится отдельно для каждого топика, поэтому /new очищает',
    'только текущий разговор.',
    '',
    'Telegram не сообщает боту об удалении топика вручную: в этом случае',
    'контекст исчезнет сам по таймауту. /delete убирает его сразу.',
].join('\n');

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

/**
 * handleUpdate processes a single Telegram webhook update.
 */
export async function handleUpdate(update: TelegramUpdate, deps: HandlerDeps): Promise<void> {
    const message = update.message;
    if (!message?.from) {
        return;
    }
    if (!isAllowed(message, deps.config)) {
        console.error(JSON.stringify({
            msg: 'rejected by whitelist',
            user_id: message.from.id,
            chat_id: message.chat.id,
        }));
        return;
    }

    if (message.photo?.length) {
        await handlePhoto(message.photo, message, deps);
        return;
    }

    const voice = message.voice ?? message.audio;
    if (voice) {
        await handleVoice(voice, message, deps);
        return;
    }

    // Остальные вложения не поддерживаются: молчание в ответ выглядит
    // как поломка, поэтому явно говорим, чего бот не умеет.
    const unsupported = describeUnsupported(message);
    if (unsupported) {
        await deps.api.sendMessage({
            chat_id: message.chat.id,
            message_thread_id: message.message_thread_id,
            text: unsupported,
        });
        return;
    }

    const text = message.text?.trim();
    if (!text) {
        return;
    }
    if (text.startsWith('/')) {
        await handleCommand(text, message, deps);
        return;
    }
    await handleChat(text, message, deps);
}

/**
 * describeUnsupported names the attachment kind the bot cannot handle yet.
 * Возвращает null, если сообщение обычное текстовое.
 */
export function describeUnsupported(message: TelegramMessage): string | null {
    if (message.document) {
        return 'Пока не умею читать файлы. Пришлите содержимое текстом.';
    }
    if (message.video) {
        return 'Пока не умею смотреть видео.';
    }
    if (message.sticker) {
        return 'На стикеры отвечать не умею — напишите текстом.';
    }
    return null;
}

/**
 * isAllowed checks the sender against the configured whitelist.
 */
export function isAllowed(message: TelegramMessage, config: Config): boolean {
    if (config.whiteList.size === 0) {
        return false;
    }
    const userId = message.from?.id;
    return userId !== undefined && config.whiteList.has(userId);
}

async function handleCommand(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const command = text.split(/\s+/)[0]?.split('@')[0];
    const chatId = message.chat.id;
    const key: ConversationKey = { chatId, threadId: message.message_thread_id };

    switch (command) {
        case '/start':
        case '/new':
            await deps.history.clear(key);
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                // /start у нового пользователя очищать нечего: приветствие
                // уместнее рапорта об очистке контекста.
                text: command === '/start' ? START_TEXT : 'Контекст очищен. Начинаем новый диалог.',
            });
            return;
        case '/delete':
            await deleteConversation(message, deps);
            return;
        case '/info':
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                text: buildInfoText(deps.config),
            });
            return;
        case '/help':
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                text: HELP_TEXT,
            });
            return;
        default:
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                text: `Неизвестная команда. ${HELP_TEXT}`,
            });
    }
}

/**
 * buildInfoText describes the build and what this bot can actually do.
 *
 * Возможности перечисляются по фактическим настройкам, а не списком из
 * README: если vision или распознавание выключены, обещать их нельзя.
 */
export function buildInfoText(config: Config): string {
    const lines = [
        `tg-llm-worker ${BUILD_VERSION} (${BUILD_COMMIT})`,
        '',
        'Telegram-бот с языковой моделью на Cloudflare Workers.',
        '',
        `Модель: ${config.model}`,
        `Контекст: до ${config.historyMaxMessages} сообщений, ` +
            `сброс через ${Math.round(config.historyTtlSeconds / 3600)} ч`,
        '',
        'Умеет:',
        '• отвечать текстом со стримингом ответа',
        config.visionEnabled
            ? `• читать картинки и отвечать на вопросы по ним (до ${config.visionContextImages} в контексте)`
            : '• картинки: выключено',
        config.transcribeEnabled
            ? '• распознавать голосовые и аудио'
            : '• распознавание голоса: выключено',
        config.batchWindowMs > 0
            ? '• склеивать серию сообщений подряд в один ответ'
            : '• отвечать на каждое сообщение отдельно',
        '• отдавать длинный ответ файлом .md',
        '',
        'Не умеет: генерировать картинки, читать файлы и видео,',
        'ходить во внешние API.',
        '',
        'Исходники: https://github.com/iudanet/tg-llm-worker',
    ];
    return lines.join('\n');
}

/**
 * deleteConversation drops the stored context and removes the topic itself.
 *
 * Bot API не присылает событий об удалении топика пользователем, поэтому
 * удаление инициирует бот. Порядок шагов важен:
 *   1) чистим KV — это главное, что обещает команда;
 *   2) отвечаем, пока топик ещё существует: в удалённый уже не доставить;
 *   3) удаляем топик — отказ метода не должен отменять первые два шага.
 */
async function deleteConversation(message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    const key: ConversationKey = { chatId, threadId };

    await deps.history.clear(key);

    // Вне топика удалять нечего — команда вырождается в очистку контекста.
    if (threadId === undefined) {
        await deps.api.sendMessage({
            chat_id: chatId,
            text: 'Контекст очищен. Этот чат без топиков, поэтому удалять нечего.',
        });
        return;
    }

    await deps.api.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: 'Контекст очищен, удаляю топик.',
    });

    const result = await deps.api.deleteForumTopic(chatId, threadId);
    if (!result.ok) {
        // Топик остался, но контекст уже забыт — сообщаем, что осталось сделать руками.
        console.error(JSON.stringify({
            msg: 'deleteForumTopic failed',
            chat_id: chatId,
            message_thread_id: threadId,
            description: result.description,
        }));
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Контекст очищен, но удалить топик не удалось — удалите его вручную.',
        });
    }
}

/**
 * handlePhoto stores the image and asks the model about it.
 *
 * Картинка не кладётся в блоб истории: она уходит в свой KV-ключ, а в
 * истории остаётся ссылка. Иначе каждое последующее сообщение читало и
 * писало бы мегабайты base64.
 */
async function handlePhoto(
    photo: TelegramPhotoSize[],
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;

    if (!deps.config.visionEnabled) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Обработка картинок отключена в настройках бота.',
        });
        return;
    }

    const limitMb = (deps.config.imageMaxBytes / (1024 * 1024)).toFixed(1);
    const size = pickPhotoSize(photo, deps.config.imageMaxBytes);
    if (!size) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: `Картинка слишком большая — лимит ${limitMb} МБ.`,
        });
        return;
    }

    const stored = await storePhoto(size, { chatId, threadId }, deps);
    if (!stored) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Не удалось загрузить картинку из Telegram. Попробуйте ещё раз.',
        });
        return;
    }

    // Подпись к фото — вопрос пользователя. Пустую подпись не подставляем
    // своей: в альбоме вопрос может прийти отдельным сообщением.
    const caption = message.caption?.trim();
    await enqueue(message, deps, caption
        ? [{ type: 'text', text: caption }, stored]
        : [stored]);
}

/**
 * handleVoice transcribes a voice note and answers the question in it.
 *
 * Расшифровка отправляется пользователю отдельным сообщением: распознавание
 * ошибается, и без показанного текста непонятно, на что именно ответил бот.
 * В историю попадает уже текст, поэтому дальше можно уточнять вопросами.
 */
async function handleVoice(
    voice: TelegramVoice,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;

    if (!deps.config.transcribeEnabled) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Распознавание голоса отключено в настройках бота.',
        });
        return;
    }
    if (!deps.config.apiKey) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Распознавание недоступно: не настроен ключ API.',
        });
        return;
    }

    // Размер известен заранее — большой файл отклоняем без скачивания.
    if (voice.file_size !== undefined && voice.file_size > deps.config.audioMaxBytes) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Запись слишком большая для распознавания.',
        });
        return;
    }

    const file = await deps.api.getFile(voice.file_id);
    if (!file.ok || !file.result?.file_path) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Не удалось получить запись из Telegram. Попробуйте ещё раз.',
        });
        return;
    }

    const audio = await deps.api.downloadFile(file.result.file_path);
    if (!audio) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Не удалось скачать запись. Попробуйте ещё раз.',
        });
        return;
    }

    let text: string;
    try {
        const result = await transcribe(
            audio,
            audioFileName(voice, file.result.file_path),
            voice.mime_type,
            {
                apiKey: deps.config.apiKey,
                apiBase: deps.config.apiBase,
                model: deps.config.transcribeModel,
            },
        );
        text = result.text;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
            msg: 'transcription failed',
            chat_id: chatId,
            mime: voice.mime_type,
            duration: voice.duration,
            error: detail,
        }));
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: error instanceof TranscribeError
                ? error.userMessage
                : 'Не удалось распознать запись. Попробуйте ещё раз.',
        });
        return;
    }

    // Показываем расшифровку до ответа: видно, что именно бот расслышал.
    await deps.api.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: `🎙 ${text}`,
    });

    await enqueue(message, deps, text);
}

/**
 * storePhoto downloads one photo variant and keeps it in KV.
 * Возвращает ссылку для истории или null, если картинку получить не удалось.
 */
async function storePhoto(
    size: TelegramPhotoSize,
    scope: { chatId: number; threadId?: number },
    deps: HandlerDeps,
): Promise<ImageRefPart | null> {
    const file = await deps.api.getFile(size.file_id);
    if (!file.ok || !file.result?.file_path) {
        return null;
    }

    const buffer = await deps.api.downloadFile(file.result.file_path);
    if (!buffer) {
        return null;
    }
    // file_size необязателен, поэтому фактический размер проверяем после скачивания.
    if (buffer.byteLength > deps.config.imageMaxBytes) {
        console.error(JSON.stringify({
            msg: 'photo over the limit after download',
            bytes: buffer.byteLength,
            limit: deps.config.imageMaxBytes,
        }));
        return null;
    }

    const key = imageKey(scope, size.file_unique_id);
    await deps.images.write(key, toBase64(buffer));
    return { type: 'image_ref', key, fileId: size.file_id, mime: 'image/jpeg' };
}

async function handleChat(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    await enqueue(message, deps, describeForward(message) + text);
}

/**
 * describeForward prefixes a forwarded message so the model knows its origin.
 * Без пометки модель принимает пересланный текст за слова пользователя.
 */
function describeForward(message: TelegramMessage): string {
    const origin = message.forward_origin;
    if (!origin) {
        return '';
    }
    const author = origin.sender_user?.first_name
        ?? origin.sender_user_name
        ?? origin.chat?.title
        ?? origin.author_signature;
    return author
        ? `[пересланное сообщение от ${author}]\n`
        : '[пересланное сообщение]\n';
}

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
async function enqueue(
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
async function runTurn(
    userMessage: StoredChatMessage,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const chatId = message.chat.id;
    const key: ConversationKey = { chatId, threadId: message.message_thread_id };
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
        chatId,
        threadId: message.message_thread_id,
        intervalMs: deps.config.streamIntervalMs,
    });
    await streamer.start();

    let answer: string;
    try {
        answer = await deps.provider.stream(conversation, {
            onDelta: accumulated => streamer.update(accumulated),
        });
    } catch (error) {
        console.error(JSON.stringify({
            msg: 'llm request failed',
            chat_id: chatId,
            error: error instanceof Error ? error.message : String(error),
        }));
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: message.message_thread_id,
            text: 'Не удалось получить ответ от модели. Попробуйте ещё раз.',
        });
        return;
    }

    await deliverAnswer(deps.api, answer, {
        chatId,
        threadId: message.message_thread_id,
        documentThreshold: deps.config.documentThreshold,
        useRichMessages: deps.config.useRichMessages,
    });

    await deps.history.save(key, [...stored, { role: 'assistant', content: answer }]);
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
