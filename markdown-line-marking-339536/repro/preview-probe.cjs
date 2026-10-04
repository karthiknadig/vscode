/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realDiff = process.env.MARKDOWN_HUNT_REAL_DIFF === '1';
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-markdown-'));
const outputPath = path.join(__dirname, `${realDiff ? 'real-diff' : 'preview-probe'}-${Date.now()}.json`);
const results = {
	label: realDiff
		? 'Real rendered Markdown diff opened through the workbench. Component timings replay the exact HTML and line-change metadata produced by the built-in preview, not end-to-end opening latency.'
		: 'Real built-in Markdown preview; component timings of unmodified production message/scroll handlers. Synthetic, valid added-line metadata.',
	workspacePath,
	outputPath,
	cases: []
};
const sizes = (process.env.MARKDOWN_HUNT_SIZES || '100,2000,8000,16000').split(',').map(Number);
for (const count of sizes) {
	const text = (realDiff ? '# Existing documentation\n\n' : '') + Array.from({ length: count }, (_, index) => `Record ${String(index).padStart(6, '0')}: locally generated documentation paragraph.\n\n`).join('');
	fs.writeFileSync(path.join(workspacePath, `records-${count}.md`), text);
}
fs.writeFileSync(path.join(workspacePath, 'original.md'), '# Existing documentation\n\n');
const save = () => fs.writeFileSync(outputPath, JSON.stringify(results, null, '\t'));
const summarize = samples => {
	const times = samples.map(x => x.syncMs).sort((a, b) => a - b);
	return { medianMs: times[Math.floor(times.length / 2)], worstMs: times.at(-1), samples };
};

async function open(context, count, kind = realDiff ? 'openDiff' : 'openPreview') {
	await context.workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	const response = path.join(__dirname, 'response.json');
	if (fs.existsSync(response)) {
		fs.unlinkSync(response);
	}
	fs.writeFileSync(path.join(__dirname, 'request.json'), JSON.stringify({
		modified: path.join(workspacePath, `records-${count}.md`),
		original: path.join(workspacePath, 'original.md'),
		title: `Generated Markdown: ${count} added paragraphs`,
		response
	}));
	await context.workbench.quickaccess.runCommand(`markdownHunt.${kind}`);
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (fs.existsSync(response)) {
			const value = JSON.parse(fs.readFileSync(response, 'utf8'));
			assert.equal(value.ok, true, value.error);
			break;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(fs.existsSync(response), 'Driver command must complete within 30 seconds');
	while (Date.now() < deadline) {
		for (const frame of context.page.frames()) {
			if (frame.isDetached()) {
				continue;
			}
			try {
				const matches = await frame.locator('.markdown-body > p').count();
				if (matches === count) {
					const hasDiff = await frame.evaluate(() => !!JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings')).lineChanges?.added?.length);
					if (!realDiff || hasDiff) {
						return frame;
					}
				}
			} catch (error) {
				if (!frame.isDetached()) {
					throw error;
				}
				results.detachedDuringNavigation = (results.detachedDuringNavigation || 0) + 1;
				console.log('Hunt harness: transient preview frame detached while the new editor was loading.');
			}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	results.frames = context.page.frames().map(frame => ({ name: frame.name(), url: frame.url() }));
	results.targets = await context.code.driver.getCDPTargets();
	save();
	throw new Error(`Preview with exactly ${count} paragraphs not found; frame/target details saved.`);
}

async function boundedEvaluate(context, frame, fn, arg) {
	const cdp = await context.page.context().newCDPSession(frame.parentFrame() || context.page);
	let timer;
	try {
		return await Promise.race([
			frame.evaluate(fn, arg),
			new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					cdp.send('Runtime.terminateExecution').then(
						() => reject(new Error('Sample exceeded 8000 ms; terminated, not classified as a product cause.')),
						reject
					);
				}, 8000);
			})
		]);
	} finally {
		clearTimeout(timer);
		await cdp.detach();
	}
}

async function measure(context, count) {
	const frame = await open(context, count);
	await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const input = await frame.evaluate(realDiff => {
		const root = document.querySelector('.markdown-body');
		const metadata = document.getElementById('vscode-markdown-preview-data');
		const settings = JSON.parse(metadata.getAttribute('data-settings'));
		window.markdownHunt = {
			html: realDiff ? metadata.getAttribute('data-initial-md-content') : root.outerHTML,
			text: Array.from({ length: root.querySelectorAll(':scope > p').length }, (_, index) => `Record ${String(index).padStart(6, '0')}: locally generated documentation paragraph.`).join('\n'),
			source: settings.source,
			lines: Array.from({ length: document.querySelectorAll('.markdown-body > p').length * 2 }, (_, i) => i),
			changes: settings.lineChanges,
			count: document.querySelectorAll('.markdown-body > p').length
		};
		if (!window.markdownHunt.html) {
			throw new Error('Built-in preview did not retain initial HTML in its metadata');
		}
		return {
			htmlBytes: new TextEncoder().encode(window.markdownHunt.html).length,
			source: settings.source,
			lineCount: window.markdownHunt.lines.length,
			productionAddedLineCount: settings.lineChanges?.added?.length,
			initialMarkedParagraphs: root.querySelectorAll(':scope > p.code-line-diff-added').length,
			initialModifiedGutters: root.querySelectorAll('.diff-modification-gutter').length,
			unchangedHeading: root.querySelector('h1')?.textContent,
			markedHeadings: root.querySelectorAll('h1.code-line-diff').length,
			exactTextCorrect: Array.from(root.querySelectorAll(':scope > p'), paragraph => paragraph.textContent).join('\n') === window.markdownHunt.text
		};
	}, realDiff);
	assert.equal(input.exactTextCorrect, true);
	if (realDiff) {
		assert.equal(input.initialMarkedParagraphs, count);
		assert.equal(input.productionAddedLineCount, count * 2);
		assert.equal(input.unchangedHeading, 'Existing documentation');
		assert.equal(input.markedHeadings, 1, 'The inserted blank line maps to the preceding heading in the current renderer');
		assert.equal(input.initialModifiedGutters, 0);
	}
	const measured = { count, inputBytes: fs.statSync(path.join(workspacePath, `records-${count}.md`)).size, ...input, modes: {} };
	for (const mode of realDiff ? ['unchanged', 'added'] : ['unchanged', 'added', 'scroll', 'scroll-suppressed']) {
		const samples = [];
		for (let iteration = 0; iteration < 6; iteration++) {
			const sample = await boundedEvaluate(context, frame, async mode => {
				await new Promise(resolve => setTimeout(resolve, 120));
				const state = window.markdownHunt;
				if (mode === 'scroll-suppressed') {
					window.dispatchEvent(new Event('resize'));
				}
				const started = performance.now();
				if (mode === 'scroll' || mode === 'scroll-suppressed') {
					window.dispatchEvent(new Event('scroll'));
				} else {
					window.dispatchEvent(new MessageEvent('message', { data: {
						type: 'updateContent',
						source: state.source,
						content: state.html,
						lineChanges: mode === 'added' ? (state.changes || { added: state.lines }) : undefined
					} }));
				}
				const syncMs = performance.now() - started;
				const root = document.querySelector('.markdown-body');
				return {
					syncMs,
					paragraphs: root.querySelectorAll(':scope > p').length,
					marked: root.querySelectorAll(':scope > p.code-line-diff-added').length,
					markedHeadings: root.querySelectorAll('h1.code-line-diff-added').length,
					modifiedGutters: root.querySelectorAll('.diff-modification-gutter').length,
					correctText: Array.from(root.querySelectorAll(':scope > p'), paragraph => paragraph.textContent).join('\n') === state.text,
					scrollY: window.scrollY
				};
			}, mode);
			assert.equal(sample.correctText, true);
			assert.equal(sample.paragraphs, count);
			if (mode === 'unchanged' || mode === 'added') {
				assert.equal(sample.marked, mode === 'added' ? count : 0);
				if (realDiff || process.env.MARKDOWN_HUNT_CARD === '1') {
					assert.equal(sample.markedHeadings, mode === 'added' ? input.markedHeadings : 0);
					assert.equal(sample.modifiedGutters, mode === 'added' ? input.initialModifiedGutters : 0);
				}
			}
			if (iteration > 0) {
				samples.push(sample);
			}
		}
		measured.modes[mode] = summarize(samples);
		results.current = measured;
		save();
	}
	results.cases.push(measured);
	delete results.current;
	save();
	if (realDiff) {
		await context.page.evaluate(measured => {
			let card = document.getElementById('markdown-hunt-result');
			if (!card) {
				card = document.createElement('pre');
				card.id = 'markdown-hunt-result';
				card.style.cssText = 'position:fixed;right:40px;top:65px;z-index:10000;padding:18px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-focusBorder);font:15px monospace;white-space:pre-wrap;max-width:570px';
				document.querySelector('.monaco-workbench').appendChild(card);
			}
			card.textContent = [
				'MEASURED BUILT-IN MARKDOWN DIFF HANDLER',
				`${measured.count.toLocaleString()} paragraphs; ${(measured.inputBytes / 1024).toFixed(0)} KiB input`,
				'Production handler; exact text/markers verified',
				'1 warmup + 5 samples (not end-to-end opening latency)',
				`Same content, no markers: ${measured.modes.unchanged.medianMs.toFixed(1)} ms median`,
				`Same content, added lines: ${measured.modes.added.medianMs.toFixed(1)} ms median`,
				`Worst marked update: ${measured.modes.added.worstMs.toFixed(1)} ms`,
				'Expected: renderer work below 200 ms'
			].join('\n');
		}, measured);
	}
	return measured;
}

module.exports = {
	id: realDiff ? 'w2-markdown-rendered-diff' : 'w2-markdown-preview-probe',
	title: realDiff ? 'Rendered Markdown diff should not scan all elements for every added line' : 'Built-in Markdown preview large-document handler scaling',
	workspacePath,
	stepPauseMs: realDiff || process.env.MARKDOWN_HUNT_CARD === '1' ? 500 : 100,
	extraArgs: ['--disable-workspace-trust', `--extensionDevelopmentPath=${path.join(__dirname, 'fixture')}`],
	userSettings: {
		'workbench.startupEditor': 'none',
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'workbench.enableExperiments': false,
		'markdown.validate.enabled': false,
		'markdown.preview.scrollEditorWithPreview': false,
		'markdown.preview.scrollPreviewWithEditor': false,
		'git.enabled': false
	},
	steps: [
		{
			id: 'baseline',
			title: 'Verify built-in preview and exact text/line-marker state on a small document',
			async run(context) {
				results.environment = await context.page.evaluate(() => ({ userAgent: navigator.userAgent, location: location.href }));
				const result = await measure(context, sizes[0]);
				return `Baseline ${result.count} paragraphs: all text and marker checks passed.`;
			}
		},
		{
			id: 'scaling',
			title: 'Measure same-content update and scroll controls, one warmup plus five samples',
			async run(context) {
				for (const count of sizes.slice(1)) {
					await measure(context, count);
				}
				return results.cases.map(x => `${x.count}: unchanged ${x.modes.unchanged.medianMs.toFixed(1)} ms; added ${x.modes.added.medianMs.toFixed(1)} ms${x.modes.scroll ? `; scroll ${x.modes.scroll.medianMs.toFixed(1)} ms` : ''}`).join('; ');
			}
		},
		{
			id: 'expected-budget',
			title: 'Preview update handlers should remain under the 200 ms blocking budget',
			async run() {
				const worst = Math.max(...results.cases.map(x => x.modes.added.medianMs));
				assert.ok(worst < 200, `Added-line handler median ${worst.toFixed(1)} ms exceeds 200 ms; raw exact-state controls: ${outputPath}`);
				return 'No high-impact diff-marker stall reproduced at tested sizes.';
			}
		}
	]
};
