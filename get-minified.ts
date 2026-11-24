import fs from 'fs';
import path from 'path';
import { minifyGTMToString } from './frontend/packages/shared/src/utils/gtm-minifier.ts';
import { cleanGtmJsonString } from './frontend/packages/shared/src/utils/clean-json.ts';

const DEFAULT_INPUT = './data/GTM-T5MTQWP_workspace580 (11 Apr 2026).json';
const DEFAULT_OUTPUT = './data/container-minified.json';

const inputArg = process.argv[2] || DEFAULT_INPUT;
const outputArg = process.argv[3] || DEFAULT_OUTPUT;

const containerPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg);

const rawContent = fs.readFileSync(containerPath, 'utf-8');
const cleanJson = cleanGtmJsonString(rawContent);
const minified = minifyGTMToString(cleanJson);

fs.writeFileSync(outputPath, minified, 'utf-8');
console.log(`Minified container written to ${outputPath} (${(minified.length / 1024).toFixed(1)} KB)`);
