/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
const ffmpeg = process.env.FFMPEG_PATH;
const ffprobe = process.env.FFPROBE_PATH;
assert.ok(ffmpeg && ffprobe, 'Set FFMPEG_PATH and FFPROBE_PATH');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const metrics = read('metrics.json');
const baselineCommit = '6fad7188e7dbf7db564e5e4a85960eb2bf69bdf4';
const fixedCommit = '278012e774a91c3429e087dff94fb01b844be907';
const colors = { text: 'e6edf3', muted: '9ba7b4', grid: '30363d', before: 'ff7b72', after: '3fb950' };
const format = (value, digits = 0) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const range = (stage, key, digits) => {
	const values = metrics[stage].map(run => run[key]);
	return `${Math.min(...values).toFixed(digits)}-${Math.max(...values).toFixed(digits)}`;
};
const samples = {};
for (const stage of ['before', 'after']) {
	const raw = read(path.join(stage, 'run-1.json'));
	assert.deepEqual(raw.input, { files: 500, markersPerFile: 4, markers: 2000, messageCharacters: 77, payloadBytes: 1478001 });
	const cycles = raw.samples.filter(sample => sample.mode === 'hide-update-show');
	samples[stage] = cycles.map(sample => ({
		...sample,
		heapDeltaMiB: (sample.usedSize - cycles[0].usedSize) / 1048576
	}));
	assert.equal(samples[stage].length, 7);
	assert.ok(samples[stage].every(sample => sample.markers === 2000));
	assert.equal(samples[stage].at(-1).staleStates, stage === 'before' ? 13976 : 0);
}

function run(executable, args, cwd = 'C:\\Windows\\Fonts') {
	const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(`${path.basename(executable)} failed: ${result.error ?? result.stderr}`);
	}
	return result.stdout;
}

function text(value, x, y, size = 24, color = colors.text, strong = false) {
	assert.ok(!/['\\:]/.test(value), 'Unsupported drawtext escaping');
	return `drawtext=fontfile=${strong ? 'seguisb.ttf' : 'segoeui.ttf'}:text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=0x${color}:expansion=none`;
}

function box(x, y, width, height, color) {
	return `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=0x${color}:t=fill`;
}

function image(file, filters, height) {
	run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x0d1117:s=1200x${height}`, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', path.join(root, file)]);
}

const card = [
	text('#339535 - Problems keeps only current diagnostic state', 40, 28, 34, colors.text, true),
	text('Same 2,000 diagnostics / 500 URIs / seven hide-update-show cycles', 40, 82, 24),
	text('Three fresh Windows Code OSS Dev windows per side', 40, 119, 20, colors.muted),
	text('BEFORE / 6fad7188', 505, 174, 24, colors.before, true),
	text('AFTER / 278012e7', 855, 174, 24, colors.after, true),
];
const rows = [
	['Current diagnostics', '2,000', '2,000', 236, 36, false],
	['Obsolete view models', '13,976', '0', 322, 48, true],
	['Heap growth/cycle (MiB)', range('before', 'medianMiBPerCycle', 2), range('after', 'medianMiBPerCycle', 2), 428, 34, true],
	['Visible-update control', range('before', 'controlMedianMiBPerCycle', 3), range('after', 'controlMedianMiBPerCycle', 3), 514, 32, false],
	['States after explicit clear', '0', '0', 600, 34, false]
];
for (const [label, before, after, y, size, emphasized] of rows) {
	card.push(text(label, 40, y + 8, 26));
	card.push(text(before, 505, y, size, emphasized ? colors.before : colors.text, emphasized));
	card.push(text(after, 855, y, size, emphasized ? colors.after : colors.text, emphasized));
}
card.push(text('Heap rows are per-window warmed medians in MiB/cycle; first cycle excluded.', 40, 682, 21, colors.muted));
card.push(text('GC twice per sample. Synthetic diagnostics - not language-server or typing latency.', 40, 716, 21, colors.muted));
card.push(text('Installed Insiders not tested because its shared installation has a pending update.', 40, 749, 20, colors.muted));
image('comparison.png', card, 790);

function plot(filters, values, index, x, title, maximum, color) {
	const y = 315;
	const height = 195;
	filters.push(text(title, x, 266, 25, colors.text, true));
	for (const [fraction, label] of [[0, '0'], [0.5, format(maximum / 2)], [1, format(maximum)]]) {
		const lineY = y + height * (1 - fraction);
		filters.push(box(x + 52, lineY, 470, 1, colors.grid));
		filters.push(text(label, x, lineY - 12, 17, colors.muted));
	}
	values.forEach((value, point) => {
		assert.ok(value >= 0 && value <= maximum);
		const barX = x + 67 + point * 65;
		if (point <= index) {
			const barHeight = height * value / maximum;
			filters.push(box(barX, y + height - Math.max(2, barHeight), 30, Math.max(2, barHeight), color));
		}
		filters.push(text(String(point + 1), barX + 8, y + height + 10, 19, colors.muted));
	});
}

const clips = [];
for (const stage of ['before', 'after']) {
	const frames = [];
	for (let index = 0; index < 7; index++) {
		const sample = samples[stage][index];
		const color = colors[stage];
		const filters = [
			text(`#339535 ${stage.toUpperCase()} - ${stage === 'before' ? 'obsolete state accumulates' : 'obsolete state is released'}`, 40, 28, 34, colors.text, true),
			text(`Recorded data replay / run 1 of 3 / cycle ${index + 1} of 7${index === 0 ? ' - warmup' : ''}`, 40, 82, 23, colors.muted),
			text('Current diagnostics', 40, 136, 22, colors.muted),
			text('Obsolete models', 405, 136, 22, colors.muted),
			text('Heap growth since warmup', 790, 136, 22, colors.muted),
			text(format(sample.markers), 40, 174, 46, colors.text, true),
			text(format(sample.staleStates), 405, 174, 46, color, true),
			text(`${format(sample.heapDeltaMiB, 2)} MiB`, 790, 174, 42, color, true),
		];
		plot(filters, samples[stage].map(sample => sample.staleStates), index, 40, 'Obsolete view models', 14000, color);
		plot(filters, samples[stage].map(sample => sample.heapDeltaMiB), index, 625, 'Post-GC growth after warmup (MiB)', 120, color);
		filters.push(text('Cycle', 292, 557, 20, colors.muted));
		filters.push(text('Cycle', 877, 557, 20, colors.muted));
		filters.push(text('GC twice per sample / heap zeroed at cycle 1 on both sides / same scales', 40, 596, 23));
		filters.push(text('Not elapsed-action playback. Full raw heap samples are published with this proof.', 40, 632, 21, colors.muted));
		const name = `${stage}-frame-${index + 1}.png`;
		image(name, filters, 680);
		frames.push(name);
	}
	const concat = `${stage}-frames.txt`;
	fs.writeFileSync(path.join(root, concat), frames.map((frame, index) => `file '${frame}'\nduration ${index === 6 ? 1.5 : 0.5}`).join('\n') + `\nfile '${frames.at(-1)}'\n`);
	run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-filter_complex', 'fps=8,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-t', '4.5', '-loop', '0', `${stage}.gif`], root);
	const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height:format=duration,size', '-of', 'json', path.join(root, `${stage}.gif`)]));
	assert.equal(probe.streams[0].width, 1200);
	assert.equal(probe.streams[0].height, 680);
	assert.ok(Number(probe.format.duration) >= 3 && Number(probe.format.duration) <= 5);
	assert.ok(Number(probe.format.size) < 8 * 1024 * 1024);
	clips.push({ file: `${stage}.gif`, source: `${stage}/run-1.json`, kind: 'recorded data replay, not elapsed-action playback', heapOrigin: 'First hide/update/show cycle (warmup) subtracted from usedSize in every plotted sample; no interpolation.', ...probe });
	for (const frame of frames) {
		fs.unlinkSync(path.join(root, frame));
	}
	fs.unlinkSync(path.join(root, concat));
}
const provenance = {
	issue: 'https://github.com/microsoft/vscode/issues/339535',
	baselineCommit,
	fixedCommit,
	preservedHunterCommit: 'dcb81648f8a8f1863d2577f8fec98e805e5f95a0',
	scenarioSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'problems-retention.scenario.cjs'))).digest('hex'),
	input: read(path.join('before', 'run-1.json')).input,
	build: 'Both measured sides used npm run transpile-client; npm run compile-client also passed for the fix.',
	sampling: 'Three fresh windows per side; seven cycles per mode; first cycle warmup; six consecutive post-GC heap differences per window; medians of those six differences.',
	card: 'comparison.png',
	cardScope: 'All three windows. Exact final model counts and range of per-window median heap deltas.',
	clips,
	limits: [
		'Synthetic diagnostics delivered to the real MarkerService; real panel toggles; no language-server or typing latency claim.',
		'Visible single-resource updates invalidate the cache before hiding; diagnostic messages change while hidden. Plain hide/show is not claimed to leak.',
		'Remaining small renderer heap growth is not claimed to be zero; all obsolete marker view models are released.',
		'Windows Dev builds only; shared installed Insiders not launched because it has a pending update.',
		'Keyboard focus and accessible labels checked; no physical screen-reader test.'
	]
};
fs.writeFileSync(path.join(root, 'proof-provenance.json'), JSON.stringify(provenance, null, 2));
console.log(JSON.stringify({ card: provenance.card, clips }, null, 2));
