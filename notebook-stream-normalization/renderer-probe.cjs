/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = kind => {
	const workspacePath = path.join(__dirname, 'workspace');
	fs.mkdirSync(workspacePath, { recursive: true });
	const resultsPath = path.join(__dirname, `${kind}-renderer-${Date.now()}.json`);
	const results = {
		kind,
		resultsPath,
		checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		workingTreeChanges: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
		cases: []
	};
	const summarize = samples => {
		const sorted = samples.map(sample => sample.syncMs).sort((a, b) => a - b);
		return { medianMs: sorted[Math.floor(sorted.length / 2)], worstMs: sorted.at(-1), samples };
	};
	const measure = async (context, specification) => {
		const cdp = await context.page.context().newCDPSession(context.page);
		const samples = [];
		try {
			for (let iteration = 0; iteration < 6; iteration++) {
				let timer;
				const timeout = new Promise((resolve, reject) => {
					timer = setTimeout(() => {
						cdp.send('Runtime.terminateExecution').then(
							() => reject(new Error('Production sample exceeded the declared 8000 ms limit; execution terminated.')),
							reject
						);
					}, 8000);
				});
				let result;
				try {
					result = await Promise.race([
						context.page.evaluate(spec => window.editorNotebookProbe.sample(spec), specification),
						timeout
					]);
				} finally {
					clearTimeout(timer);
				}
				assert.equal(result.correct, true);
				if (iteration > 0) {
					samples.push(result);
				}
			}
		} finally {
			await cdp.detach();
		}
		const measured = { specification, ...summarize(samples) };
		results.cases.push(measured);
		fs.writeFileSync(resultsPath, JSON.stringify(results, null, '\t'));
		await context.page.evaluate(measured => window.editorNotebookProbe.showSummary(measured), measured);
		return measured;
	};
	return {
		id: `high-impact-notebook-${kind}`,
		title: kind === 'stream' ? 'Notebook stdout normalization should not stall the renderer' : 'Notebook diff should not rehash unchanged output on the renderer',
		workspacePath,
		stepPauseMs: 300,
		userSettings: {
			'workbench.startupEditor': 'none',
			'telemetry.telemetryLevel': 'off',
			'chat.disableAIFeatures': true,
			'workbench.enableExperiments': false
		},
		extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
		steps: [
			{
				id: 'baseline',
				title: 'Verify real production models, small-input correctness, and worker alignment',
				async run(context) {
					await context.page.waitForSelector('.monaco-workbench');
					results.environment = await context.page.evaluate(async kind => {
						const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
						if (!root.endsWith('/out/')) {
							throw new Error(`This component scenario requires a source workbench: ${location.href}`);
						}
						const [{ VSBuffer }, { NotebookCellOutputTextModel }, { NotebookCellTextModel }, { NotebookWorker }, { computeDiff }, { URI }] = await Promise.all([
							import(root + 'vs/base/common/buffer.js'),
							import(root + 'vs/workbench/contrib/notebook/common/model/notebookCellOutputTextModel.js'),
							import(root + 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel.js'),
							import(root + 'vs/workbench/contrib/notebook/common/services/notebookWebWorker.js'),
							import(root + 'vs/workbench/contrib/notebook/common/notebookDiff.js'),
							import(root + 'vs/base/common/uri.js')
						]);
						const panel = document.createElement('section');
						panel.style.cssText = 'position:fixed;left:80px;top:65px;right:80px;bottom:55px;z-index:10000;padding:24px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-focusBorder);font:16px monospace;overflow:auto';
						const heading = document.createElement('h2');
						heading.textContent = kind === 'stream' ? 'Notebook stdout: carriage-return progress output' : 'Notebook diff: unchanged output before one source edit';
						panel.appendChild(heading);
						const explanation = document.createElement('p');
						explanation.textContent = 'Bounded production-component probe in the Code OSS renderer. Synthetic notebook DTOs; no production methods patched. Not an end-to-end notebook-open measurement.';
						panel.appendChild(explanation);
						const heartbeat = document.createElement('p');
						panel.appendChild(heartbeat);
						let ticks = 0;
						const heartbeatTimer = setInterval(() => heartbeat.textContent = `Renderer heartbeat: ${++ticks}`, 50);
						const status = document.createElement('pre');
						status.style.whiteSpace = 'pre-wrap';
						panel.appendChild(status);
						const summary = document.createElement('pre');
						panel.appendChild(summary);
						document.querySelector('.monaco-workbench').appendChild(panel);
						const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
						const alignments = new Map();
						const makeDtos = (modified, spec) => {
							const line = 'Result: 0123456789 abcdefghijklmnopqrstuvwxyz\n';
							const output = VSBuffer.fromString(line.repeat(Math.ceil(spec.bytes / line.length)).slice(0, spec.bytes));
							const cells = [
								{ source: 'print(results)', language: 'python', cellKind: 2, outputs: [{ outputId: 'log', outputs: [{ mime: 'text/plain', data: output }] }], metadata: {}, internalMetadata: { internalId: 'log-cell' } },
								{ source: modified ? 'x = 2' : 'x = 1', language: 'python', cellKind: 2, outputs: [], metadata: {}, internalMetadata: { internalId: 'edited-cell' } }
							];
							return spec.changedFirst ? cells.reverse() : cells;
						};
						const getAlignment = async spec => {
							const key = `${spec.bytes}:${spec.changedFirst}`;
							if (alignments.has(key)) {
								return alignments.get(key);
							}
							const worker = new NotebookWorker();
							const toWorkerDtos = (modified, url) => makeDtos(modified, spec).map((cell, handle) => ({
								...cell, handle, url: `${url}#${handle}`, source: cell.source.split('\n'), eol: '\n', versionId: 1
							}));
							worker.$acceptNewModel('file:///original.ipynb', {}, {}, toWorkerDtos(false, 'file:///original.ipynb'));
							worker.$acceptNewModel('file:///modified.ipynb', {}, {}, toWorkerDtos(true, 'file:///modified.ipynb'));
							try {
								const alignment = await worker.$computeDiff('file:///original.ipynb', 'file:///modified.ipynb');
								const index = spec.changedFirst ? 0 : 1;
								const changes = alignment.cellsDiff.changes;
								if (changes.length !== 1 || changes[0].originalStart !== index || changes[0].modifiedStart !== index || changes[0].originalLength !== 1 || changes[0].modifiedLength !== 1) {
									throw new Error(`Unexpected production worker alignment: ${JSON.stringify(alignment)}`);
								}
								alignments.set(key, alignment);
								return alignment;
							} finally {
								worker.$acceptRemovedModel('file:///original.ipynb');
								worker.$acceptRemovedModel('file:///modified.ipynb');
								worker.dispose();
							}
						};
						window.editorNotebookProbe = {
							async sample(spec) {
								status.textContent = `Preparing ${JSON.stringify(spec)}\nInput creation, worker alignment, and correctness checks are excluded from syncMs.`;
								if (spec.kind === 'stream') {
									const mime = 'application/vnd.code.notebook.stdout';
									const expected = 'Log start\n' + Array.from({ length: spec.lines }, (_, index) => `Task ${String(index).padStart(5, '0')}: complete\n`).join('');
									const text = Array.from({ length: spec.lines }, (_, index) => {
										const prefix = `Task ${String(index).padStart(5, '0')}: `;
										return spec.carriageReturn ? `${prefix}running\r${prefix}complete\n` : `${prefix}complete\n`;
									}).join('');
									const data = VSBuffer.fromString(text);
									const model = new NotebookCellOutputTextModel({ outputId: 'stream', outputs: [{ mime, data: VSBuffer.fromString('Log start\n') }] });
									let events = 0;
									const listener = model.onDidChangeData(() => events++);
									try {
										const beforeFrame = await frame();
										const start = performance.now();
										model.appendData([{ mime, data }]);
										const syncMs = performance.now() - start;
										const afterFrame = await frame();
										const actual = model.outputs[0].data.toString();
										const correct = model.outputs.length === 1 && actual === expected && model.versionId === 1 && events === 1;
										if (!correct) {
											throw new Error('Stream baseline/output shape or exact normalized bytes are incorrect.');
										}
										status.textContent = `appendData: ${syncMs.toFixed(1)} ms synchronous\nRenderer frame gap: ${(afterFrame - beforeFrame).toFixed(1)} ms\nInput: ${data.byteLength} bytes; output: ${model.outputs[0].data.byteLength} bytes\nExact output, version, and event count verified.\nPreview:\n${actual.slice(0, 170)}`;
										return { correct, syncMs, frameGapMs: afterFrame - beforeFrame, inputBytes: data.byteLength, outputBytes: model.outputs[0].data.byteLength, version: model.versionId, events };
									} finally {
										listener.dispose();
										model.dispose();
									}
								}
								const alignment = await getAlignment(spec);
								const createCells = (modified, url) => makeDtos(modified, spec).map((cell, handle) => new NotebookCellTextModel(
									URI.parse(`${url}#${handle}`), handle, cell,
									{ transientOutputs: false, transientCellMetadata: {}, transientDocumentMetadata: {} },
									{}, 1, undefined, undefined, { trace() {} }
								));
								const original = { cells: createCells(false, 'file:///original.ipynb') };
								const modified = { cells: createCells(true, 'file:///modified.ipynb') };
								try {
									const beforeFrame = await frame();
									const start = performance.now();
									const result = computeDiff(original, modified, alignment);
									const syncMs = performance.now() - start;
									const afterFrame = await frame();
									const index = spec.changedFirst ? 0 : 1;
									const expected = {
										cellDiffInfo: [0, 1].map(i => ({ originalCellIndex: i, modifiedCellIndex: i, type: i === index ? 'modified' : 'unchanged' })),
										firstChangeIndex: index
									};
									const correct = JSON.stringify(result) === JSON.stringify(expected);
									if (!correct) {
										throw new Error(`Unexpected production renderer diff result: ${JSON.stringify(result)}`);
									}
									status.textContent = `computeDiff: ${syncMs.toFixed(1)} ms synchronous\nRenderer frame gap: ${(afterFrame - beforeFrame).toFixed(1)} ms\n${spec.bytes} output bytes in each notebook; one source edit at cell ${index + 1}\nExact worker alignment and renderer result verified:\n${JSON.stringify(result, null, 2)}`;
									return { correct, syncMs, frameGapMs: afterFrame - beforeFrame, inputBytesPerNotebook: spec.bytes, alignment, result };
								} finally {
									original.cells.forEach(cell => cell.dispose());
									modified.cells.forEach(cell => cell.dispose());
								}
							},
							showSummary(result) {
								summary.textContent += `${JSON.stringify(result.specification)}: median ${result.medianMs.toFixed(2)} ms; worst ${result.worstMs.toFixed(2)} ms (5 warmed samples)\n`;
							},
							stop() {
								clearInterval(heartbeatTimer);
							}
						};
						return {
							root, userAgent: navigator.userAgent,
							productionClasses: [NotebookCellOutputTextModel.name, NotebookCellTextModel.name, NotebookWorker.name],
							adapters: 'Synthetic notebook DTOs and two-cell containers; unused language service and trace-only logger. Real NotebookWorker run locally only for setup/alignment, excluded from syncMs. Real renderer computeDiff and models are unmodified.',
							bounds: { maximumDataBytes: 8 * 1024 * 1024, perSampleTimeoutMs: 8000 }
						};
					}, kind);
					const baseline = await measure(context, kind === 'stream'
						? { kind, lines: 16, carriageReturn: true }
						: { kind, bytes: 1024, changedFirst: false });
					assert.ok(baseline.medianMs < 100, `Small-input baseline is unexpectedly slow: ${baseline.medianMs}`);
					return `Production imports, exact small output, and model lifecycle passed; baseline ${baseline.medianMs.toFixed(2)} ms.`;
				}
			},
			{
				id: 'control',
				title: 'Measure equivalent normalized output or same-size notebook control',
				async run(context) {
					const control = await measure(context, kind === 'stream'
						? { kind, lines: 4000, carriageReturn: false }
						: { kind, bytes: 4 * 1024 * 1024, changedFirst: true });
					assert.ok(control.medianMs < 50, `Control is unexpectedly slow: ${control.medianMs}`);
					return `Control passed exact result checks: median ${control.medianMs.toFixed(2)} ms, worst ${control.worstMs.toFixed(2)} ms.`;
				}
			},
			{
				id: 'measure',
				title: 'Measure realistic bounded inputs with five warmed renderer samples',
				async run(context) {
					for (const size of kind === 'stream' ? [1000, 2000, 4000] : [1, 2, 4]) {
						await measure(context, kind === 'stream'
							? { kind, lines: size, carriageReturn: true }
							: { kind, bytes: size * 1024 * 1024, changedFirst: false });
					}
					const target = results.cases.at(-1);
					return `Exact results passed at all sizes. Largest: median ${target.medianMs.toFixed(2)} ms, worst ${target.worstMs.toFixed(2)} ms. Raw data: ${resultsPath}`;
				}
			},
			{
				id: 'budget',
				title: 'Notebook processing must stay below the 200 ms renderer-stall budget',
				async run(context) {
					await context.page.evaluate(() => window.editorNotebookProbe.stop());
					const target = results.cases.at(-1);
					const control = results.cases[1];
					results.expected = { maximumMedianRendererStallMs: 200, equivalentControlMaximumMs: 50 };
					results.actual = { medianMs: target.medianMs, worstMs: target.worstMs, ratioToControl: target.medianMs / control.medianMs };
					fs.writeFileSync(resultsPath, JSON.stringify(results, null, '\t'));
					assert.ok(target.medianMs < 200, `${kind}: median renderer block ${target.medianMs.toFixed(2)} ms (worst ${target.worstMs.toFixed(2)}), expected <200 ms; control ${control.medianMs.toFixed(2)} ms. Exact output passed. Results: ${resultsPath}`);
					return `Renderer processing passed the 200 ms budget.`;
				}
			}
		]
	};
};
