import type { Config } from '../config';
import type { HandlerDeps } from '../deps';
import type { ConversationKey } from '../storage/history';
import type { TelegramMessage } from '../telegram/types';
import { destinationOf, Replier } from '../telegram/reply';
import { BUILD_COMMIT, BUILD_VERSION } from '../version';

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

/**
 * CommandHandler runs one bot command.
 *
 * Обработчик получает готовый Replier: адрес ответа уже разобран, и команде
 * не нужно помнить про chat_id и топики.
 */
type CommandHandler = (context: CommandContext) => Promise<void>;

interface CommandContext {
    replier: Replier;
    message: TelegramMessage;
    deps: HandlerDeps;
    /** Ключ истории текущего разговора. */
    key: ConversationKey;
}

/**
 * COMMANDS maps a command to its handler.
 *
 * Таблица вместо switch: новая команда — одна запись здесь и одна строка
 * в BOT_COMMANDS, без правок в разборе. Забыть ветку становится негде.
 */
const COMMANDS: Record<string, CommandHandler> = {
    '/start': async ({ replier, deps, key }) => {
        await deps.history.clear(key);
        // /start у нового пользователя очищать нечего: приветствие
        // уместнее рапорта об очистке контекста.
        await replier.text(START_TEXT);
    },
    '/new': async ({ replier, deps, key }) => {
        await deps.history.clear(key);
        await replier.text('Контекст очищен. Начинаем новый диалог.');
    },
    '/delete': async ({ replier, message, deps, key }) => {
        await deleteConversation(replier, message, deps, key);
    },
    '/info': async ({ replier, deps }) => {
        await replier.text(buildInfoText(deps.config));
    },
    '/help': async ({ replier }) => {
        await replier.text(HELP_TEXT);
    },
};

/**
 * handleCommand dispatches a slash command to its handler.
 */
export async function handleCommand(
    text: string,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    // Telegram позволяет писать /cmd@botname — суффикс отбрасываем.
    const name = text.split(/\s+/)[0]?.split('@')[0] ?? '';
    const to = destinationOf(message);
    const context: CommandContext = {
        replier: new Replier(deps.api, to),
        message,
        deps,
        key: { chatId: to.chatId, threadId: to.threadId },
    };

    const handler = COMMANDS[name];
    if (!handler) {
        await context.replier.text(`Неизвестная команда. ${HELP_TEXT}`);
        return;
    }
    await handler(context);
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
async function deleteConversation(
    replier: Replier,
    message: TelegramMessage,
    deps: HandlerDeps,
    key: ConversationKey,
): Promise<void> {
    await deps.history.clear(key);

    const { chatId, threadId } = replier.address;

    // Вне топика удалять нечего — команда вырождается в очистку контекста.
    if (threadId === undefined) {
        await replier.text('Контекст очищен. Этот чат без топиков, поэтому удалять нечего.');
        return;
    }

    await replier.text('Контекст очищен, удаляю топик.');

    const result = await deps.api.deleteForumTopic(chatId, threadId);
    if (!result.ok) {
        // Топик остался, но контекст уже забыт — сообщаем, что осталось сделать руками.
        console.error(JSON.stringify({
            msg: 'deleteForumTopic failed',
            chat_id: chatId,
            message_thread_id: threadId,
            error_code: result.error_code,
            description: result.description,
        }));
        await replier.text('Контекст очищен, но удалить топик не удалось — удалите его вручную.');
    }
}
