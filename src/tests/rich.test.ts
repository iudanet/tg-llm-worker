import { describe, expect, it } from 'vitest';
import { markdownToRichBlocks, parseInline } from '../telegram/rich';

describe('parseInline', () => {
    it('returns a bare string for plain text', () => {
        expect(parseInline('hello world')).toBe('hello world');
    });

    it('extracts inline code', () => {
        expect(parseInline('run `npm test` now')).toEqual([
            'run ',
            { type: 'code', text: 'npm test' },
            ' now',
        ]);
    });

    it('extracts bold and italic', () => {
        expect(parseInline('**bold** and *italic*')).toEqual([
            { type: 'bold', text: 'bold' },
            ' and ',
            { type: 'italic', text: 'italic' },
        ]);
    });

    it('does not wrap a single run in an array', () => {
        expect(parseInline('**only**')).toEqual({ type: 'bold', text: 'only' });
    });

    it('does not treat snake_case or a*b as formatting', () => {
        expect(parseInline('a*b and c*d')).toBe('a*b and c*d');
    });
});

describe('markdownToRichBlocks', () => {
    it('clamps deep headings to the three sizes Telegram supports', () => {
        const blocks = markdownToRichBlocks('##### Deep');
        expect(blocks[0]).toEqual({ type: 'heading', size: 3, text: 'Deep' });
    });

    it('converts a heading', () => {
        expect(markdownToRichBlocks('## Title')).toEqual([
            { type: 'heading', size: 2, text: 'Title' },
        ]);
    });

    it('converts a fenced code block with language', () => {
        const blocks = markdownToRichBlocks('```go\nfmt.Println()\n```');
        expect(blocks).toEqual([
            { type: 'pre', text: 'fmt.Println()', language: 'go' },
        ]);
    });

    it('handles an unterminated code fence', () => {
        const blocks = markdownToRichBlocks('```\nabc');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]!.type).toBe('pre');
    });

    it('converts unordered and ordered lists', () => {
        const unordered = markdownToRichBlocks('- one\n- two');
        expect(unordered[0]).toMatchObject({ type: 'list', is_ordered: false });
        expect((unordered[0] as any).items).toHaveLength(2);
        // Пункт списка содержит вложенные блоки, а не текст напрямую.
        expect((unordered[0] as any).items[0].blocks[0].type).toBe('paragraph');

        const ordered = markdownToRichBlocks('1. one\n2. two');
        expect(ordered[0]).toMatchObject({ type: 'list', is_ordered: true });
    });

    it('converts a block quotation', () => {
        expect(markdownToRichBlocks('> quoted')).toEqual([
            { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'quoted' }] },
        ]);
    });

    it('groups consecutive lines into one paragraph', () => {
        const blocks = markdownToRichBlocks('line one\nline two\n\nsecond');
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toEqual({
            type: 'paragraph',
            text: 'line one\nline two',
        });
    });

    it('parses a mixed document without losing blocks', () => {
        const md = '# H\n\ntext with `code`\n\n- a\n- b\n\n```js\nx\n```\n\n> q';
        const blocks = markdownToRichBlocks(md);
        expect(blocks.map(b => b.type)).toEqual([
            'heading',
            'paragraph',
            'list',
            'pre',
            'blockquote',
        ]);
    });

    it('returns no blocks for empty input', () => {
        expect(markdownToRichBlocks('')).toEqual([]);
    });

    it('never emits an object with a plain type (rejected by the API)', () => {
        const md = '# H\n\ntext `code` **bold**\n\n- item\n\n> quote';
        expect(JSON.stringify(markdownToRichBlocks(md))).not.toContain('"plain"');
    });
});
