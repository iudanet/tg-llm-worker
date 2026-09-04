/**
 * Rich Messages (Bot API 10.1-10.3).
 *
 * Блочный формат избавляет от экранирования MarkdownV2: структура передаётся
 * явно, а не парсится Telegram из текста. Здесь описано только то подмножество
 * блоков, которое реально порождает ответ LLM.
 */

export interface RichTextStyled {
    type: 'bold' | 'italic' | 'code';
    text: RichText;
}

/**
 * RichText is either a plain string, a styled run, or a sequence of those.
 * Простой текст передаётся именно строкой: варианта type: 'plain' в API нет,
 * и объект с ним отвергается как "Unsupported rich text type".
 */
export type RichText = string | RichTextStyled | RichText[];

export interface InputRichBlockParagraph {
    type: 'paragraph';
    text: RichText;
}

/** Заголовок: size 1-3, где 1 — самый крупный. */
export interface InputRichBlockHeading {
    type: 'heading';
    size: 1 | 2 | 3;
    text: RichText;
}

export interface InputRichBlockPre {
    type: 'pre';
    text: RichText;
    language?: string;
}

/** Пункт списка и цитата содержат вложенные блоки, а не текст. */
export interface InputRichBlockListItem {
    blocks: InputRichBlock[];
}

export interface InputRichBlockList {
    type: 'list';
    items: InputRichBlockListItem[];
    is_ordered?: boolean;
}

export interface InputRichBlockBlockquote {
    type: 'blockquote';
    blocks: InputRichBlock[];
}

export type InputRichBlock =
    | InputRichBlockParagraph
    | InputRichBlockHeading
    | InputRichBlockPre
    | InputRichBlockList
    | InputRichBlockBlockquote;

export interface InputRichMessage {
    blocks: InputRichBlock[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```(\w*)\s*$/;

/**
 * markdownToRichBlocks converts an LLM markdown answer into rich blocks.
 * Разбор намеренно минимальный: покрываем то, что модели реально генерируют,
 * а незнакомую разметку оставляем обычным текстом, а не роняем сообщение.
 */
export function markdownToRichBlocks(markdown: string): InputRichBlock[] {
    const blocks: InputRichBlock[] = [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');

    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? '';

        if (line.trim() === '') {
            index += 1;
            continue;
        }

        const fence = FENCE_RE.exec(line.trim());
        if (fence) {
            const language = fence[1] ?? '';
            const body: string[] = [];
            index += 1;
            while (index < lines.length && !FENCE_RE.test((lines[index] ?? '').trim())) {
                body.push(lines[index] ?? '');
                index += 1;
            }
            // Закрывающий фенс может отсутствовать, если ответ оборвался.
            index += 1;
            blocks.push({
                type: 'pre',
                text: body.join('\n'),
                ...(language ? { language } : {}),
            });
            continue;
        }

        const heading = HEADING_RE.exec(line);
        if (heading) {
            // Markdown знает 6 уровней, Telegram — три.
            const level = Math.min((heading[1] ?? '#').length, 3) as 1 | 2 | 3;
            blocks.push({
                type: 'heading',
                size: level,
                text: parseInline(heading[2] ?? ''),
            });
            index += 1;
            continue;
        }

        if (QUOTE_RE.test(line)) {
            const body: string[] = [];
            while (index < lines.length && QUOTE_RE.test(lines[index] ?? '')) {
                body.push(QUOTE_RE.exec(lines[index] ?? '')?.[1] ?? '');
                index += 1;
            }
            blocks.push({
                type: 'blockquote',
                blocks: [{ type: 'paragraph', text: parseInline(body.join('\n')) }],
            });
            continue;
        }

        if (UNORDERED_RE.test(line) || ORDERED_RE.test(line)) {
            const isOrdered = ORDERED_RE.test(line);
            const items: InputRichBlockListItem[] = [];
            while (index < lines.length) {
                const current = lines[index] ?? '';
                const match = isOrdered ? ORDERED_RE.exec(current) : UNORDERED_RE.exec(current);
                if (!match) {
                    break;
                }
                items.push({ blocks: [{ type: 'paragraph', text: parseInline(match[1] ?? '') }] });
                index += 1;
            }
            blocks.push({ type: 'list', items, is_ordered: isOrdered });
            continue;
        }

        const paragraph: string[] = [];
        while (index < lines.length) {
            const current = lines[index] ?? '';
            if (
                current.trim() === ''
                || HEADING_RE.test(current)
                || QUOTE_RE.test(current)
                || UNORDERED_RE.test(current)
                || ORDERED_RE.test(current)
                || FENCE_RE.test(current.trim())
            ) {
                break;
            }
            paragraph.push(current);
            index += 1;
        }
        blocks.push({ type: 'paragraph', text: parseInline(paragraph.join('\n')) });
    }

    return blocks;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|(?<![*\w])\*[^*]+\*(?!\w))/g;

/**
 * parseInline splits a line into styled rich-text runs.
 */
export function parseInline(text: string): RichText {
    if (text === '') {
        return '';
    }

    const runs: RichText[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(INLINE_RE)) {
        const token = match[0];
        const start = match.index ?? 0;
        if (start > lastIndex) {
            runs.push(text.slice(lastIndex, start));
        }
        if (token.startsWith('`')) {
            runs.push({ type: 'code', text: token.slice(1, -1) });
        } else if (token.startsWith('**')) {
            runs.push({ type: 'bold', text: token.slice(2, -2) });
        } else {
            runs.push({ type: 'italic', text: token.slice(1, -1) });
        }
        lastIndex = start + token.length;
    }

    if (lastIndex < text.length) {
        runs.push(text.slice(lastIndex));
    }
    if (runs.length === 0) {
        return text;
    }
    // Одиночный фрагмент не нужно оборачивать в массив.
    return runs.length === 1 ? runs[0]! : runs;
}
