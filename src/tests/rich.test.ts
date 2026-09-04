import { describe, expect, it } from 'vitest';
import { markdownToRichBlocks, parseInline } from '../telegram/rich';

describe('parseInline', () => {
    it('keeps plain text as a single run', () => {
        expect(parseInline('hello world')).toEqual([{ type: 'plain', text: 'hello world' }]);
    });

    it('extracts inline code', () => {
        expect(parseInline('run `npm test` now')).toEqual([
            { type: 'plain', text: 'run ' },
            { type: 'code', text: 'npm test' },
            { type: 'plain', text: ' now' },
        ]);
    });

    it('extracts bold and italic', () => {
        expect(parseInline('**bold** and *italic*')).toEqual([
            { type: 'bold', text: 'bold' },
            { type: 'plain', text: ' and ' },
            { type: 'italic', text: 'italic' },
        ]);
    });

    it('does not treat snake_case or a*b as formatting', () => {
        expect(parseInline('a*b and c*d')).toEqual([{ type: 'plain', text: 'a*b and c*d' }]);
    });
});

describe('markdownToRichBlocks', () => {
    it('converts a heading', () => {
        expect(markdownToRichBlocks('## Title')).toEqual([
            { type: 'section_heading', text: [{ type: 'plain', text: 'Title' }] },
        ]);
    });

    it('converts a fenced code block with language', () => {
        const blocks = markdownToRichBlocks('```go\nfmt.Println()\n```');
        expect(blocks).toEqual([
            {
                type: 'preformatted',
                text: [{ type: 'plain', text: 'fmt.Println()' }],
                language: 'go',
            },
        ]);
    });

    it('handles an unterminated code fence', () => {
        const blocks = markdownToRichBlocks('```\nabc');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]!.type).toBe('preformatted');
    });

    it('converts unordered and ordered lists', () => {
        const unordered = markdownToRichBlocks('- one\n- two');
        expect(unordered[0]).toMatchObject({ type: 'list', is_ordered: false });
        expect((unordered[0] as any).items).toHaveLength(2);

        const ordered = markdownToRichBlocks('1. one\n2. two');
        expect(ordered[0]).toMatchObject({ type: 'list', is_ordered: true });
    });

    it('converts a block quotation', () => {
        expect(markdownToRichBlocks('> quoted')).toEqual([
            { type: 'block_quotation', text: [{ type: 'plain', text: 'quoted' }] },
        ]);
    });

    it('groups consecutive lines into one paragraph', () => {
        const blocks = markdownToRichBlocks('line one\nline two\n\nsecond');
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toEqual({
            type: 'paragraph',
            text: [{ type: 'plain', text: 'line one\nline two' }],
        });
    });

    it('parses a mixed document without losing blocks', () => {
        const md = '# H\n\ntext with `code`\n\n- a\n- b\n\n```js\nx\n```\n\n> q';
        const blocks = markdownToRichBlocks(md);
        expect(blocks.map(b => b.type)).toEqual([
            'section_heading',
            'paragraph',
            'list',
            'preformatted',
            'block_quotation',
        ]);
    });

    it('returns no blocks for empty input', () => {
        expect(markdownToRichBlocks('')).toEqual([]);
    });
});
