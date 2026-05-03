<script lang="ts">
	import type { DossierExhibits } from '$lib/dossier/buildExhibits';
	import type { InsightCard } from '$lib/dossier/deepInsights';
	import { barWidth, pctFmt, signedPctFmt } from '$lib/dossier/format';
	import { structureLabel } from '$lib/dossier/structureTaste';
	import { endgameFamilyLabel } from '$lib/dossier/endgameSubtypes';
	import { motifLabel } from '$lib/dossier/tacticalMotifs';
	import { difficultyLabel } from '$lib/dossier/defensiveResource';
	import { dayLabel } from '$lib/dossier/timeOfDay';
	import { offenderHeading } from '$lib/dossier/repeatOffenders';
	import { AXIS_LABEL as LEVELUP_AXIS_LABEL } from '$lib/dossier/levelUp';

	interface Props {
		exhibits: DossierExhibits;
		card: InsightCard;
		slug: string;
		/** True when the scan included a Stockfish pass — gates the
		 *  "Requires engine analysis" message inside repeat-offenders. */
		hasEvalData: boolean;
	}

	let { exhibits, card, slug, hasEvalData }: Props = $props();

	function hourHeat(winRate: number): string {
		if (winRate >= 0.6) return 'bg-emerald-500/70';
		if (winRate >= 0.5) return 'bg-emerald-500/45';
		if (winRate >= 0.4) return 'bg-[var(--color-parchment-400)]/40';
		if (winRate >= 0.3) return 'bg-amber-500/45';
		return 'bg-amber-500/70';
	}
</script>

{#if slug === 'piece-affinity'}
	{@const pa = exhibits.pieceAffinity}
	{@const m = Math.max(
		pa.trades.bishopForKnight,
		pa.trades.knightForBishop,
		pa.trades.bishopForBishop,
		pa.trades.knightForKnight,
		1
	)}
	<div class="grid gap-1.5">
		<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
			<span class="font-mono">B × N</span>
			<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
				<div
					class="h-full rounded bg-[var(--color-brass-300)]/70"
					style:width={barWidth(pa.trades.bishopForKnight, m)}
				></div>
			</div>
			<span class="text-right font-mono">{pa.trades.bishopForKnight}</span>
		</div>
		<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
			<span class="font-mono">N × B</span>
			<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
				<div
					class="h-full rounded bg-[var(--color-brass-300)]/70"
					style:width={barWidth(pa.trades.knightForBishop, m)}
				></div>
			</div>
			<span class="text-right font-mono">{pa.trades.knightForBishop}</span>
		</div>
		<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
			<span class="font-mono">B × B</span>
			<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
				<div
					class="h-full rounded bg-[var(--color-brass-300)]/70"
					style:width={barWidth(pa.trades.bishopForBishop, m)}
				></div>
			</div>
			<span class="text-right font-mono">{pa.trades.bishopForBishop}</span>
		</div>
		<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
			<span class="font-mono">N × N</span>
			<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
				<div
					class="h-full rounded bg-[var(--color-brass-300)]/70"
					style:width={barWidth(pa.trades.knightForKnight, m)}
				></div>
			</div>
			<span class="text-right font-mono">{pa.trades.knightForKnight}</span>
		</div>
	</div>
	<div class="mt-3 grid grid-cols-3 gap-2 text-[10px]">
		<div>
			<div class="text-[var(--color-parchment-500)]">Capturing while ahead</div>
			<div class="font-mono text-emerald-300">{pctFmt(pa.capturesWhileAhead, 0)}</div>
		</div>
		<div>
			<div class="text-[var(--color-parchment-500)]">While equal</div>
			<div class="font-mono">{pctFmt(pa.capturesWhileEqual, 0)}</div>
		</div>
		<div>
			<div class="text-[var(--color-parchment-500)]">While behind</div>
			<div class="font-mono text-amber-300">{pctFmt(pa.capturesWhileBehind, 0)}</div>
		</div>
	</div>
{:else if slug === 'structure-taste'}
	{@const st = exhibits.structureTaste}
	{@const maxGames = Math.max(...st.byStructure.map((b) => b.games), 1)}
	<div class="grid gap-1">
		{#each st.byStructure.slice(0, 6) as b (b.key)}
			<div
				class="grid grid-cols-[minmax(0,7rem)_1fr_2.5rem_3rem] items-center gap-2 sm:grid-cols-[10rem_1fr_3.5rem_4rem]"
			>
				<span class="truncate">{structureLabel(b.key)}</span>
				<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
					<div
						class="h-full rounded bg-[var(--color-brass-300)]/70"
						style:width={barWidth(b.games, maxGames)}
					></div>
				</div>
				<span class="text-right font-mono">{b.games}g</span>
				<span
					class="text-right font-mono {b.winRate - st.overallWinRate > 0.05
						? 'text-emerald-300'
						: b.winRate - st.overallWinRate < -0.05
							? 'text-amber-300'
							: ''}"
				>
					{signedPctFmt(b.winRate - st.overallWinRate, 0)}
				</span>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Your overall win rate: {pctFmt(st.overallWinRate)} · avg open files {st.openFileAverage.toFixed(
			2
		)}.
	</div>
{:else if slug === 'exchange-propensity'}
	{@const ep = exhibits.exchangePropensity}
	{@const maxRate = Math.max(
		ep.byState.ahead.pieceTradeRate,
		ep.byState.equal.pieceTradeRate,
		ep.byState.behind.pieceTradeRate,
		0.01
	)}
	<div class="grid grid-cols-3 gap-3">
		{#each ['ahead', 'equal', 'behind'] as const as state (state)}
			{@const b = ep.byState[state]}
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
				<div class="text-[10px] text-[var(--color-parchment-500)] capitalize">{state}</div>
				<div class="mt-1 font-mono">{pctFmt(b.pieceTradeRate)}</div>
				<div class="mt-1.5 h-1 rounded bg-[var(--color-ink-950)]">
					<div
						class="h-full rounded bg-[var(--color-brass-300)]/70"
						style:width={barWidth(b.pieceTradeRate, maxRate)}
					></div>
				</div>
				<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
					{b.moves.toLocaleString()} moves
				</div>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Simplify-when-ahead Δ {signedPctFmt(ep.simplifyWhenAheadDelta, 1)} · cling-when-behind Δ {signedPctFmt(
			ep.clingWhenBehindDelta,
			1
		)}
	</div>
{:else if slug === 'plan-taste'}
	{@const pl = exhibits.planTaste}
	{@const pieceTotal = pl.pieceAim.queenside + pl.pieceAim.center + pl.pieceAim.kingside || 1}
	{@const stormTotal = pl.pawnStorms.queenside + pl.pawnStorms.center + pl.pawnStorms.kingside || 1}
	<div class="space-y-3">
		<div>
			<div class="mb-1 flex justify-between text-[10px] text-[var(--color-parchment-500)]">
				<span>Piece destinations</span>
				<span>{pieceTotal.toLocaleString()} moves</span>
			</div>
			<div class="flex h-2 overflow-hidden rounded">
				<div
					class="bg-emerald-500/60"
					style:width="{((pl.pieceAim.queenside / pieceTotal) * 100).toFixed(1)}%"
				></div>
				<div
					class="bg-[var(--color-parchment-400)]/50"
					style:width="{((pl.pieceAim.center / pieceTotal) * 100).toFixed(1)}%"
				></div>
				<div
					class="bg-[var(--color-brass-300)]/70"
					style:width="{((pl.pieceAim.kingside / pieceTotal) * 100).toFixed(1)}%"
				></div>
			</div>
			<div
				class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-400)]"
			>
				<span>Q {pctFmt(pl.pieceAim.queenside / pieceTotal, 0)}</span>
				<span>C {pctFmt(pl.pieceAim.center / pieceTotal, 0)}</span>
				<span>K {pctFmt(pl.pieceAim.kingside / pieceTotal, 0)}</span>
			</div>
		</div>
		<div>
			<div class="mb-1 flex justify-between text-[10px] text-[var(--color-parchment-500)]">
				<span>Pawn storms (past 3rd rank)</span>
				<span>{stormTotal.toLocaleString()} pushes</span>
			</div>
			<div class="flex h-2 overflow-hidden rounded">
				<div
					class="bg-emerald-500/60"
					style:width="{((pl.pawnStorms.queenside / stormTotal) * 100).toFixed(1)}%"
				></div>
				<div
					class="bg-[var(--color-parchment-400)]/50"
					style:width="{((pl.pawnStorms.center / stormTotal) * 100).toFixed(1)}%"
				></div>
				<div
					class="bg-[var(--color-brass-300)]/70"
					style:width="{((pl.pawnStorms.kingside / stormTotal) * 100).toFixed(1)}%"
				></div>
			</div>
			<div
				class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-400)]"
			>
				<span>Q {pctFmt(pl.pawnStorms.queenside / stormTotal, 0)}</span>
				<span>C {pctFmt(pl.pawnStorms.center / stormTotal, 0)}</span>
				<span>K {pctFmt(pl.pawnStorms.kingside / stormTotal, 0)}</span>
			</div>
		</div>
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Kingside storms in {pl.kingsideStormGames}/{pl.totalGames} games · queenside in
		{pl.minorityAttackGames}/{pl.totalGames} · avg {pl.avgPawnPushes.toFixed(2)} pushes/game.
	</div>
{:else if slug === 'opening-fit'}
	{@const of = exhibits.openingFit}
	{@const whiteRows = of.rows.filter((r) => r.color === 'white').slice(0, 6)}
	{@const blackRows = of.rows.filter((r) => r.color === 'black').slice(0, 6)}
	<div class="grid gap-3">
		{#each [{ side: 'white', label: 'As White', rows: whiteRows }, { side: 'black', label: 'As Black', rows: blackRows }] as group (group.side)}
			<div>
				<div class="mb-1 text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
					{group.label} ({group.rows.length})
				</div>
				{#if group.rows.length === 0}
					<div class="text-[10px] text-[var(--color-parchment-500)]">
						No family with ≥5 games on this side yet.
					</div>
				{:else}
					<table class="w-full border-collapse font-mono text-[11px]">
						<thead class="text-[var(--color-parchment-500)]">
							<tr>
								<th class="pb-1 text-left font-normal">Family</th>
								<th class="pb-1 text-right font-normal">Games</th>
								<th class="pb-1 text-right font-normal">Win %</th>
								<th class="pb-1 text-right font-normal">Δ win</th>
								<th class="pb-1 text-right font-normal">Δ CP</th>
								<th class="pb-1 text-right font-normal">Verdict</th>
							</tr>
						</thead>
						<tbody class="text-[var(--color-parchment-100)]">
							{#each group.rows as r (`${r.color}|${r.opening}`)}
								<tr class="border-t border-[var(--color-ink-800)]">
									<td class="py-1 pr-2 text-[var(--color-parchment-200)]">
										{r.opening}
										{#if r.role === 'played'}
											<span class="ml-1 text-[10px] text-[var(--color-parchment-500)]">
												(played)
											</span>
										{:else if r.role === 'faced'}
											<span class="ml-1 text-[10px] text-[var(--color-parchment-500)]">
												(faced)
											</span>
										{/if}
									</td>
									<td class="py-1 text-right">{r.games}</td>
									<td class="py-1 text-right">{pctFmt(r.winRate, 0)}</td>
									<td
										class="py-1 text-right {r.winRateDelta > 0.03
											? 'text-emerald-300'
											: r.winRateDelta < -0.03
												? 'text-amber-300'
												: ''}"
									>
										{signedPctFmt(r.winRateDelta, 0)}
									</td>
									<td
										class="py-1 text-right {r.cpLossDelta != null && r.cpLossDelta > 5
											? 'text-amber-300'
											: r.cpLossDelta != null && r.cpLossDelta < -5
												? 'text-emerald-300'
												: ''}"
									>
										{r.cpLossDelta != null
											? `${r.cpLossDelta >= 0 ? '+' : ''}${r.cpLossDelta.toFixed(0)}`
											: '—'}
									</td>
									<td class="py-1 text-right text-[10px]">
										<span
											class="rounded border px-1 py-0.5 {r.verdict === 'strong'
												? 'border-emerald-500/50 text-emerald-300'
												: r.verdict === 'weak'
													? 'border-amber-300/50 text-amber-300'
													: 'border-[var(--color-ink-700)] text-[var(--color-parchment-500)]'}"
										>
											{r.verdict}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Baseline: overall win {pctFmt(of.userWinRate, 0)} · overall CP loss {of.userAvgCpLoss != null
			? of.userAvgCpLoss.toFixed(1)
			: '—'}. Rows are split by family × side; QGA, QGD and Slav each get their own row.
	</div>
{:else if slug === 'endgame-subtypes'}
	{@const eg = exhibits.endgameSubtypes}
	<div class="grid grid-cols-3 gap-2 text-[10px]">
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Reached</div>
			<div class="mt-0.5 font-mono text-base">{eg.totalWithEndgame}</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Conv. rate</div>
			<div class="mt-0.5 font-mono text-base text-emerald-300">
				{pctFmt(eg.overallConversionRate, 0)}
			</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Def. rate</div>
			<div class="mt-0.5 font-mono text-base">{pctFmt(eg.overallDefenseRate, 0)}</div>
		</div>
	</div>
	{#if eg.buckets.length > 0}
		<table class="mt-3 w-full border-collapse font-mono text-[11px]">
			<thead class="text-[var(--color-parchment-500)]">
				<tr>
					<th class="pb-1 text-left font-normal">Family</th>
					<th class="pb-1 text-right font-normal">Games</th>
					<th class="pb-1 text-right font-normal">W/D/L</th>
					<th class="pb-1 text-right font-normal">Conv</th>
					<th class="pb-1 text-right font-normal">Def</th>
				</tr>
			</thead>
			<tbody class="text-[var(--color-parchment-100)]">
				{#each eg.buckets.slice(0, 5) as b (b.family)}
					<tr class="border-t border-[var(--color-ink-800)]">
						<td class="py-1 pr-2 text-[var(--color-parchment-200)]"
							>{endgameFamilyLabel(b.family)}</td
						>
						<td class="py-1 text-right">{b.games}</td>
						<td class="py-1 text-right">{b.wins}/{b.draws}/{b.losses}</td>
						<td class="py-1 text-right">{b.enteredAhead > 0 ? pctFmt(b.conversionRate, 0) : '—'}</td
						>
						<td class="py-1 text-right">{b.enteredBehind > 0 ? pctFmt(b.defenseRate, 0) : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
{:else if slug === 'tactical-motifs'}
	{@const tm = exhibits.tacticalMotifs}
	{@const maxCount = Math.max(
		...tm.byMotif.filter((x) => x.motif !== 'unclassified').map((x) => x.count),
		1
	)}
	{#if tm.total === 0}
		<p class="text-[var(--color-parchment-500)]">
			No categorised blunders — run an engine-analysed scan.
		</p>
	{:else}
		<div class="grid gap-1">
			{#each tm.byMotif.filter((x) => x.motif !== 'unclassified').slice(0, 6) as mi (mi.motif)}
				<div
					class="grid grid-cols-[minmax(0,6rem)_1fr_2.5rem_3rem] items-center gap-2 sm:grid-cols-[8rem_1fr_3rem_4rem]"
				>
					<span class="truncate">{motifLabel(mi.motif)}</span>
					<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
						<div
							class="h-full rounded bg-amber-500/60"
							style:width={barWidth(mi.count, maxCount)}
						></div>
					</div>
					<span class="text-right font-mono">{mi.count}</span>
					<span class="text-right font-mono text-[var(--color-parchment-500)]"
						>{mi.avgCpLoss.toFixed(0)}cp</span
					>
				</div>
			{/each}
		</div>
		<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
			{tm.total} blunder/mistake moves analysed. Moves may match multiple motifs.
		</div>
	{/if}
{:else if slug === 'calculation-depth'}
	{@const cd = exhibits.calculationDepth}
	{@const maxCp = Math.max(...cd.byBranching.map((b) => b.avgCpLoss || 0), 1)}
	<div class="grid grid-cols-4 gap-2">
		{#each cd.byBranching as b (b.label)}
			<div class="flex flex-col items-center">
				<div class="mb-1 flex h-20 w-full items-end rounded bg-[var(--color-ink-900)]">
					<div
						class="w-full rounded-b bg-[var(--color-brass-300)]/70"
						style:height="{Math.min(100, ((b.avgCpLoss || 0) / maxCp) * 100).toFixed(1)}%"
					></div>
				</div>
				<div class="text-center text-[10px]">
					<div class="font-mono">{b.avgCpLoss > 0 ? b.avgCpLoss.toFixed(0) : '—'}</div>
					<div class="text-[var(--color-parchment-500)]">{b.label.replace(' moves', '')}</div>
					<div class="text-[var(--color-parchment-500)]">{b.moves}</div>
				</div>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Avg CP loss per branching bucket. Higher bars at right = accuracy drops under branching
		pressure.
	</div>
{:else if slug === 'defensive-resource'}
	{@const dr = exhibits.defensiveResource}
	<div class="grid grid-cols-3 gap-2">
		{#each dr.byDifficulty as b (b.bucket)}
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
				<div class="text-[10px] text-[var(--color-parchment-500)]">{difficultyLabel(b.bucket)}</div>
				<div class="mt-1 font-mono text-base">{b.games > 0 ? pctFmt(b.defenseRate, 0) : '—'}</div>
				<div class="mt-1 flex h-1 overflow-hidden rounded">
					<div
						class="bg-emerald-500/70"
						style:width={b.games > 0 ? `${((b.flipped / b.games) * 100).toFixed(1)}%` : '0%'}
					></div>
					<div
						class="bg-[var(--color-parchment-400)]/60"
						style:width={b.games > 0 ? `${((b.held / b.games) * 100).toFixed(1)}%` : '0%'}
					></div>
					<div
						class="bg-amber-500/60"
						style:width={b.games > 0 ? `${((b.lost / b.games) * 100).toFixed(1)}%` : '0%'}
					></div>
				</div>
				<div class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
					{b.flipped}W · {b.held}D · {b.lost}L
				</div>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Overall: {pctFmt(dr.overallDefenseRate, 0)} held or flipped across {dr.totalLosingEntries} losing
		entries · avg {dr.avgLegalMovesAtEntry.toFixed(1)} legal moves at entry.
	</div>
{:else if slug === 'prophylaxis'}
	{@const pr = exhibits.prophylaxis}
	<div class="grid grid-cols-3 gap-2 text-[10px]">
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Threats faced</div>
			<div class="mt-0.5 font-mono text-base">{pr.opportunities}</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Neutralised</div>
			<div class="mt-0.5 font-mono text-base text-emerald-300">{pr.neutralized}</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
			<div class="text-[var(--color-parchment-500)]">Compounded</div>
			<div class="mt-0.5 font-mono text-base text-amber-300">{pr.compounded}</div>
		</div>
	</div>
	{#if pr.opportunities > 0}
		<div class="mt-3 flex h-2 overflow-hidden rounded">
			<div
				class="bg-emerald-500/70"
				style:width="{((pr.neutralized / pr.opportunities) * 100).toFixed(1)}%"
			></div>
			<div
				class="bg-amber-500/60"
				style:width="{((pr.compounded / pr.opportunities) * 100).toFixed(1)}%"
			></div>
		</div>
		<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
			Neutralise rate: <span class="font-mono text-[var(--color-parchment-200)]"
				>{pctFmt(pr.neutralizeRate, 0)}</span
			>
			· opening {pr.byPhase[0].opportunities > 0
				? pctFmt(pr.byPhase[0].neutralized / pr.byPhase[0].opportunities, 0)
				: '—'}, middle {pr.byPhase[1].opportunities > 0
				? pctFmt(pr.byPhase[1].neutralized / pr.byPhase[1].opportunities, 0)
				: '—'}, end {pr.byPhase[2].opportunities > 0
				? pctFmt(pr.byPhase[2].neutralized / pr.byPhase[2].opportunities, 0)
				: '—'}.
		</div>
	{/if}
{:else if slug === 'blunder-timing'}
	{@const bt = exhibits.blunderTiming}
	{@const maxRate = Math.max(...bt.buckets.map((b) => b.rate), 0.01)}
	<div class="grid gap-1">
		{#each bt.buckets as b (b.label)}
			<div
				class="grid grid-cols-[minmax(0,4.5rem)_1fr_3rem_2.5rem] items-center gap-2 sm:grid-cols-[6rem_1fr_3.5rem_3rem]"
			>
				<span class="truncate">{b.label}</span>
				<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
					<div class="h-full rounded bg-amber-500/60" style:width={barWidth(b.rate, maxRate)}></div>
				</div>
				<span class="text-right font-mono">{b.moves > 0 ? pctFmt(b.rate, 1) : '—'}</span>
				<span class="text-right font-mono text-[var(--color-parchment-500)]">{b.moves}</span>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		{bt.totalBlunders} blunders / {bt.totalMoves.toLocaleString()} analysed moves.
	</div>
{:else if slug === 'time-of-day'}
	{@const td = exhibits.timeOfDay}
	{@const maxG = Math.max(...td.byHour.map((h) => h.games), 1)}
	<div>
		<div class="mb-1 text-[10px] text-[var(--color-parchment-500)]">
			Hour (local tz) — bar height = games, color = win rate
		</div>
		<div class="flex items-end gap-px">
			{#each td.byHour as h (h.hour)}
				<div
					class="relative flex-1 {h.games > 0 ? hourHeat(h.winRate) : 'bg-[var(--color-ink-900)]'}"
					style:height="{Math.max(6, (h.games / maxG) * 32).toFixed(1)}px"
					title="{h.hour}:00 · {h.games} games · {pctFmt(h.winRate, 0)}"
				></div>
			{/each}
		</div>
		<div
			class="mt-0.5 flex justify-between font-mono text-[10px] text-[var(--color-parchment-500)]"
		>
			<span>00</span>
			<span>06</span>
			<span>12</span>
			<span>18</span>
			<span>23</span>
		</div>
	</div>
	<div class="mt-3 grid grid-cols-7 gap-1 text-[10px]">
		{#each td.byDay as d (d.day)}
			<div
				class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-1 text-center"
			>
				<div class="text-[var(--color-parchment-500)]">{dayLabel(d.day)}</div>
				<div class="mt-0.5 font-mono {d.games === 0 ? 'text-[var(--color-parchment-600)]' : ''}">
					{d.games > 0 ? pctFmt(d.winRate, 0) : '—'}
				</div>
				<div class="text-[9px] text-[var(--color-parchment-500)]">{d.games}g</div>
			</div>
		{/each}
	</div>
{:else if slug === 'session-decay'}
	{@const sd = exhibits.sessionDecay}
	{#if !sd || sd.rows.length === 0}
		<p class="text-[var(--color-parchment-500)]">Not enough multi-game sessions yet.</p>
	{:else}
		<table class="w-full border-collapse font-mono text-[11px]">
			<thead class="text-[var(--color-parchment-500)]">
				<tr>
					<th class="pb-1 text-left font-normal">Game #</th>
					<th class="pb-1 text-right font-normal">Games</th>
					<th class="pb-1 text-right font-normal">Overall</th>
					<th class="pb-1 text-right font-normal">Opening</th>
					<th class="pb-1 text-right font-normal">Middle</th>
					<th class="pb-1 text-right font-normal">End</th>
				</tr>
			</thead>
			<tbody class="text-[var(--color-parchment-100)]">
				{#each sd.rows as r (r.index)}
					<tr class="border-t border-[var(--color-ink-800)]">
						<td class="py-1">{r.index === 5 ? '6+' : r.index + 1}</td>
						<td class="py-1 text-right">{r.games}</td>
						<td class="py-1 text-right"
							>{r.overall.avgCpLoss != null ? r.overall.avgCpLoss.toFixed(1) : '—'}</td
						>
						<td class="py-1 text-right"
							>{r.byPhase.opening.avgCpLoss != null
								? r.byPhase.opening.avgCpLoss.toFixed(1)
								: '—'}</td
						>
						<td class="py-1 text-right"
							>{r.byPhase.middle.avgCpLoss != null
								? r.byPhase.middle.avgCpLoss.toFixed(1)
								: '—'}</td
						>
						<td class="py-1 text-right"
							>{r.byPhase.end.avgCpLoss != null ? r.byPhase.end.avgCpLoss.toFixed(1) : '—'}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
			{sd.multiGameSessions} multi-game sessions across {sd.sessions} total.
		</div>
	{/if}
{:else if slug === 'repeat-offenders'}
	{@const ro = exhibits.repeatOffenders}
	{@const maxCount = Math.max(...ro.rows.map((r) => r.count), 1)}
	{#if ro.rows.length === 0}
		<p class="text-[var(--color-parchment-500)]">
			{#if !hasEvalData}
				Requires engine analysis — re-run the scan with Stockfish enabled to categorise blunders.
			{:else}
				Not enough categorised blunders.
			{/if}
		</p>
	{:else}
		<div class="grid gap-1">
			{#each ro.rows.slice(0, 6) as r, i (i)}
				<div
					class="grid grid-cols-[minmax(0,7rem)_1fr_2rem_3rem] items-center gap-2 sm:grid-cols-[12rem_1fr_2.5rem_3.5rem]"
				>
					<span class="truncate">{offenderHeading(r)}</span>
					<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
						<div
							class="h-full rounded bg-amber-500/60"
							style:width={barWidth(r.count, maxCount)}
						></div>
					</div>
					<span class="text-right font-mono">{r.count}×</span>
					<span class="text-right font-mono text-[var(--color-parchment-500)]"
						>{r.avgCpLoss.toFixed(0)}cp</span
					>
				</div>
			{/each}
		</div>
		{#if ro.longestStreak && ro.longestStreak.length >= 2}
			<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
				Longest streak: {ro.longestStreak.length}× {motifLabel(ro.longestStreak.motif)} in a row.
			</div>
		{/if}
	{/if}
{:else if slug === 'recovery-arc'}
	{@const ra = exhibits.recoveryArc}
	{@const maxCp = Math.max(...ra.points.map((p) => p.avgCpLoss), 1)}
	<div class="grid grid-cols-6 gap-2">
		{#each ra.points as p (p.offset)}
			<div class="flex flex-col items-center">
				<div class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]">
					<div
						class="w-full rounded-b {p.offset === 0 ? 'bg-red-500/70' : 'bg-amber-500/60'}"
						style:height="{Math.min(100, (p.avgCpLoss / maxCp) * 100).toFixed(1)}%"
					></div>
				</div>
				<div class="text-center text-[10px]">
					<div class="font-mono">{p.avgCpLoss.toFixed(0)}</div>
					<div class="text-[var(--color-parchment-500)]">
						{p.offset === 0 ? 'blunder' : `+${p.offset}`}
					</div>
				</div>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		Cascade rate <span class="font-mono text-amber-300">{pctFmt(ra.cascadeRate, 0)}</span>
		· steady rate
		<span class="font-mono text-emerald-300">{pctFmt(ra.steadyRate, 0)}</span>
		·
		{ra.totalBlunders} blunders.
	</div>
{:else if slug === 'opponent-strength'}
	{@const os = exhibits.opponentStrength}
	{@const maxCp = Math.max(...os.buckets.map((b) => b.avgCpLoss ?? 0), 1)}
	{@const maxGames = Math.max(...os.buckets.map((b) => b.games), 1)}
	{@const hasCp = os.buckets.some((b) => b.avgCpLoss != null)}
	{@const totalGames = os.buckets.reduce((n, b) => n + b.games, 0)}
	{#if totalGames === 0}
		<p class="text-[var(--color-parchment-500)]">
			No opponent-rating data — the scan produced no games with both ratings populated.
		</p>
	{:else}
		<div class="grid grid-cols-5 gap-2">
			{#each os.buckets as b (b.key)}
				<div class="flex flex-col items-center">
					<div class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]">
						{#if hasCp && b.avgCpLoss != null}
							<div
								class="w-full rounded-b bg-[var(--color-brass-300)]/70"
								style:height="{Math.min(100, (b.avgCpLoss / maxCp) * 100).toFixed(1)}%"
							></div>
						{:else if !hasCp && b.games > 0}
							<div
								class="w-full rounded-b bg-[var(--color-parchment-400)]/40"
								style:height="{Math.min(100, (b.games / maxGames) * 100).toFixed(1)}%"
							></div>
						{/if}
					</div>
					<div class="text-center text-[10px]">
						<div class="font-mono">
							{hasCp ? (b.avgCpLoss != null ? b.avgCpLoss.toFixed(0) : '—') : `${b.games}g`}
						</div>
						<div class="leading-tight text-[var(--color-parchment-500)]">
							{b.label.split(' ')[0]}
						</div>
						<div class="text-[9px] text-[var(--color-parchment-500)]">
							{hasCp ? `${b.games}g · ${pctFmt(b.winRate, 0)}` : pctFmt(b.winRate, 0)}
						</div>
					</div>
				</div>
			{/each}
		</div>
		{#if !hasCp}
			<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
				Bars show games per bucket (no engine data). Run with Stockfish for avg CP-loss per rating
				gap.
			</div>
		{/if}
	{/if}
{:else if slug === 'narrative'}
	<blockquote
		class="border-l-2 border-[var(--color-brass-300)] pl-4 font-serif text-[15px] leading-relaxed text-[var(--color-parchment-200)] italic"
	>
		{card.detail ?? card.headline}
	</blockquote>
	<div class="mt-3 text-[10px] text-[var(--color-parchment-500)]">
		Full three-paragraph profile on the narrative detail page.
	</div>
{:else if slug === 'level-up'}
	{@const lu = exhibits.levelUp}
	{@const maxMag = Math.max(...lu.diffs.map((d) => d.magnitude), 0.01)}
	<div class="grid gap-1">
		{#each lu.diffs as d (d.axis)}
			<div
				class="grid grid-cols-[minmax(0,5rem)_1fr_1fr_3rem] items-center gap-2 sm:grid-cols-[7rem_1fr_1fr_3.5rem]"
			>
				<span class="truncate">{LEVELUP_AXIS_LABEL[d.axis]}</span>
				<div class="flex justify-end">
					<div
						class="h-1.5 rounded bg-amber-500/60"
						style:width={barWidth(d.delta < 0 ? d.magnitude : 0, maxMag)}
					></div>
				</div>
				<div>
					<div
						class="h-1.5 rounded bg-emerald-500/60"
						style:width={barWidth(d.delta > 0 ? d.magnitude : 0, maxMag)}
					></div>
				</div>
				<span
					class="text-right font-mono {d.magnitude > 0.02
						? d.delta > 0
							? 'text-emerald-300'
							: 'text-amber-300'
						: ''}"
				>
					{signedPctFmt(d.delta, 1)}
				</span>
			</div>
		{/each}
	</div>
	<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
		You {lu.sourceRating?.toFixed(0) ?? '—'} → target {lu.targetRating || 'baseline'}
		({lu.targetSource}). Amber = you run the axis lower than the target band; emerald = higher.
	</div>
{:else if slug === 'exemplars'}
	{@const ex = exhibits.exemplars}
	{#if ex.representative.length === 0}
		<p class="text-[var(--color-parchment-500)]">Not enough games with ≥15 user moves.</p>
	{:else}
		<div class="grid gap-2 sm:grid-cols-2">
			<div>
				<div class="mb-1 text-[10px] tracking-wider text-emerald-300 uppercase">Representative</div>
				<ul class="grid gap-1">
					{#each ex.representative as g (g.gameId)}
						<li
							class="rounded border border-emerald-500/30 bg-emerald-950/10 px-2 py-1 font-mono text-[11px]"
						>
							<a
								href="https://lichess.org/{g.gameId}"
								target="_blank"
								rel="noopener"
								class="hover:underline"
							>
								#{g.gameId.slice(0, 6)} · {g.result[0].toUpperCase()} · {g.color[0]}
							</a>
							<span class="ml-1 text-[10px] text-[var(--color-parchment-500)]"
								>{g.eco ?? '?'} · d{g.distance.toFixed(2)}</span
							>
						</li>
					{/each}
				</ul>
			</div>
			<div>
				<div class="mb-1 text-[10px] tracking-wider text-amber-300 uppercase">Contradictory</div>
				<ul class="grid gap-1">
					{#each ex.contradictory as g (g.gameId)}
						<li
							class="rounded border border-amber-300/30 bg-amber-950/10 px-2 py-1 font-mono text-[11px]"
						>
							<a
								href="https://lichess.org/{g.gameId}"
								target="_blank"
								rel="noopener"
								class="hover:underline"
							>
								#{g.gameId.slice(0, 6)} · {g.result[0].toUpperCase()} · {g.color[0]}
							</a>
							<span class="ml-1 text-[10px] text-[var(--color-parchment-500)]"
								>{g.eco ?? '?'} · d{g.distance.toFixed(2)}</span
							>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
{:else if slug === 'progression'}
	{@const pg = exhibits.progression}
	{#if pg.months.length < 2}
		<p class="text-[var(--color-parchment-500)]">Not enough monthly spread yet.</p>
	{:else}
		{@const maxCp = Math.max(...pg.months.map((m) => m.avgCpLoss ?? 0), 1)}
		<div class="grid auto-cols-fr grid-flow-col gap-1">
			{#each pg.months as m (m.monthKey)}
				<div class="flex flex-col items-center">
					<div class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]">
						{#if m.avgCpLoss != null}
							<div
								class="w-full rounded-b bg-[var(--color-brass-300)]/70"
								style:height="{Math.min(100, (m.avgCpLoss / maxCp) * 100).toFixed(1)}%"
							></div>
						{/if}
					</div>
					<div class="text-center text-[10px]">
						<div class="font-mono">
							{m.avgCpLoss != null ? m.avgCpLoss.toFixed(0) : '—'}
						</div>
						<div class="leading-tight text-[var(--color-parchment-500)]">{m.label}</div>
						<div class="text-[9px] text-[var(--color-parchment-500)]">
							{m.games}g · {pctFmt(m.winRate, 0)}
						</div>
					</div>
				</div>
			{/each}
		</div>
		<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
			Direction: <span class="font-mono text-[var(--color-parchment-200)]"
				>{pg.direction ?? '—'}</span
			>
			· rating Δ {pg.deltaRating != null
				? `${pg.deltaRating >= 0 ? '+' : ''}${pg.deltaRating.toFixed(0)}`
				: '—'}
			· CP Δ {pg.deltaCpLoss != null
				? `${pg.deltaCpLoss >= 0 ? '+' : ''}${pg.deltaCpLoss.toFixed(1)}`
				: '—'}.
		</div>
	{/if}
{:else}
	<p class="text-[var(--color-parchment-500)]">—</p>
{/if}
