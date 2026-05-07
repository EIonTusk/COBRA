import { describe, expect, it } from 'vitest';
import { parseImportPgnResponse } from './studies';

describe('parseImportPgnResponse', () => {
	it('parses the {chapters: [...]} JSON-object shape Lichess emits today', () => {
		const body = JSON.stringify({
			chapters: [{ id: 'aQz3R046', name: 'COBRA-SYNC:rep:3a6a05fb' }],
			error: null
		});
		const rows = parseImportPgnResponse(body);
		expect(rows).toEqual([{ id: 'aQz3R046', name: 'COBRA-SYNC:rep:3a6a05fb' }]);
	});

	it('parses a {chapter: {id}} JSON object', () => {
		const body = JSON.stringify({ chapter: { id: 'abc12345', name: 'Foo' } });
		expect(parseImportPgnResponse(body)).toEqual([{ id: 'abc12345', name: 'Foo' }]);
	});

	it('parses a bare {id} JSON object', () => {
		const body = JSON.stringify({ id: 'abc12345', name: 'Foo' });
		expect(parseImportPgnResponse(body)).toEqual([{ id: 'abc12345', name: 'Foo' }]);
	});

	it('parses NDJSON one row per line', () => {
		const body = ['{"id":"a1","name":"A"}', '{"id":"b2","name":"B"}', ''].join('\n');
		expect(parseImportPgnResponse(body)).toEqual([
			{ id: 'a1', name: 'A' },
			{ id: 'b2', name: 'B' }
		]);
	});

	it('throws when the JSON object carries a non-empty error and no chapters', () => {
		const body = JSON.stringify({ chapters: [], error: 'PGN was empty' });
		expect(() => parseImportPgnResponse(body)).toThrow(/PGN was empty/);
	});

	it('returns empty array on truly empty body (caller handles)', () => {
		expect(parseImportPgnResponse('')).toEqual([]);
		expect(parseImportPgnResponse('   ')).toEqual([]);
	});

	it('drops malformed lines but keeps good ones', () => {
		const body = ['not json', '{"id":"good","name":"OK"}', '{}'].join('\n');
		expect(parseImportPgnResponse(body)).toEqual([{ id: 'good', name: 'OK' }]);
	});

	it('omits name when not a string', () => {
		const body = JSON.stringify({ chapters: [{ id: 'x' }] });
		expect(parseImportPgnResponse(body)).toEqual([{ id: 'x', name: undefined }]);
	});
});
