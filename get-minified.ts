import fs from 'fs';
import path from 'path';
import { minifyGTMToString } from './frontend/packages/shared/src/utils/gtm-minifier.js';
import { cleanGtmJsonString } from './frontend/packages/shared/src/utils/clean-json.js';

const containerPath = path.resolve('./data/GTM-T5MTQWP_workspace580 (11 Apr 2026).json');
const rawContent = fs.readFileSync(containerPath, 'utf-8');
const cleanJson = cleanGtmJsonString(rawContent);
const minified = minifyGTMToString(cleanJson);

const outputPath = path.resolve('./data/container-minified.json');
fs.writeFileSync(outputPath, minified, 'utf-8');
console.log(`✅ Minified container written to ${outputPath}`);
