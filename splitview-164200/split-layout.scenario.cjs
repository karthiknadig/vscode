/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workspacePath = path.join(__dirname, 'split-workspace');
fs.mkdirSync(workspacePath, { recursive: true });
const filePath = path.join(workspacePath, 'layout-target.txt');
fs.writeFileSync(filePath, Array.from({ length: 100 }, (_, index) => `Synthetic split-layout line ${index + 1}`).join('\n'));
const resultsPath = path.join(__dirname, process.env.SPLIT_RESULTS_FILE ?? 'split-layout-results.json');
const samples = [];
let componentResults;

function save() {
	fs.writeFileSync(resultsPath, JSON.stringify({
		issue: 164200,
		checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		workingTreeChanges: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
		scope: 'Real split-editor commands with forwarding instrumentation on CodeEditorWidget.layout, plus a direct SplitView control using synthetic views.',
		warmups: 1,
		measuredSplits: 5,
		samples,
		componentResults,
	}, null, 2));
}

module.exports = {
	id: 'hunt-164200-split-layout',
	title: 'Measure duplicate layout work when splitting an editor',
	source: 'https://github.com/microsoft/vscode/issues/164200',
	workspacePath,
	stepPauseMs: 250,
	userSettings: {
		'workbench.startupEditor': 'none',
		'workbench.editor.splitSizing': 'auto',
		'workbench.editor.enablePreview': false,
		'workbench.editor.closeEmptyGroups': true,
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'editor.minimap.enabled': false,
	},
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	steps: [
		{
			id: 'open',
			title: 'Open a small text file and instrument actual editor layout calls',
			async run(context) {
				await context.workbench.quickaccess.openFile(filePath);
				const setup = await context.page.evaluate(async () => {
					const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
					const { CodeEditorWidget } = await import(root + 'vs/editor/browser/widget/codeEditor/codeEditorWidget.js');
					const original = CodeEditorWidget.prototype.layout;
					const state = { CodeEditorWidget, original, calls: [], target: undefined, active: false };
					CodeEditorWidget.prototype.layout = function (...args) {
						const capture = state.active && this.getDomNode() === state.target;
						const start = capture ? performance.now() : 0;
						const result = Reflect.apply(original, this, args);
						if (capture) {
							state.calls.push({
								width: args[0]?.width,
								height: args[0]?.height,
								durationMs: performance.now() - start,
								postponeRendering: args[1] ?? false,
							});
						}
						return result;
					};
					window.splitLayoutHunt = state;
					return { editorCount: document.querySelectorAll('.editor-instance .monaco-editor[data-uri$="layout-target.txt"]').length };
				});
				assert.equal(setup.editorCount, 1);
				return 'One real editor is open; instrumentation forwards every layout call unchanged.';
			},
		},
		{
			id: 'split',
			title: 'Split and close the second group repeatedly, recording original-editor layouts',
			async run(context) {
				try {
					for (let iteration = -1; iteration < 5; iteration++) {
						const beforeWidth = await context.page.evaluate(() => {
							const state = window.splitLayoutHunt;
							const editors = [...document.querySelectorAll('.editor-instance .monaco-editor[data-uri$="layout-target.txt"]')];
							if (editors.length !== 1) {
								throw new Error(`Expected one editor before splitting, found ${editors.length}.`);
							}
							state.target = editors[0];
							state.calls = [];
							state.active = true;
							return state.target.getBoundingClientRect().width;
						});
						await context.workbench.quickaccess.runCommand('workbench.action.splitEditorRight');
						await context.page.waitForFunction(() => document.querySelectorAll('.editor-instance .monaco-editor[data-uri$="layout-target.txt"]').length === 2);
						await context.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
						const result = await context.page.evaluate(() => {
							const state = window.splitLayoutHunt;
							state.active = false;
							return { calls: state.calls, finalWidth: state.target.getBoundingClientRect().width };
						});
						assert.ok(result.calls.length > 0, 'Instrumentation did not capture the original editor.');
						assert.ok(result.finalWidth < beforeWidth * 0.8, 'The original editor did not shrink after splitting.');
						if (iteration >= 0) {
							samples.push({ iteration: iteration + 1, beforeWidth, ...result });
							save();
						}
						await context.workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
						await context.page.waitForFunction(() => document.querySelectorAll('.editor-instance .monaco-editor[data-uri$="layout-target.txt"]').length === 1);
						await context.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					}
				} finally {
					await context.page.evaluate(() => {
						const state = window.splitLayoutHunt;
						if (state) {
							state.CodeEditorWidget.prototype.layout = state.original;
							delete window.splitLayoutHunt;
						}
					});
				}
				return samples.map(sample => `Split ${sample.iteration}: ${sample.calls.length} layout calls, widths ${sample.calls.map(call => call.width).join(' -> ')} (final ${sample.finalWidth})`).join('; ');
			},
		},
		{
			id: 'component',
			title: 'Compare automatic, distribute, and split sizing through the production SplitView',
			async run(context) {
				componentResults = await context.page.evaluate(async () => {
					const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
					const [{ SplitView, Sizing }, { Event }, { DisposableStore }] = await Promise.all([
						import(root + 'vs/base/browser/ui/splitview/splitview.js'),
						import(root + 'vs/base/common/event.js'),
						import(root + 'vs/base/common/lifecycle.js'),
					]);
					const results = [];
					for (const kind of ['auto', 'distribute', 'split']) {
						const store = new DisposableStore();
						const container = document.createElement('div');
						container.style.cssText = 'position:fixed;width:1200px;height:300px;left:100px;top:100px';
						document.querySelector('.monaco-workbench').appendChild(container);
						const calls = [];
						const view = name => ({
							element: document.createElement('div'),
							minimumSize: 220,
							maximumSize: Number.POSITIVE_INFINITY,
							onDidChange: Event.None,
							layout: size => { calls.push({ name, size }); },
						});
						try {
							const split = store.add(new SplitView(container));
							split.layout(1200);
							split.addView(view('first'), 1200);
							calls.length = 0;
							split.addView(view('second'), kind === 'auto' ? Sizing.Auto(0) : kind === 'split' ? Sizing.Split(0) : Sizing.Distribute);
							results.push({
								kind,
								calls,
								finalSizes: [split.getViewSize(0), split.getViewSize(1)],
							});
						} finally {
							store.dispose();
							container.remove();
						}
					}
					return results;
				});
				assert.ok(componentResults.every(result => result.finalSizes[0] === 600 && result.finalSizes[1] === 600));
				save();
				await context.page.evaluate(({ samples, componentResults }) => {
					const board = document.createElement('pre');
					board.style.cssText = 'position:fixed;left:100px;right:100px;top:100px;z-index:100000;padding:24px;white-space:pre-wrap;font:20px/1.8 monospace;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);border:2px solid var(--vscode-focusBorder)';
					board.textContent = [
						'TEST INSTRUMENTATION - REAL EDITOR SPLIT LAYOUT',
						'Five split commands after one warm-up; original calls forwarded.',
						'',
						...samples.map(sample => `Split ${sample.iteration}: ${sample.calls.length} calls, widths ${sample.calls.map(call => call.width).join(' -> ')}; final ${sample.finalWidth}`),
						'',
						'Production SplitView sizing control (final sizes all 600 / 600):',
						...componentResults.map(result => `${result.kind}: first-view sizes ${result.calls.filter(call => call.name === 'first').map(call => call.size).join(' -> ')}`),
					].join('\n');
					document.querySelector('.monaco-workbench').appendChild(board);
				}, { samples, componentResults });
				return componentResults.map(result => `${result.kind}: ${result.calls.filter(call => call.name === 'first').length} first-view layouts, sizes ${result.calls.filter(call => call.name === 'first').map(call => call.size).join(' -> ')}`).join('; ');
			},
		},
		{
			id: 'single-layout',
			title: 'Assert the original editor avoids a discarded intermediate width',
			run() {
				const redundant = samples.filter(sample => sample.calls.some(call => call.width !== sample.calls.at(-1).width));
				assert.equal(redundant.length, 0, `${redundant.length}/5 splits laid out the original editor at an intermediate width before its final width.`);
				assert.ok(samples.every(sample => sample.calls.length === 1), 'Every split must issue exactly one original-editor layout.');
				assert.ok(componentResults.every(result => result.calls.filter(call => call.name === 'first').length === 1));
				return 'Every split issued exactly one original-editor layout at the final width; all sizing controls retained their expected final sizes.';
			},
		},
	],
};
