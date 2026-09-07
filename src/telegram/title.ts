/**
 * Лимит длины имени топика в Bot API — 128 символов; берём короче,
 * чтобы заголовок целиком читался в списке чатов.
 */
export const TOPIC_NAME_LIMIT = 60;

/**
 * topicNameFrom builds a topic title out of the user's first message.
 *
 * Клиент Telegram называет новый топик «Новый чат», поэтому осмысленное имя
 * ставит бот. Заголовок однострочный, поэтому переводы строк сворачиваются
 * в пробелы, а длинный текст режется по границе слова.
 * Возвращает null, если пригодного текста не осталось.
 */
export function topicNameFrom(text: string): string | null {
    // Команда в заголовке выглядит как мусор: «/new что дальше» → «что дальше».
    const normalized = text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\/\S*\s*/, '')
        .trim();

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
