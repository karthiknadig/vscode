/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = 'Q:\\GIT\\vscode';
const { VSBuffer } = await import(pathToFileURL(path.join(root, 'out', 'vs', 'base', 'common', 'buffer.js')).href);
const { compressOutputItemStreams } = await import(pathToFileURL(path.join(root, 'out', 'vs', 'workbench', 'contrib', 'notebook', 'common', 'notebookCommon.js')).href);
const { compressOutputItemStreams: compressFixed } = await import(pathToFileURL(path.join('Q:\\GIT\\vscode.worktrees\\perf-fixes-5be74984', 'out', 'vs', 'workbench', 'contrib', 'notebook', 'common', 'notebookCommon.js')).href);

const alphabet = ['a', 'b', '\r', '\n', '\b', '$', '\u2028', '\u2029'];
let comparisons = 0;
for (let length = 0; length <= 6; length++) {
	for (let value = 0; value < alphabet.length ** length; value++) {
		let remaining = value;
		let input = '';
		for (let index = 0; index < length; index++) {
			input += alphabet[remaining % alphabet.length];
			remaining = Math.floor(remaining / alphabet.length);
		}
		const bytes = VSBuffer.fromString(input).buffer;
		const actual = compressFixed([bytes]);
		const expected = compressOutputItemStreams([bytes]);
		assert.deepEqual(
			{ text: actual.data.toString(), didCompression: actual.didCompression },
			{ text: expected.data.toString(), didCompression: expected.didCompression },
			JSON.stringify(input)
		);
		comparisons++;
	}
}
console.log(JSON.stringify({ comparisons, result: 'all fixed outputs and compression flags match the baseline' }));
