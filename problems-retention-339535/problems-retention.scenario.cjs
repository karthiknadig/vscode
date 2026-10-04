/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspacePath = path.join(__dirname, 'workspace');
fs.mkdirSync(workspacePath, { recursive: true });
const stamp = Date.now();
const resultsPath = path.join(__dirname, `retention-${stamp}.json`);
let results;

module.exports = {
	id: 'wave2-diagnostics-retention',
	title: 'Problems must release obsolete per-marker state across hide/update/show cycles',
	source: 'https://github.com/microsoft/vscode/issues/125929',
	workspacePath,
	stepPauseMs: 0,
	userSettings: {
		'workbench.startupEditor': 'none',
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'problems.defaultViewMode': 'tree',
		'problems.autoReveal': false,
		'window.title': 'diagnostics-perf isolated retention probe'
	},
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	steps: [
		{
			id: 'baseline',
			title: 'Load the real Problems view and 2,000 diagnostics from a bounded synthetic provider',
			async run(context) {
				await context.page.evaluate(async workspace => {
					const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
					if (!root.endsWith('/out/')) {
						throw new Error('Existing compiled dev workbench required.');
					}
					const [actions, markers, views, uris] = await Promise.all([
						import(root + 'vs/platform/actions/common/actions.js'),
						import(root + 'vs/platform/markers/common/markers.js'),
						import(root + 'vs/workbench/services/views/common/viewsService.js'),
						import(root + 'vs/base/common/uri.js')
					]);
					window.__diagnosticsPerfRegistration = actions.registerAction2(class extends actions.Action2 {
						constructor() {
							super({ id: 'diagnosticsPerf.captureRetention', title: 'Diagnostics Perf Capture Retention', f1: true });
						}
						async run(accessor) {
							const service = accessor.get(markers.IMarkerService);
							const viewsService = accessor.get(views.IViewsService);
							const view = await viewsService.openView('workbench.panel.markers.view', true);
							const resources = Array.from({ length: 500 }, (_, index) => uris.URI.file(workspace + `\\module${String(index).padStart(5, '0')}.ts`));
							window.__diagnosticsPerf = { service, view, resources, viewsService, revision: 0 };
							window.__diagnosticsPerf.update = (revision, single) => {
								const data = Array.from({ length: 4 }, (_, index) => ({
									severity: 8,
									message: `Type 'number' is not assignable to type 'string'. Diagnostic ${index}, revision ${revision}.`,
									source: 'diagnostics-perf',
									code: '2322',
									startLineNumber: index + 1,
									startColumn: 1,
									endLineNumber: index + 1,
									endColumn: 10
								}));
								if (single) {
									service.changeOne('diagnostics-perf', resources[0], data);
								} else {
									const entries = resources.flatMap(resource => data.map(marker => ({ resource, marker })));
									const inputBytes = new TextEncoder().encode(JSON.stringify(entries)).length;
									if (inputBytes > 64 * 1024 * 1024) {
										throw new Error('64 MiB diagnostic payload cap exceeded.');
									}
									window.__diagnosticsPerf.inputBytes = inputBytes;
									window.__diagnosticsPerf.messageCharacters = data[0].message.length;
									service.changeAll('diagnostics-perf', entries);
								}
								window.__diagnosticsPerf.revision = revision;
							};
							window.__diagnosticsPerf.update(0, false);
						}
					});
				}, workspacePath);
				await context.workbench.quickaccess.runCommand('diagnosticsPerf.captureRetention');
				await context.page.waitForFunction(() => window.__diagnosticsPerf?.view.markersModel.total === 2000);
				const baseline = await context.page.evaluate(() => {
					const { view, service } = window.__diagnosticsPerf;
					return { visible: view.isVisible(), markers: view.markersModel.total, states: view.markersViewModel.markersViewStates.size, errors: service.getStatistics().errors };
				});
				assert.deepEqual(baseline, { visible: true, markers: 2000, states: 2000, errors: 2000 });
				return JSON.stringify(baseline);
			}
		},
		{
			id: 'measure',
			title: 'Compare visible updates with actual hide/update/show commands, collecting garbage at rest',
			async run(context) {
				const cdp = await context.page.context().newCDPSession(context.page);
				const deadline = Date.now() + 150000;
				const settle = async () => {
					await context.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					await cdp.send('HeapProfiler.collectGarbage');
					await cdp.send('HeapProfiler.collectGarbage');
				};
				const sample = async (mode, iteration) => {
					await settle();
					const heap = await cdp.send('Runtime.getHeapUsage');
					const counts = await context.page.evaluate(() => {
						const { view, revision, service } = window.__diagnosticsPerf;
						const states = view.markersViewModel.markersViewStates;
						let staleStates = 0;
						for (const { viewModel } of states.values()) {
							if (!viewModel.marker.marker.message.endsWith(`revision ${revision}.`)) {
								staleStates++;
							}
						}
						return {
							markers: view.markersModel.total,
							serviceMarkers: service.read({ owner: 'diagnostics-perf' }).length,
							viewStates: states.size,
							staleStates,
							cachePopulated: !!view.markersModel.cachedSortedResources,
							visible: view.isVisible()
						};
					});
					assert.equal(counts.markers, 2000);
					assert.equal(counts.serviceMarkers, 2000);
					assert.equal(counts.visible, true);
					return { mode, iteration, ...heap, ...counts };
				};
				const update = async (revision, single) => {
					if (Date.now() > deadline) {
						throw new Error('150-second retention measurement deadline exceeded.');
					}
					await context.page.evaluate(({ revision, single }) => window.__diagnosticsPerf.update(revision, single), { revision, single });
					await context.page.waitForFunction(revision => {
						const { view, resources } = window.__diagnosticsPerf;
						return view.markersModel.getResourceMarkers(resources[0])?.markers[0]?.marker.message.endsWith(`revision ${revision}.`);
					}, revision, { timeout: 10000 });
				};
				const samples = [];
				try {
					samples.push(await sample('baseline', -1));
					for (let iteration = 0; iteration < 7; iteration++) {
						await update(iteration + 1, false);
						samples.push(await sample('visible-update-control', iteration));
					}
					for (let iteration = 0; iteration < 7; iteration++) {
						await update(100 + iteration, true);
						const beforeHide = await context.page.evaluate(() => ({
							cachePopulated: !!window.__diagnosticsPerf.view.markersModel.cachedSortedResources,
							states: window.__diagnosticsPerf.view.markersViewModel.markersViewStates.size
						}));
						await context.workbench.quickaccess.runCommand('workbench.action.togglePanel');
						await context.page.waitForFunction(() => !window.__diagnosticsPerf.view.isVisible());
						const hiddenStates = await context.page.evaluate(revision => {
							const state = window.__diagnosticsPerf;
							const count = state.view.markersViewModel.markersViewStates.size;
							state.update(revision, false);
							return count;
						}, 200 + iteration);
						await context.workbench.quickaccess.runCommand('workbench.action.togglePanel');
						await context.page.waitForFunction(revision => {
							const { view, resources } = window.__diagnosticsPerf;
							return view.isVisible() && view.markersModel.total === 2000 &&
								view.markersModel.getResourceMarkers(resources[0])?.markers[0]?.marker.message.endsWith(`revision ${revision}.`);
						}, 200 + iteration, { timeout: 10000 });
						samples.push({ ...await sample('hide-update-show', iteration), beforeHide, hiddenStates });
					}
					const input = await context.page.evaluate(() => ({
						files: 500,
						markersPerFile: 4,
						markers: 2000,
						messageCharacters: window.__diagnosticsPerf.messageCharacters,
						payloadBytes: window.__diagnosticsPerf.inputBytes
					}));
					results = {
						boundary: 'Real Problems UI toggled through the Command Palette; actual workbench MarkerService and view models; a synthetic provider replaces diagnostics while hidden.',
						input,
						warmupsPerMode: 1,
						measuredCyclesPerMode: 6,
						samples
					};
					fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
					if (process.env.DIAGNOSTICS_SNAPSHOT === '1') {
						const snapshotPath = path.join(__dirname, `retention-${stamp}.heapsnapshot`);
						const stream = fs.createWriteStream(snapshotPath);
						const onChunk = chunk => stream.write(chunk.chunk);
						cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
						await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
						cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
						await new Promise((resolve, reject) => {
							stream.once('error', reject);
							stream.end(resolve);
						});
						results.snapshotPath = snapshotPath;
						fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
					}
				} finally {
					await cdp.detach();
				}
				return JSON.stringify({ resultsPath, samples: results.samples.map(({ mode, iteration, usedSize, viewStates, staleStates }) => ({ mode, iteration, usedSize, viewStates, staleStates })) });
			}
		},
		{
			id: 'expected-release',
			title: 'Obsolete diagnostic view models must not accumulate when Problems is reopened',
			async run(context) {
				const last = results.samples.at(-1);
				await context.page.evaluate(() => {
					window.__diagnosticsPerf.service.changeAll('diagnostics-perf', []);
					window.__diagnosticsPerfRegistration.dispose();
				});
				await context.page.waitForFunction(() => window.__diagnosticsPerf.view.markersModel.total === 0);
				const released = await context.page.evaluate(() => window.__diagnosticsPerf.view.markersViewModel.markersViewStates.size);
				const cdp = await context.page.context().newCDPSession(context.page);
				try {
					await cdp.send('HeapProfiler.collectGarbage');
					await cdp.send('HeapProfiler.collectGarbage');
					results.afterExplicitClear = { currentMarkers: 0, viewStates: released, ...await cdp.send('Runtime.getHeapUsage') };
				} finally {
					await cdp.detach();
				}
				fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
				assert.deepEqual({ viewStates: last.viewStates, staleStates: last.staleStates }, { viewStates: 2000, staleStates: 0 });
				return 'Current diagnostics have exactly one view model each; obsolete revisions are released.';
			}
		}
	]
};
