/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
process.env.MARKDOWN_HUNT_REAL_DIFF = '0';
process.env.MARKDOWN_HUNT_SIZES = '100,8000,16000';
process.env.MARKDOWN_HUNT_CARD = '1';
module.exports = require('./preview-probe.cjs');
