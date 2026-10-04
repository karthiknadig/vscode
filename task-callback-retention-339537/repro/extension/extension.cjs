/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const v8 = require('node:v8');
const assert = require('node:assert/strict');

const root = path.dirname(__dirname);
const type = 'terminalLifetimeProbe';
const payloadBytes = 2 * 1024 * 1024;
const payloadRefs = [];

function save(name, value) {
	const runId = vscode.workspace.getConfiguration('terminalTaskPerf').get('runId');
	const target = path.join(root, `run-${runId}-${name}.json`);
	fs.writeFileSync(target, JSON.stringify(value, null, 2));
	return target;
}

async function collect() {
	await new Promise(resolve => setImmediate(resolve));
	const session = new inspector.Session();
	session.connect();
	try {
		for (let i = 0; i < 2; i++) {
			await new Promise((resolve, reject) => session.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
			await new Promise(resolve => setImmediate(resolve));
		}
	} finally {
		session.disconnect();
	}
	let livePayloadBytes = 0;
	let livePayloads = 0;
	for (const ref of payloadRefs) {
		const payload = ref.deref();
		if (payload) {
			livePayloadBytes += payload.byteLength;
			livePayloads++;
		}
	}
	return {
		...process.memoryUsage(),
		livePayloads,
		livePayloadBytes,
		activeTasks: vscode.tasks.taskExecutions.length,
		terminals: vscode.window.terminals.length
	};
}

function createTask(cycle, bytes) {
	const retainedPayload = Buffer.alloc(bytes, 65 + (payloadRefs.length % 26));
	payloadRefs.push(new WeakRef(retainedPayload));
	const execution = new vscode.CustomExecution(async () => {
		const writes = new vscode.EventEmitter();
		const closes = new vscode.EventEmitter();
		const close = () => {
			writes.dispose();
			closes.dispose();
		};
		return {
			onDidWrite: writes.event,
			onDidClose: closes.event,
			open() {
				writes.fire(`Fixture byte: ${retainedPayload[0]}\r\n`);
				closes.fire(0);
				close();
			},
			close
		};
	});
	return new vscode.Task({ type, cycle }, vscode.TaskScope.Workspace, cycle, 'Terminal Lifetime Fixture', execution);
}

async function providerCycle(cycle, fetch, bytes) {
	const task = createTask(cycle, bytes);
	const registration = vscode.tasks.registerTaskProvider(type, {
		provideTasks: () => [task],
		resolveTask: value => value
	});
	try {
		if (fetch) {
			const tasks = await vscode.tasks.fetchTasks({ type });
			assert.deepStrictEqual(tasks.map(value => ({ cycle: value.definition.cycle, custom: value.execution instanceof vscode.CustomExecution })), [
				{ cycle, custom: true }
			]);
		}
	} finally {
		registration.dispose();
	}
	const after = await vscode.tasks.fetchTasks({ type });
	assert.deepStrictEqual(after.map(value => value.name), [], 'Unregistered provider must not expose tasks');
}

async function measure() {
	const result = {
		pid: process.pid,
		version: vscode.version,
		node: process.version,
		input: { payloadBytes, samples: 5, warmup: 1, fixture: 'CustomExecution captures one 2 MiB Buffer; tasks are never executed' },
		control: [],
		reusedId: [],
		fetched: []
	};
	for (const [name, fetch] of [['control', false], ['reusedId', true], ['fetched', true]]) {
		await providerCycle(name === 'reusedId' ? 'stable-id' : `${name}-warmup`, fetch, payloadBytes);
		result[`${name}Baseline`] = await collect();
		for (let cycle = 0; cycle < 5; cycle++) {
			const started = performance.now();
			await providerCycle(name === 'reusedId' ? 'stable-id' : `${name}-${cycle}`, fetch, payloadBytes);
			const memory = await collect();
			result[name].push({ cycle, elapsedMs: performance.now() - started, ...memory });
		}
	}
	for (const name of ['control', 'reusedId', 'fetched']) {
		const baseline = result[`${name}Baseline`];
		const last = result[name].at(-1);
		result[`${name}Delta`] = {
			arrayBuffers: last.arrayBuffers - baseline.arrayBuffers,
			external: last.external - baseline.external,
			heapUsed: last.heapUsed - baseline.heapUsed,
			livePayloads: last.livePayloads - baseline.livePayloads,
			livePayloadBytes: last.livePayloadBytes - baseline.livePayloadBytes
		};
	}
	if (vscode.workspace.getConfiguration('terminalTaskPerf').get('captureHeap')) {
		const runId = vscode.workspace.getConfiguration('terminalTaskPerf').get('runId');
		result.heapSnapshot = v8.writeHeapSnapshot(path.join(root, `run-${runId}-extension-host.heapsnapshot`));
	}
	save('metrics', result);
	return result;
}

exports.activate = context => {
	context.subscriptions.push(vscode.commands.registerCommand('terminalTaskPerf.baseline', async () => {
		try {
			await providerCycle('baseline', true, 1);
			const state = await collect();
			assert.deepStrictEqual({ tasks: state.activeTasks, terminals: state.terminals }, { tasks: 0, terminals: 0 });
			save('baseline', { ok: true, pid: process.pid, version: vscode.version, state });
		} catch (error) {
			save('error', { phase: 'baseline', message: error.message, stack: error.stack });
			throw error;
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('terminalTaskPerf.measure', async () => {
		try {
			return await measure();
		} catch (error) {
			save('error', { phase: 'measure', message: error.message, stack: error.stack });
			throw error;
		}
	}));
};
