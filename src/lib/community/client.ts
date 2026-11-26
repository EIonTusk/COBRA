/**
 * HTTP client for the community endpoints on the COBRA Worker.
 *
 * Uses the hosted COBRA DB Worker, or the user's own Worker when they sync to
 * it, with the same sign-in as sync: a Lichess token is exchanged at
 * `/auth/session` for a short-lived app JWT. Browsing needs no sign-in.
 *
 * Publishing never touches sync data: the only tree it sends is the one built
 * by `buildCommunityTree`.
 */
import { effectiveLichessToken } from '$lib/storage/settings';
import { communityWorkerUrl } from '$lib/sync/backend';
import type { AppSettings } from '$lib/types';
import type {
	CommunityMoveCount,
	CommunityTreeV1,
	PublicationDetail,
	PublicationSummary,
	PublishMeta
} from './types';

export class CommunityError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body: Record<string, unknown> = {}
	) {
		super(message);
	}
}

/** The Worker origin community requests go to, or null when none is configured. */
export function communityBaseUrl(settings: AppSettings | null | undefined): string | null {
	return communityWorkerUrl(settings?.sync);
}

/** The Lichess token used to sign in: the sync identity if connected, else the main one. */
export function communityLichessToken(settings: AppSettings | null | undefined): string {
	return settings?.syncIdentityToken?.accessToken || effectiveLichessToken(settings);
}

export interface ListQuery {
	q?: string;
	color?: 'white' | 'black' | '';
	sort?: 'popular' | 'new';
	cursor?: string | null;
}

export interface MeResponse {
	userId: string;
	username: string | null;
	isAdmin: boolean;
	publications: PublicationSummary[];
}

export interface AdminReportItem {
	publication: PublicationSummary;
	statusReason: string | null;
	openReports: number;
	reports: Array<{ reason: string; note: string; at: number }>;
}

export class CommunityClient {
	readonly #base: string;
	readonly #lichessToken: string;
	readonly #fetch: typeof fetch;
	#jwt: string | null = null;

	constructor(base: string, lichessToken: string, fetchImpl: typeof fetch = fetch) {
		this.#base = base;
		this.#lichessToken = lichessToken;
		this.#fetch = fetchImpl;
	}

	static fromSettings(
		settings: AppSettings | null | undefined,
		fetchImpl?: typeof fetch
	): CommunityClient | null {
		const base = communityBaseUrl(settings);
		if (!base) return null;
		return new CommunityClient(base, communityLichessToken(settings), fetchImpl);
	}

	get canSignIn(): boolean {
		return !!this.#lichessToken;
	}

	list(
		query: ListQuery = {}
	): Promise<{ publications: PublicationSummary[]; cursor: string | null }> {
		const p = new URLSearchParams();
		if (query.q?.trim()) p.set('q', query.q.trim());
		if (query.color) p.set('color', query.color);
		if (query.sort) p.set('sort', query.sort);
		if (query.cursor) p.set('cursor', query.cursor);
		return this.#json('GET', `/community/publications?${p}`);
	}

	get(id: string, version?: number): Promise<PublicationDetail> {
		const v = version ? `?version=${version}` : '';
		// Sign in when we can, so an owner can still open their hidden publication.
		return this.#json('GET', `/community/publications/${encodeURIComponent(id)}${v}`, undefined, {
			auth: this.canSignIn ? 'optional' : 'none'
		});
	}

	positionMoves(
		fenKey: string,
		color: 'white' | 'black'
	): Promise<{ moves: CommunityMoveCount[] }> {
		const p = new URLSearchParams({ fen: fenKey, color });
		return this.#json('GET', `/community/positions/moves?${p}`);
	}

	publish(
		meta: PublishMeta,
		tree: CommunityTreeV1
	): Promise<{ id: string; version: number; publication: PublicationSummary }> {
		return this.#json('POST', '/community/publications', { meta, tree }, { auth: 'required' });
	}

	update(
		id: string,
		meta: PublishMeta,
		tree?: CommunityTreeV1
	): Promise<{ id: string; version: number; publication: PublicationSummary }> {
		return this.#json(
			'PUT',
			`/community/publications/${encodeURIComponent(id)}`,
			tree ? { meta, tree } : { meta },
			{ auth: 'required' }
		);
	}

	unpublish(id: string): Promise<{ ok: true }> {
		return this.#json('DELETE', `/community/publications/${encodeURIComponent(id)}`, undefined, {
			auth: 'required'
		});
	}

	countImport(id: string): Promise<{ ok: true }> {
		return this.#json(
			'POST',
			`/community/publications/${encodeURIComponent(id)}/import`,
			undefined,
			{
				auth: this.canSignIn ? 'optional' : 'none'
			}
		);
	}

	report(
		id: string,
		reason: 'spam' | 'offensive' | 'other',
		note: string
	): Promise<{ ok: true; hidden: boolean }> {
		return this.#json(
			'POST',
			`/community/publications/${encodeURIComponent(id)}/report`,
			{ reason, note },
			{ auth: 'required' }
		);
	}

	me(): Promise<MeResponse> {
		return this.#json('GET', '/community/me', undefined, { auth: 'required' });
	}

	adminReports(): Promise<{ items: AdminReportItem[] }> {
		return this.#json('GET', '/community/admin/reports', undefined, { auth: 'required' });
	}

	adminSetStatus(
		id: string,
		status: 'active' | 'hidden' | 'removed',
		reason?: string
	): Promise<unknown> {
		return this.#json(
			'POST',
			`/community/admin/publications/${encodeURIComponent(id)}/status`,
			{ status, reason },
			{ auth: 'required' }
		);
	}

	async #signIn(): Promise<void> {
		if (this.#jwt) return;
		if (!this.#lichessToken)
			throw new CommunityError(401, 'Connect Lichess in Settings to do this.');
		const res = await this.#fetch(`${this.#base}/auth/session`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.#lichessToken}` }
		});
		if (!res.ok)
			throw new CommunityError(
				res.status,
				'Lichess sign-in was rejected. Reconnect Lichess in Settings.'
			);
		this.#jwt = ((await res.json()) as { token: string }).token;
	}

	async #json<T>(
		method: string,
		path: string,
		body?: unknown,
		opts: { auth?: 'none' | 'optional' | 'required' } = {}
	): Promise<T> {
		const auth = opts.auth ?? 'none';
		const send = async () => {
			const headers: Record<string, string> = {};
			if (body !== undefined) headers['Content-Type'] = 'application/json';
			if (auth !== 'none') {
				try {
					await this.#signIn();
				} catch (e) {
					if (auth === 'required') throw e;
				}
				if (this.#jwt) headers.Authorization = `Bearer ${this.#jwt}`;
			}
			return this.#fetch(`${this.#base}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
		};
		let res = await send();
		if (res.status === 401 && auth !== 'none' && this.#jwt) {
			// The app JWT expired: sign in again once.
			this.#jwt = null;
			res = await send();
		}
		const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			throw new CommunityError(
				res.status,
				typeof out.error === 'string' ? out.error : `HTTP ${res.status}`,
				out
			);
		}
		return out as T;
	}
}
