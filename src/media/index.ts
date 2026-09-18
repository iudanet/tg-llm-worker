import type { HandlerDeps } from '../deps';
import type { ImageRefPart } from '../llm/provider';
import type {
    TelegramMessage,
    TelegramPhotoSize,
    TelegramVoice,
} from '../telegram/types';
import { destinationOf, Replier } from '../telegram/reply';
import { enqueue } from '../conversation/turn';
import { audioFileName, transcribe, TranscribeError } from '../audio/transcribe';
import { imageKey, pickPhotoSize, toBase64 } from '../vision/store';

/**
 * handlePhoto stores the image and asks the model about it.
 *
 * Картинка не кладётся в блоб истории: она уходит в свой KV-ключ, а в
 * истории остаётся ссылка. Иначе каждое последующее сообщение читало и
 * писало бы мегабайты base64.
 */
export async function handlePhoto(
    photo: TelegramPhotoSize[],
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const to = destinationOf(message);
    const replier = new Replier(deps.api, to);

    if (!deps.config.visionEnabled) {
        await replier.text('Обработка картинок отключена в настройках бота.');
        return;
    }

    const limitMb = (deps.config.imageMaxBytes / (1024 * 1024)).toFixed(1);
    const size = pickPhotoSize(photo, deps.config.imageMaxBytes);
    if (!size) {
        await replier.text(`Картинка слишком большая — лимит ${limitMb} МБ.`);
        return;
    }

    const stored = await storePhoto(size, to, deps);
    if (!stored) {
        await replier.text('Не удалось загрузить картинку из Telegram. Попробуйте ещё раз.');
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
export async function handleVoice(
    voice: TelegramVoice,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const to = destinationOf(message);
    const replier = new Replier(deps.api, to);

    if (!deps.config.transcribeEnabled) {
        await replier.text('Распознавание голоса отключено в настройках бота.');
        return;
    }
    if (!deps.config.apiKey) {
        await replier.text('Распознавание недоступно: не настроен ключ API.');
        return;
    }

    // Размер известен заранее — большой файл отклоняем без скачивания.
    if (voice.file_size !== undefined && voice.file_size > deps.config.audioMaxBytes) {
        await replier.text('Запись слишком большая для распознавания.');
        return;
    }

    const file = await deps.api.getFile(voice.file_id);
    if (!file.ok || !file.result?.file_path) {
        await replier.text('Не удалось получить запись из Telegram. Попробуйте ещё раз.');
        return;
    }

    const audio = await deps.api.downloadFile(file.result.file_path);
    if (!audio) {
        await replier.text('Не удалось скачать запись. Попробуйте ещё раз.');
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
            chat_id: to.chatId,
            mime: voice.mime_type,
            duration: voice.duration,
            error: detail,
        }));
        await replier.text(error instanceof TranscribeError
                ? error.userMessage
                : 'Не удалось распознать запись. Попробуйте ещё раз.');
        return;
    }

    // Показываем расшифровку до ответа: видно, что именно бот расслышал.
    await replier.text(`🎙 ${text}`);

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
