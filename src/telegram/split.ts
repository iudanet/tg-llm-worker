export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * splitMessage cuts a long answer into Telegram-sized chunks.
 *
 * В отличие от нарезки строго по лимиту, режем по убыванию приоритета границ:
 * абзац -> строка -> предложение -> пробел. Это не даёт разорвать слово
 * или строку кода посередине. Жёсткий разрез применяется только к куску,
 * внутри которого ни одной границы нет.
 */
export function splitMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
    if (limit <= 0) {
        throw new Error('limit must be positive');
    }
    if (text.length === 0) {
        return [];
    }

    const chunks: string[] = [];
    let rest = text;

    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = findBoundary(window);
        const head = rest.slice(0, cut).trimEnd();
        if (head.length > 0) {
            chunks.push(head);
        }
        rest = rest.slice(cut).replace(/^\n+/, '');
    }

    const tail = rest.trimEnd();
    if (tail.length > 0) {
        chunks.push(tail);
    }
    return chunks;
}

/**
 * findBoundary returns the offset to cut at, preferring the most natural break.
 */
function findBoundary(window: string): number {
    const candidates = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' '),
    ];
    for (const index of candidates) {
        // Слишком ранняя граница режет текст на неоправданно мелкие куски.
        if (index > window.length * 0.5) {
            return index;
        }
    }
    return window.length;
}
