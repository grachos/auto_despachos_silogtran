// Vercel Hobby allows at most 12 serverless functions per deployment (each .js under api/ is one).
// Run before pushing: npm run check:functions
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk('api').filter((f) => f.endsWith('.js'));
console.log(`${files.length} serverless functions (limit 12):\n  ${files.join('\n  ')}`);
if (files.length > 12) { console.error('Too many functions for the Hobby plan: merge routes behind a dispatcher.'); process.exit(1); }
