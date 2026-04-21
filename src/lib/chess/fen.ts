import { Chess } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';

export const STARTPOS_FEN = INITIAL_FEN;

export function fenKeyFromFen(fen: string): string {
	const setup = parseFen(fen).unwrap();
	const chess = Chess.fromSetup(setup).unwrap();
	return makeFen(chess.toSetup(), { epd: true });
}

export function tryFenKey(fen: string): string | null {
	try {
		return fenKeyFromFen(fen);
	} catch {
		return null;
	}
}

export const STARTPOS_KEY = fenKeyFromFen(INITIAL_FEN);

export function colorToMove(fenKey: string): 'white' | 'black' {
	const parts = fenKey.split(' ');
	return parts[1] === 'w' ? 'white' : 'black';
}
