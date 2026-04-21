import { base } from '$app/paths';

// UI sounds sourced from Lichess's standard sound set. Files live in
// static/sounds/ and are preloaded on first use so the first move doesn't
// hit a cold network fetch.

type Name = 'move' | 'capture' | 'correct' | 'incorrect';

const FILES: Record<Name, string> = {
	move: 'Move.mp3',
	capture: 'Capture.mp3',
	correct: 'NewChallenge.mp3',
	incorrect: 'Error.mp3'
};

const VOLUME: Record<Name, number> = {
	move: 0.7,
	capture: 0.8,
	correct: 0.7,
	incorrect: 0.8
};

let enabled = true;
let master = 1;
const cache = new Map<Name, HTMLAudioElement>();

function get(name: Name): HTMLAudioElement | null {
	if (typeof Audio === 'undefined') return null;
	let a = cache.get(name);
	if (!a) {
		a = new Audio(`${base}/sounds/${FILES[name]}`);
		a.preload = 'auto';
		a.volume = VOLUME[name];
		cache.set(name, a);
	}
	return a;
}

function play(name: Name) {
	if (!enabled) return;
	const a = get(name);
	if (!a) return;
	try {
		// Clone so overlapping calls don't cut each other off (e.g. rapid
		// refutation replay). The source is cached, so the clone is cheap.
		const node = a.cloneNode(true) as HTMLAudioElement;
		node.volume = Math.max(0, Math.min(1, VOLUME[name] * master));
		void node.play().catch(() => {});
	} catch {
		/* ignore */
	}
}

export function setSoundsEnabled(v: boolean) {
	enabled = v;
}

export function setSoundsVolume(v: number) {
	master = Math.max(0, Math.min(1, v));
}

export function applySoundSettings(s: { soundsEnabled?: boolean; soundsVolume?: number }) {
	setSoundsEnabled(s.soundsEnabled ?? true);
	setSoundsVolume(s.soundsVolume ?? 1);
}

export function playMove() {
	play('move');
}
export function playCapture() {
	play('capture');
}
export function playCorrect() {
	play('correct');
}
export function playIncorrect() {
	play('incorrect');
}
