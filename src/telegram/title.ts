/**
 * Лимит длины имени топика в Bot API — 128 символов; берём короче,
 * чтобы заголовок целиком читался в списке чатов.
 */
export const TOPIC_NAME_LIMIT = 60;

/**
 * Предел разбираемого текста. Telegram допускает 4096 символов в сообщении,
 * но склейка серии даёт больше, а разбор идёт регулярками по данным
 * пользователя — на CPU-лимите бесплатного плана (10 мс) это важно.
 */
const MAX_SOURCE_LENGTH = 4096;

/**
 * topicNameFrom builds a topic title out of the user's first message.
 *
 * Клиент Telegram называет новый топик «Новый чат», поэтому осмысленное имя
 * ставит бот. Заголовок однострочный, поэтому переводы строк сворачиваются
 * в пробелы, а длинный текст режется по границе слова.
 * Возвращает null, если пригодного текста не осталось.
 */
export function topicNameFrom(text: string): string | null {
    // Текст ограничиваем до разбора: дальше идут регулярки, а вход
    // приходит от пользователя. Лимит с запасом — имя всё равно короче.
    const source = text.slice(0, MAX_SOURCE_LENGTH);

    // Пробелы сворачиваются первой заменой, поэтому второй регулярке
    // остаётся только команда: без \s* в конце она линейна по вводу
    // (CodeQL js/polynomial-redos на прежнем /^\/\S*\s*/).
    const collapsed = source.replace(/\s+/g, ' ').trim();
    const normalized = collapsed.replace(/^\/\S*/, '').trim();

    if (normalized === '') {
        return null;
    }
    if (normalized.length <= TOPIC_NAME_LIMIT) {
        return normalized;
    }

    // Оставляем место под многоточие, обозначающее обрезку.
    const window = normalized.slice(0, TOPIC_NAME_LIMIT - 1);
    const lastSpace = window.lastIndexOf(' ');
    // Слишком ранняя граница оставила бы огрызок вместо заголовка.
    const cut = lastSpace > TOPIC_NAME_LIMIT * 0.5 ? lastSpace : window.length;
    return `${window.slice(0, cut).trimEnd()}…`;
}
