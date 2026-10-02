/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workspacePath = path.join(__dirname, 'timeline-workspace');
fs.mkdirSync(workspacePath, { recursive: true });
const resultsPath = path.join(__dirname, 'timeline-results.json');
let results;

module.exports = {
	id: 'hunt-337244-timeline',
	title: 'Prompt timeline: unchanged diff updates should not rebuild historical rows',
	source: 'https://github.com/microsoft/vscode/issues/337244',
	workspacePath,
	stepPauseMs: 250,
	userSettings: {
		'workbench.startupEditor': 'none',
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
	},
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	steps: [
		{
			id: 'load-components',
			title: 'Load the actual timeline model and gutter from this checkout',
			async run(context) {
				const modules = await context.page.evaluate(async () => {
					const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
					if (!root.endsWith('/out/')) {
						throw new Error(`Not a source workbench: ${location.href}`);
					}
					const [rail, model, events, observables, lifecycle, uri] = await Promise.all([
						import(root + 'vs/workbench/contrib/chat/browser/promptTimeline/promptTimelineGutterRail.js'),
						import(root + 'vs/workbench/contrib/chat/browser/promptTimeline/promptTimelineModel.js'),
						import(root + 'vs/base/common/event.js'),
						import(root + 'vs/base/common/observable.js'),
						import(root + 'vs/base/common/lifecycle.js'),
						import(root + 'vs/base/common/uri.js'),
					]);
					window.perfHuntTimeline = {
						PromptTimelineGutterRail: rail.PromptTimelineGutterRail,
						PromptTimelineModel: model.PromptTimelineModel,
						Event: events.Event,
						observableValue: observables.observableValue,
						autorun: observables.autorun,
						DisposableStore: lifecycle.DisposableStore,
						URI: uri.URI,
					};
					return { root, model: model.PromptTimelineModel.name, rail: rail.PromptTimelineGutterRail.name };
				});
				assert.equal(modules.rail, 'PromptTimelineGutterRail');
				assert.equal(modules.model, 'PromptTimelineModel');
				return `Loaded ${modules.model} and ${modules.rail} from ${modules.root}; the test does not monkey-patch the modules.`;
			},
		},
		{
			id: 'measure',
			title: 'Measure seven warmed updates at 100, 1000 and 3000 prompts',
			async run(context) {
				results = await context.page.evaluate(async () => {
					const { PromptTimelineGutterRail, PromptTimelineModel, Event, observableValue, autorun, DisposableStore, URI } = window.perfHuntTimeline;
					const output = [];
					const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const summarize = samples => {
						const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
						return { medianMs: sorted[Math.floor(sorted.length / 2)], worstMs: sorted.at(-1), samples };
					};

					for (const count of [100, 1000, 3000]) {
						const store = new DisposableStore();
						const host = document.createElement('div');
						host.className = 'prompt-timeline-host';
						host.style.cssText = 'position:fixed;left:150px;top:80px;width:800px;height:600px;z-index:10000';
						document.querySelector('.monaco-workbench').appendChild(host);
						try {
							const items = Array.from({ length: count }, (_, index) => ({
								id: `request-${index}`,
								message: {},
								messageText: `Synthetic prompt ${index + 1}`,
								timestamp: index + 1,
								currentRenderedHeight: 40,
								isSystemInitiated: false,
							}));
							const diff = {
								originalURI: URI.file('C:\\perf-hunt\\before.txt'),
								modifiedURI: URI.file('C:\\perf-hunt\\after.txt'),
								added: 3,
								removed: 1,
								identical: false,
							};
							const diffs = new Map(items.map(item => [item.id, observableValue(`diff-${item.id}`, [{ ...diff }])]));
							let lookups = 0;
							let emissions = 0;
							const widget = {
								viewModel: {
									sessionResource: URI.parse('vscode-chat-session:/perf-hunt'),
									onDidChange: Event.None,
									getItems: () => items,
								},
								onDidChangeViewModel: Event.None,
								onDidScroll: Event.None,
								onDidChangeContentHeight: Event.None,
								scrollTop: 0,
								viewportHeight: 600,
								scrollHeight: count * 40,
								getElementTop: item => (item.timestamp - 1) * 40,
							};
							const fileChangesService = {
								getChangesForRequest: (_resource, requestId) => {
									lookups++;
									return diffs.get(requestId);
								},
							};
							const editingService = {
								editingSessionsObs: observableValue('editingSessions', []),
								getEditingSession: () => undefined,
							};
							const rail = store.add(new PromptTimelineGutterRail());
							host.appendChild(rail.domNode);
							rail.setHostWidth(800);
							const model = store.add(new PromptTimelineModel(widget, editingService, fileChangesService, undefined, undefined, undefined));
							store.add(autorun(reader => {
								emissions++;
								rail.setTicks(model.promptTicks.read(reader));
							}));
							const rows = [...rail.domNode.querySelectorAll('.prompt-timeline-gutter-row')];
							if (rows.length !== count) {
								throw new Error(`Expected ${count} rows, rendered ${rows.length}.`);
							}
							const activeDiff = diffs.get(items.at(-1).id);
							activeDiff.set([{ ...diff }], undefined);
							await nextFrame();
							const noChangeSamples = [];
							const oneChangeSamples = [];
							for (const mode of ['no-change', 'one-change']) {
								for (let iteration = 0; iteration < 7; iteration++) {
									const next = { ...diff, added: mode === 'one-change' ? 4 + iteration : 3 };
									const previousLookups = lookups;
									const previousEmissions = emissions;
									const start = performance.now();
									activeDiff.set([next], undefined);
									const ms = performance.now() - start;
									const sample = { ms, fileLookups: lookups - previousLookups, emissions: emissions - previousEmissions };
									(mode === 'no-change' ? noChangeSamples : oneChangeSamples).push(sample);
									await nextFrame();
								}
							}

							const beforeLabels = rows.map(row => row.querySelector('.prompt-timeline-gutter-row-label').firstChild);
							const beforeStats = rows.map(row => row.querySelector('.prompt-timeline-gutter-row-stat').firstChild);
							const unchangedValue = activeDiff.get();
							const observer = new MutationObserver(() => {});
							observer.observe(rail.domNode, { childList: true, subtree: true });
							activeDiff.set(unchangedValue.map(value => ({ ...value })), undefined);
							const mutations = observer.takeRecords();
							observer.disconnect();
							const replacedLabels = rows.filter((row, index) => row.querySelector('.prompt-timeline-gutter-row-label').firstChild !== beforeLabels[index]).length;
							const replacedStats = rows.filter((row, index) => row.querySelector('.prompt-timeline-gutter-row-stat').firstChild !== beforeStats[index]).length;
							output.push({
								prompts: count,
								noChange: summarize(noChangeSamples),
								oneChangedRequest: summarize(oneChangeSamples),
								unchangedUpdate: { replacedLabels, replacedStats, childListMutations: mutations.length },
								renderedRows: rows.length,
							});
						} finally {
							store.dispose();
							host.remove();
						}
						await nextFrame();
					}
					delete window.perfHuntTimeline;
					return output;
				});
				fs.writeFileSync(resultsPath, JSON.stringify({
					issue: 337244,
					checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
					workingTreeChanges: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
					scope: 'Component-level probe in the real renderer; synthetic provider notifications, not a replay of the original session.',
					warmupsPerSize: 1,
					measuredRunsPerCase: 7,
					results,
				}, null, 2));
				await context.page.evaluate(measurements => {
					const board = document.createElement('pre');
					board.id = 'perf-hunt-measurements';
					board.style.cssText = 'position:fixed;top:120px;left:120px;right:120px;z-index:100000;padding:24px;white-space:pre-wrap;font:20px/1.8 monospace;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);border:2px solid var(--vscode-focusBorder)';
					board.textContent = [
						'TEST INSTRUMENTATION - ACTUAL TIMELINE COMPONENTS',
						'Synthetic data; seven warmed measurements per case.',
						'',
						...measurements.map(result => [
							`${result.prompts} prompts`,
							`  Unchanged: ${result.noChange.medianMs.toFixed(1)} ms median; ${result.noChange.worstMs.toFixed(1)} ms worst`,
							`  Replaced unchanged labels/stats: ${result.unchangedUpdate.replacedLabels}/${result.unchangedUpdate.replacedStats}`,
							`  Diff lookups per notification: ${result.noChange.samples[0].fileLookups}`,
							`  One edited prompt: ${result.oneChangedRequest.medianMs.toFixed(1)} ms median`,
						].join('\n')),
					].join('\n');
					document.querySelector('.monaco-workbench').appendChild(board);
				}, results);
				return results.map(result => `${result.prompts} prompts: unchanged-update median ${result.noChange.medianMs.toFixed(1)}ms, worst ${result.noChange.worstMs.toFixed(1)}ms; ${result.unchangedUpdate.replacedLabels} unchanged labels replaced`).join('; ');
			},
		},
		{
			id: 'unchanged-rows',
			title: 'Assert that a structurally unchanged update preserves historical row content',
			run() {
				const largest = results.at(-1);
				assert.equal(largest.unchangedUpdate.replacedLabels, 0,
					`Structurally unchanged diff notification replaced ${largest.unchangedUpdate.replacedLabels} labels and ${largest.unchangedUpdate.replacedStats} stat subtrees; median ${largest.noChange.medianMs.toFixed(1)}ms, worst ${largest.noChange.worstMs.toFixed(1)}ms.`);
				assert.ok(results.every(result => result.unchangedUpdate.replacedStats === 0
					&& result.noChange.samples.every(sample => sample.emissions === 0 && sample.fileLookups === 1)
					&& result.oneChangedRequest.samples.every(sample => sample.emissions === 1 && sample.fileLookups === 1)));
				return 'Unchanged rows were preserved.';
			},
		},
	],
};
