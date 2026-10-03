/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const evidenceRoot = 'Q:\\GIT\\vscode.worktrees\\perf-evidence-5be74984';
const sessionFiles = 'C:\\Users\\kanadig\\.copilot\\session-state\\5be74984-e914-4843-8a16-9065f861cc4a\\files';
const output = import.meta.dirname;
const ffmpeg = 'C:\\Users\\kanadig\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe';
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const recorded = (folder, name) => read(path.join(evidenceRoot, folder, name));
const format = (value, unit = '') => `${value.toLocaleString('en-US', { maximumFractionDigits: unit === 'MiB' ? 2 : 1 })}${unit ? ` ${unit}` : ''}`;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const timelineBefore = recorded('timeline-337244', 'timeline-before-results.json').results.find(result => result.prompts === 3000);
const timelineAfter = recorded('timeline-337244', 'timeline-after-results.json').results.find(result => result.prompts === 3000);
const base64Before = recorded('base64-334892', 'base64-before-results.json').results.find(result => result.algorithm === 'production' && result.inputBytes === 4194304);
const base64After = recorded('base64-334892', 'base64-after-results.json').results.find(result => result.algorithm === 'production' && result.inputBytes === 4194304);
const splitBefore = recorded('splitview-164200', 'split-before-results.json');
const splitAfter = recorded('splitview-164200', 'split-after-results.json');
const notebookBefore = recorded('notebook-stream-normalization', 'before.json');
const notebookAfter = recorded('notebook-stream-normalization', 'after-1.json');
assert.equal(timelineBefore.unchangedUpdate.replacedLabels, 3000);
assert.equal(timelineAfter.unchangedUpdate.replacedLabels, 0);
assert.ok(base64Before.samples.every(sample => sample.matchesNative));
assert.ok(base64After.samples.every(sample => sample.matchesNative));
assert.ok(splitBefore.samples.every(sample => sample.calls.length === 2 && sample.finalWidth === 633));
assert.ok(splitAfter.samples.every(sample => sample.calls.length === 1 && sample.finalWidth === 633));
assert.ok(notebookBefore.cases.every(result => result.samples.every(sample => sample.correct)));
assert.ok(notebookAfter.cases.every(result => result.samples.every(sample => sample.correct)));

const definitions = [
	{
		id: 339406,
		key: 'timeline',
		title: 'Prompt timeline - skip unchanged row updates',
		context: 'Same input: one unchanged diff notification in a 3,000-prompt timeline',
		rows: [
			{ label: 'Renderer work', before: timelineBefore.noChange.medianMs, after: timelineAfter.noChange.medianMs, unit: 'ms' },
			{ label: 'Stat subtrees rebuilt', before: timelineBefore.unchangedUpdate.replacedStats, after: timelineAfter.unchangedUpdate.replacedStats },
			{ label: 'Diff-stat lookups', before: timelineBefore.noChange.samples[0].fileLookups, after: timelineAfter.noChange.samples[0].fileLookups },
		],
		note: 'The UI should look identical. The improvement is work that no longer happens.',
		limit: 'Component benchmark with synthetic notifications; not a session-startup measurement.',
		proof: 'Five warmed samples; exact row-content checks; fixed scenario passed in 3 fresh windows.',
		short: 'Caches per-prompt statistics and leaves unchanged timeline rows alone. An unchanged notification in a 3,000-prompt timeline now rebuilds **zero stat subtrees instead of 3,000**. The screen should look identical.',
		validation: '40 targeted tests passed. Live stats, focus, keyboard navigation, and disposal are covered.',
		bodyFile: 'timeline-pr-body.md',
		folder: 'timeline-337244',
		oldNames: ['timeline-before.gif', 'timeline-after.gif'],
		directories: [
			'Q:\\GIT\\vscode\\.build\\vscode-playwright-mcp\\evidence\\hunt-337244-timeline-2026-10-02T20-31-09-501Z',
			'Q:\\GIT\\vscode.worktrees\\perf-fixes-5be74984\\.build\\vscode-playwright-mcp\\evidence\\hunt-337244-timeline-2026-10-02T20-31-51-532Z',
		],
		step: 'measure',
	},
	{
		id: 339434,
		key: 'base64',
		title: 'Base64 - less memory and renderer blocking',
		context: 'Same input: 4 MiB binary buffer; same exact 5.33 MiB encoded output',
		rows: [
			{ label: 'Encoding time', before: base64Before.medianEncodeMs, after: base64After.medianEncodeMs, unit: 'ms' },
			{ label: 'Memory while output lives', before: base64Before.medianRetainedMemoryBytes / 1048576, after: base64After.medianRetainedMemoryBytes / 1048576, unit: 'MiB' },
		],
		note: 'One output-sized byte buffer replaces the large chain of per-character strings.',
		limit: 'Memory includes heap plus backing storage. Encoder probe, not a full plugin-sync test.',
		proof: 'Five warmed samples; byte-for-byte native control; fixed scenario passed in 3 windows.',
		short: 'Encodes into one sized byte buffer instead of building a chain of tiny strings. For the same **4 MiB input**, output is byte-for-byte identical with much less blocking and retained memory.',
		validation: '44 codec tests passed in each of Node and Electron; 37 RPC/resource-transfer tests passed.',
		bodyFile: 'base64-pr-body.md',
		folder: 'base64-334892',
		oldNames: ['base64-before.gif', 'base64-after.gif'],
		directories: [
			'Q:\\GIT\\vscode\\.build\\vscode-playwright-mcp\\evidence\\hunt-334892-base64-2026-10-02T23-40-30-944Z',
			'Q:\\GIT\\vscode.worktrees\\perf-fixes-5be74984\\.build\\vscode-playwright-mcp\\evidence\\hunt-334892-base64-2026-10-02T23-41-32-135Z',
		],
		step: 'measure',
	},
	{
		id: 339450,
		key: 'split',
		title: 'Editor split - one final layout, not two',
		context: 'Same action: split a text editor to the right; final width stays 633',
		rows: [
			{ label: 'Existing-editor layouts', before: 2, after: 1 },
			{ label: 'Layout-method time', before: median(splitBefore.samples.map(sample => sample.calls.reduce((sum, call) => sum + call.durationMs, 0))), after: median(splitAfter.samples.map(sample => sample.calls.reduce((sum, call) => sum + call.durationMs, 0))), unit: 'ms' },
		],
		note: 'Before 1046.4 then 633. After directly to 633. Final layout is unchanged.',
		limit: 'Modest measured benefit. This is layout-method time, not total editor-opening time.',
		proof: 'Real split commands; five samples per run; 15 after-splits across 3 windows.',
		short: 'Stops rendering an intermediate editor width that is immediately discarded. The existing editor is laid out **once instead of twice**, with the same final dimensions. This is a modest optimization, not a large end-to-end speedup.',
		validation: '137 SplitView, grid, and editor-group tests passed; final sizes and constraints are covered.',
		bodyFile: 'split-pr-body.md',
		folder: 'splitview-164200',
		oldNames: ['split-before.gif', 'split-after.gif'],
		directories: [
			'Q:\\GIT\\vscode\\.build\\vscode-playwright-mcp\\evidence\\hunt-164200-split-layout-2026-10-03T03-11-23-547Z',
			'Q:\\GIT\\vscode.worktrees\\perf-fixes-5be74984\\.build\\vscode-playwright-mcp\\evidence\\hunt-164200-split-layout-2026-10-03T03-12-29-134Z',
		],
		step: 'component',
	},
	{
		id: 339459,
		key: 'notebook',
		title: 'Notebook stdout - remove the 1.3-second stall',
		context: 'Same progress records and exact normalized output; only the algorithm changes',
		rows: [1000, 2000, 4000].map(lines => ({
			label: `${lines * 41 / 1000} KB progress batch`,
			before: notebookBefore.cases.find(result => result.specification.lines === lines && result.specification.carriageReturn).medianMs,
			after: notebookAfter.cases.find(result => result.specification.lines === lines && result.specification.carriageReturn).medianMs,
			unit: 'ms',
		})),
		note: 'Doubling ordinary progress output no longer quadruples normalization time.',
		limit: 'Legacy dollar-text lines keep the old path. Component probe, not live-kernel execution.',
		proof: '68 tests; 299,593 compatibility cases; identical renderer scenario passes 3/3.',
		short: 'Normalizes ordinary carriage-return progress output without rescanning the entire stream repeatedly. The same **164 KB batch** drops from **1.30 seconds to 2.2 ms**, with identical output.',
		validation: '68 notebook tests and 299,593 baseline compatibility comparisons passed. Legacy dollar-text behavior is intentionally preserved; those affected streams retain the old path and cost.',
		bodyFile: 'notebook-stream-pr-body.md',
		folder: 'notebook-stream-normalization',
		oldNames: ['before.gif', 'after.gif'],
		directories: [
			'Q:\\GIT\\vscode\\.build\\vscode-playwright-mcp\\evidence\\high-impact-notebook-stream-2026-10-03T07-04-25-231Z',
			'Q:\\GIT\\vscode.worktrees\\perf-fixes-5be74984\\.build\\vscode-playwright-mcp\\evidence\\high-impact-notebook-stream-2026-10-03T07-05-15-832Z',
		],
		step: 'measure',
	},
];

function run(executable, args, options = {}) {
	const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
	if (result.error || result.status !== 0) {
		throw new Error(`${path.basename(executable)} failed: ${result.error ?? result.stderr}`);
	}
	return result.stdout;
}

function text(value, x, y, size, color = 'e6edf3', bold = false) {
	value = value.replaceAll(':', ' -');
	assert.ok(!value.includes("'") && !value.includes('\\'), 'Unexpected filter text escaping');
	return `drawtext=fontfile=${bold ? 'segoeuib.ttf' : 'segoeui.ttf'}:text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=0x${color}:expansion=none`;
}

function renderCard(definition) {
	const height = definition.rows.length === 3 ? 730 : 600;
	const maximumFor = row => Math.max(...definition.rows
		.filter(candidate => (candidate.unit ?? candidate.label) === (row.unit ?? row.label))
		.flatMap(candidate => [candidate.before, candidate.after]));
	const filters = [
		text(`#${definition.id}  ${definition.title}`, 40, 30, 34, 'e6edf3', true),
		text(definition.context, 40, 87, 23),
		text('Recorded measurements | Lower is better | Windows Code OSS Dev', 40, 125, 20, '9ba7b4'),
		text('BEFORE', 440, 185, 25, 'ff7b72', true),
		text('AFTER', 825, 185, 25, '3fb950', true),
	];
	definition.rows.forEach((row, index) => {
		const y = 243 + index * 130;
		filters.push(text(row.label, 40, y + 9, 25));
		filters.push(text(format(row.before, row.unit), 440, y, 39, 'ff7b72', true));
		filters.push(text(format(row.after, row.unit), 825, y, 39, '3fb950', true));
		const maximum = maximumFor(row);
		for (const [value, x, color] of [[row.before, 440, 'ff7b72'], [row.after, 825, '3fb950']]) {
			if (value > 0) {
				filters.push(`drawbox=x=${x}:y=${y + 59}:w=${Math.max(1, Math.round(295 * value / maximum))}:h=12:color=0x${color}:t=fill`);
			}
		}
	});
	filters.push(text(definition.note, 40, height - 111, 22));
	filters.push(text(definition.limit, 40, height - 74, 20, '9ba7b4'));
	filters.push(text(definition.proof, 40, height - 39, 19, '9ba7b4'));
	run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x0d1117:s=1200x${height}`, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', path.join(output, `${definition.key}-proof.png`)], { cwd: 'C:\\Windows\\Fonts' });
}

function trimResults(definition, side) {
	const directory = definition.directories[side];
	const manifest = read(path.join(directory, 'manifest.json'));
	const capture = manifest.steps.find(step => step.id === definition.step).captures.find(capture => capture.status === 'passed');
	assert.ok(capture && manifest.videoStartedAt);
	const video = path.join(directory, 'videos', 'annotated.mp4');
	const duration = Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]).trim());
	const start = (Date.parse(capture.timestamp) - Date.parse(manifest.videoStartedAt)) / 1000;
	assert.ok(start > 0 && start < duration, `Invalid trim point for ${definition.key}`);
	const seconds = Math.min(5, duration - start);
	assert.ok(seconds >= 1);
	const name = `${definition.key}-${side === 0 ? 'before' : 'after'}-short.gif`;
	run(ffmpeg, [
		'-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(seconds), '-i', video,
		'-filter_complex', '[0:v]fps=6,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
		'-loop', '0', path.join(output, name),
	]);
	return { file: name, source: video, startSeconds: start, durationSeconds: seconds, omittedLeadInSeconds: start, kind: 'measured-result excerpt, not action-latency playback' };
}

const mode = process.argv[2] ?? 'artifacts';
if (mode === 'artifacts') {
	const provenance = [];
	for (const definition of definitions) {
		renderCard(definition);
		const clips = [trimResults(definition, 0), trimResults(definition, 1)];
		provenance.push({ pr: definition.id, card: `${definition.key}-proof.png`, recordedRows: definition.rows, chartScale: 'Shared across rows with the same unit; pixel-rounded bars, exact numbers labeled.', note: definition.note, limit: definition.limit, sourceFolder: definition.folder, clips });
	}
	fs.writeFileSync(path.join(output, 'proof-provenance.json'), JSON.stringify(provenance, null, 2));
	console.log(JSON.stringify(provenance.map(entry => ({ pr: entry.pr, card: entry.card, clips: entry.clips.map(clip => ({ file: clip.file, omittedLeadInSeconds: clip.omittedLeadInSeconds, durationSeconds: clip.durationSeconds })) })), null, 2));
} else if (mode === 'bodies') {
	const sha = process.argv[3];
	assert.match(sha ?? '', /^[0-9a-f]{40}$/);
	const baseUrl = `https://raw.githubusercontent.com/karthiknadig/vscode/${sha}/brief-performance-proof`;
	for (const definition of definitions) {
		const original = fs.readFileSync(path.join(sessionFiles, definition.bodyFile), 'utf8');
		const commentEnd = original.indexOf('-->') + 3;
		assert.ok(commentEnd > 3);
		const template = original.slice(0, commentEnd);
		let fullDetails = original.slice(commentEnd).trim();
		let replaced = 0;
		fullDetails = fullDetails.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
			const side = definition.oldNames.findIndex(name => url.includes(`${definition.folder}/${name}`));
			if (side < 0) {
				return match;
			}
			replaced++;
			return `![${alt} - measured-result excerpt, startup removed](${baseUrl}/${definition.key}-${side === 0 ? 'before' : 'after'}-short.gif)`;
		});
		assert.equal(replaced, 2, `Expected exactly two recording URLs in PR ${definition.id}`);
		const rows = definition.rows.map(row => `| ${row.label} | ${format(row.before, row.unit)} | ${format(row.after, row.unit)} |`).join('\n');
		const body = `${template}\n\n${definition.short}\n\n| Measured operation | Before | After |\n|---|---:|---:|\n${rows}\n\n![Recorded before and after measurements for ${definition.title}](${baseUrl}/${definition.key}-proof.png)\n\n**Proof scope:** ${definition.limit} ${definition.validation}\n\n<details>\n<summary>Reproduction clips (startup removed), implementation, and full validation commands</summary>\n\nThe clips below are brief measured-result excerpts. The comparison above is the primary performance proof; clip duration is not a benchmark.\n\n${fullDetails}\n\n</details>\n`;
		fs.writeFileSync(path.join(output, `${definition.id}-body.md`), body);
	}
	console.log('Generated four concise PR introductions; original details and template comments preserved.');
} else {
	throw new Error(`Unknown mode: ${mode}`);
}
