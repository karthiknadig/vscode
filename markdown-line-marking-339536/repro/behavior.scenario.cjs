/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-markdown-behavior-'));
const rows = Array.from({ length: 120 }, (_, index) => `Row ${String(index).padStart(3, '0')}: unchanged documentation.`);
const modifiedRows = rows.flatMap((row, index) => index === 40 ? [] : index === 20 ? ['Row 020: modified documentation.'] : index === 75 ? [row, 'Inserted documentation paragraph.'] : [row]);
const prefix = '# Mapping smoke\n\n[Jump to Tail](#tail)\n\nOpening paragraph\ncontinues on a second line.\n\n- Outer one\n  - Nested one\n  - Nested two\n- Outer two\n\n```text\nalpha\nbeta\ngamma\n```\n\n';
const suffix = '\n\n## Tail\n\nEnd of the document.\n';
const originalText = prefix + rows.join('\n\n') + suffix;
const original = path.join(workspacePath, 'original.md');
const modified = path.join(workspacePath, 'modified.md');
fs.writeFileSync(original, originalText);
fs.writeFileSync(modified, prefix + modifiedRows.join('\n\n') + suffix);
const results = { workspacePath, checks: [] };
const save = () => fs.writeFileSync(path.join(__dirname, 'behavior-results.json'), JSON.stringify(results, null, 2));
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

async function command(context, kind, args = {}) {
	const response = path.join(__dirname, 'behavior-response.json');
	if (fs.existsSync(response)) {
		fs.unlinkSync(response);
	}
	fs.writeFileSync(path.join(__dirname, 'behavior-request.json'), JSON.stringify({ kind, original, modified, response, ...args }));
	await context.workbench.quickaccess.runCommand('markdownLineMapSmoke.run');
	const end = Date.now() + 30000;
	while (!fs.existsSync(response) && Date.now() < end) {
		await pause();
	}
	assert.ok(fs.existsSync(response), `${kind} command did not complete`);
	const value = JSON.parse(fs.readFileSync(response, 'utf8'));
	assert.equal(value.ok, true, value.error);
	return value.detail;
}

async function previews(context, count) {
	const end = Date.now() + 30000;
	while (Date.now() < end) {
		const frames = [];
		for (const frame of context.page.frames()) {
			if (frame.isDetached()) {
				continue;
			}
			try {
				if (await frame.locator('.markdown-body h1').count() === 1 && await frame.locator('.markdown-body > p').count() >= 120) {
					frames.push(frame);
				}
			} catch (error) {
				if (!frame.isDetached()) {
					throw error;
				}
			}
		}
		if (frames.length === count) {
			return frames;
		}
		await pause();
	}
	throw new Error(`Expected ${count} loaded Markdown previews`);
}

async function verify(frame, expectedRows, changes) {
	const state = await frame.evaluate(override => {
		const root = document.querySelector('.markdown-body');
		const settings = JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings'));
		const lineChanges = override === null ? settings.lineChanges : override;
		const entries = [{ line: -1, element: document.body }];
		for (const element of document.getElementsByClassName('code-line')) {
			if (!(element instanceof HTMLElement)) {
				continue;
			}
			const line = +element.getAttribute('data-line');
			if (isNaN(line) || ['PRE', 'UL', 'OL'].includes(element.tagName)) {
				continue;
			}
			entries.push({ line, element });
		}
		const markers = {};
		for (const kind of ['added', 'deleted']) {
			const expected = new Set();
			for (const target of lineChanges?.[kind] || []) {
				const line = Math.floor(target);
				let previous = entries[0];
				let next;
				for (const entry of entries) {
					if (entry.line === line) {
						previous = entry;
						next = undefined;
						break;
					}
					if (entry.line > line) {
						next = entry;
						break;
					}
					previous = entry;
				}
				const entry = previous.line >= 0 ? previous : next;
				if (entry) {
					expected.add(entry.element);
				}
			}
			const actual = [...document.querySelectorAll(`.code-line-diff-${kind}`)];
			markers[kind] = {
				expected: expected.size,
				actual: actual.length,
				missing: [...expected].filter(element => !actual.includes(element)).length,
				unexpected: actual.filter(element => !expected.has(element)).length
			};
		}
		const content = root.cloneNode(true);
		for (const decoration of content.querySelectorAll('.diff-change-indicator, .diff-modification-gutter')) {
			decoration.remove();
		}
		return {
			paragraphs: [...content.querySelectorAll(':scope > p')].map(element => element.textContent),
			headings: [...content.querySelectorAll('h1, h2')].map(element => element.textContent),
			listItems: [...content.querySelectorAll('li')].map(element => element.firstChild.textContent.trim()),
			code: content.querySelector('pre code')?.textContent,
			tooltips: [...root.querySelectorAll('.diff-change-indicator-tooltip')].map(tooltip => ({
				deleted: tooltip.querySelector('.diff-tooltip-deleted')?.textContent || '',
				added: tooltip.querySelector('.diff-tooltip-added')?.textContent || ''
			})),
			expectedTooltips: (lineChanges?.changeIndicators || []).map(indicator => ({ deleted: indicator.originalContent || '', added: indicator.modifiedContent || '' })),
			markers,
			modified: root.querySelectorAll('.code-line-diff-modified').length,
			indicators: root.querySelectorAll('.diff-change-indicator').length,
			gutters: root.querySelectorAll('.diff-modification-gutter').length,
			innerHighlights: [...CSS.highlights.keys()],
			role: settings.diffScrollSync?.role,
			lineChanges
		};
	}, changes === undefined ? null : changes);
	assert.deepEqual(state.paragraphs, ['Jump to Tail', 'Opening paragraph\ncontinues on a second line.', ...expectedRows, 'End of the document.']);
	assert.deepEqual(state.headings, ['Mapping smoke', 'Tail']);
	assert.deepEqual(state.listItems, ['Outer one', 'Nested one', 'Nested two', 'Outer two']);
	assert.equal(state.code, 'alpha\nbeta\ngamma\n');
	assert.deepEqual(state.tooltips, state.expectedTooltips);
	assert.ok(Object.values(state.markers).every(marker => marker.missing === 0 && marker.unexpected === 0), JSON.stringify(state.markers));
	return state;
}

async function visibleRow(frame, text) {
	await frame.waitForFunction(text => {
		const paragraph = [...document.querySelectorAll('.markdown-body > p')].find(element => element.textContent === text);
		if (!paragraph) {
			return false;
		}
		const bounds = paragraph.getBoundingClientRect();
		return bounds.top >= -40 && bounds.top < innerHeight;
	}, text, { timeout: 15000 });
}

async function scrollIdle(frame) {
	await frame.evaluate(() => new Promise(resolve => {
		let timer;
		const finish = () => {
			window.removeEventListener('scroll', restart);
			window.removeEventListener('resize', restart);
			resolve();
		};
		const restart = () => {
			clearTimeout(timer);
			timer = setTimeout(finish, 250);
		};
		window.addEventListener('scroll', restart, { passive: true });
		window.addEventListener('resize', restart);
		restart();
	}));
}

module.exports = {
	id: 'w2-markdown-line-map-behavior',
	title: 'Preserve Markdown text, diff markers, navigation, and scroll synchronization',
	source: 'https://github.com/microsoft/vscode/issues/339536',
	workspacePath,
	stepPauseMs: 300,
	extraArgs: ['--disable-workspace-trust', `--extensionDevelopmentPath=${path.join(__dirname, 'behavior-fixture')}`],
	userSettings: {
		'workbench.startupEditor': 'none',
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'workbench.enableExperiments': false,
		'markdown.validate.enabled': false,
		'markdown.preview.scrollEditorWithPreview': true,
		'markdown.preview.scrollPreviewWithEditor': true,
		'markdown.preview.doubleClickToSwitchToEditor': true,
		'git.enabled': false
	},
	steps: [
		{
			id: 'ordinary',
			title: 'Check exact ordinary preview output and actual loaded bundle',
			async run(context) {
				await command(context, 'preview');
				const [frame] = await previews(context, 1);
				results.ordinary = await verify(frame, rows);
				const cdp = await context.page.context().newCDPSession(frame.parentFrame() || context.page);
				const scripts = [];
				cdp.on('Debugger.scriptParsed', script => scripts.push(script));
				try {
					await cdp.send('Debugger.enable');
					const script = scripts.find(script => script.url.includes('markdown-language-features') && script.url.endsWith('/media/index.js'));
					assert.ok(script, 'Built-in Markdown preview bundle must be loaded');
					const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
					const loadedHash = createHash('sha256').update(scriptSource).digest('hex');
					const diskHash = createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), 'extensions', 'markdown-language-features', 'media', 'index.js'))).digest('hex');
					assert.equal(loadedHash, diskHash);
					results.bundle = { loadedHash, diskHash };
					await cdp.send('Debugger.disable');
				} finally {
					await cdp.detach();
				}
				results.checks.push('ordinary exact text, nested lists, multiline paragraph/code, zero diff markers, loaded bundle hash');
				save();
				return 'Exact text and nested/code mappings preserved; loaded preview bundle matches fixed disk output.';
			}
		},
		{
			id: 'updates',
			title: 'Verify unordered added/deleted lines, empty content, and cleared updates',
			async run(context) {
				const [frame] = await previews(context, 1);
				const changes = { added: [0, 8, 8, 2, 14, 100000, 10], deleted: [5, 16, 1, 1] };
				await frame.evaluate(changes => {
					const settings = JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings'));
					window.smokeInput = { source: settings.source, content: document.querySelector('.markdown-body').outerHTML };
					window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateContent', ...window.smokeInput, lineChanges: changes } }));
				}, changes);
				results.mixed = await verify(frame, rows, changes);
				await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
					type: 'updateContent', source: window.smokeInput.source, content: document.querySelector('.markdown-body').outerHTML
				} })));
				await verify(frame, rows, {});
				for (const changes of [{ added: [], deleted: [] }, undefined]) {
					await frame.evaluate(changes => window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateContent', ...window.smokeInput, lineChanges: changes } })), changes);
					await verify(frame, rows, {});
				}
				await frame.evaluate(() => {
					window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateContent', source: window.smokeInput.source, content: '<div class="markdown-body"></div>', lineChanges: {} } }));
					window.dispatchEvent(new MessageEvent('message', { data: { type: 'onDidChangeTextEditorSelection', source: window.smokeInput.source, line: 0 } }));
				});
				assert.equal(await frame.locator('.markdown-body > *').count(), 0);
				await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateContent', ...window.smokeInput } })));
				await verify(frame, rows, {});
				results.checks.push('unordered and duplicate changes, added/deleted classes versus legacy oracle, incoming predecorated HTML, empty arrays, undefined changes, empty document, fresh restored mapping');
				save();
				return 'All added/deleted targets match the legacy oracle; empty and cleared updates restore exact unmarked content.';
			}
		},
		{
			id: 'source-sync',
			title: 'Exercise real editor-to-preview scrolling and preview double-click navigation',
			async run(context) {
				await context.workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
				await command(context, 'synced');
				const [frame] = await previews(context, 1);
				for (const row of [80, 5]) {
					const line = originalText.split('\n').indexOf(rows[row]);
					await command(context, 'select', { line });
					await frame.waitForFunction(line => document.querySelector('.code-active-line')?.getAttribute('data-line') === String(line), line, { timeout: 15000 });
					await visibleRow(frame, rows[row]);
				}
				await frame.getByText(rows[30], { exact: true }).dblclick({ position: { x: 10, y: 2 } });
				const expected = originalText.split('\n').indexOf(rows[30]);
				const end = Date.now() + 10000;
				let selections;
				do {
					selections = await command(context, 'inspect');
					if (selections.some(selection => selection.line === expected)) {
						break;
					}
					await pause();
				} while (Date.now() < end);
				assert.ok(selections.some(selection => selection.line === expected), JSON.stringify({ expected, selections }));
				results.sourceSync = { forwardRow: 80, backwardRow: 5, doubleClickLine: expected };
				results.checks.push('real source selections scroll preview forward/backward, active line, double-click reveals exact source line');
				save();
				return 'Source rows 80 and 5 scroll correctly; preview double-click reveals the expected source line.';
			}
		},
		{
			id: 'side-by-side',
			title: 'Verify real side-by-side diff output and bidirectional scrolling',
			async run(context) {
				await command(context, 'diff', { sideBySide: true });
				const frames = await previews(context, 2);
				const sides = {};
				for (const frame of frames) {
					const role = await frame.evaluate(() => JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings')).diffScrollSync.role);
					sides[role] = frame;
					results[role] = await verify(frame, role === 'original' ? rows : modifiedRows);
				}
				assert.ok(results.original.markers.deleted.actual > 0);
				assert.ok(results.modified.markers.added.actual > 0);
				assert.ok(results.modified.innerHighlights.includes('diff-inner-added'));
				results.scrollSettlingMs = 250;
				save();
				for (const row of [80, 5]) {
					await Promise.all(frames.map(scrollIdle));
					await sides.modified.getByText(rows[row], { exact: true }).scrollIntoViewIfNeeded();
					await visibleRow(sides.original, rows[row]);
				}
				await Promise.all(frames.map(scrollIdle));
				await sides.original.getByText(rows[90], { exact: true }).scrollIntoViewIfNeeded();
				await visibleRow(sides.modified, rows[90]);
				results.checks.push('real side-by-side original/modified exact source text and separate tooltip text, all added/deleted markers, inner highlights, forward/backward and reverse-direction scroll sync');
				save();
				return 'Both real diff sides preserve exact text and markers; scrolling synchronizes in both directions.';
			}
		},
		{
			id: 'inline',
			title: 'Check real inline diff and keyboard anchor navigation',
			async run(context) {
				await command(context, 'diff', { sideBySide: false });
				const [frame] = await previews(context, 1);
				results.inline = await verify(frame, modifiedRows);
				assert.ok(results.inline.markers.added.actual > 0);
				assert.ok(results.inline.indicators > 0 && results.inline.gutters > 0);
				const link = frame.getByRole('link', { name: 'Jump to Tail', exact: true });
				await link.focus();
				await link.press('Enter');
				await frame.waitForFunction(() => {
					const bounds = document.querySelector('#tail').getBoundingClientRect();
					return bounds.top >= 0 && bounds.top < innerHeight;
				}, undefined, { timeout: 15000 });
				await frame.locator('body').press('Control+Home');
				await frame.waitForFunction(() => scrollY < 10, undefined, { timeout: 10000 });
				results.checks.push('real inline exact text, added markers, deletion indicators, modification gutters, labeled keyboard link and Ctrl+Home');
				save();
				return 'Inline diff markers and indicators remain correct; keyboard anchor and Ctrl+Home navigation work.';
			}
		},
		{
			id: 'clear-real-diff',
			title: 'Edit the modified document back to its original content and clear every decoration',
			async run(context) {
				await command(context, 'replace', { text: originalText });
				const [frame] = await previews(context, 1);
				await frame.waitForFunction(() => !document.querySelector('.code-line-diff-added, .code-line-diff-deleted, .code-line-diff-modified, .diff-change-indicator, .diff-modification-gutter'), undefined, { timeout: 15000 });
				results.cleared = await verify(frame, rows, {});
				assert.deepEqual(results.cleared.innerHighlights, []);
				results.checks.push('real document edit refreshes inline diff, exact restored text, zero diff classes/indicators/gutters/highlights');
				save();
				return 'Real edited document is byte-for-byte original; preview has exact original text and no stale diff decorations.';
			}
		}
	]
};
