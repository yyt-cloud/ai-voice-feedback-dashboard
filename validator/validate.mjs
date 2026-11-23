import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const input = JSON.parse(await readFile(path.join(root, 'data/collected.json'), 'utf8'));
const required = ['source', 'source_id', 'product', 'platform', 'author', 'published_at', 'content_original', 'fetched_at', 'raw_sha256', 'evidence_ref', 'url'];
const hosts = {
  'Google Play': new Set(['play.google.com']),
  'App Store': new Set(['apps.apple.com', 'itunes.apple.com']),
  'Product Hunt': new Set(['www.producthunt.com', 'producthunt.com']),
  'X (Twitter)': new Set(['x.com', 'www.x.com']),
  Reddit: new Set(['reddit.com', 'www.reddit.com']),
  'Hacker News': new Set(['news.ycombinator.com'])
};
const seenIds = new Set();
const seenContent = new Set();
const verified = [];
const rejected = [];

for (const record of input.records || []) {
  const reasons = [];
  for (const field of required) if (!String(record[field] ?? '').trim()) reasons.push(`missing:${field}`);
  if (!/^[a-f0-9]{64}$/i.test(record.raw_sha256 || '')) reasons.push('invalid:raw_sha256');
  if (record.verification_status !== 'official_api_verified') reasons.push('invalid:verification_status');
  try {
    const hostname = new URL(record.url).hostname;
    if (!hosts[record.platform]?.has(hostname)) reasons.push('invalid:source_host');
  } catch { reasons.push('invalid:url'); }
  const compoundId = `${record.source}:${record.source_id}`;
  if (seenIds.has(compoundId)) reasons.push('duplicate:source_id');
  seenIds.add(compoundId);
  const contentHash = createHash('sha256').update(record.content_original.trim().toLowerCase()).digest('hex');
  if (seenContent.has(`${record.product}:${contentHash}`)) reasons.push('duplicate:content');
  seenContent.add(`${record.product}:${contentHash}`);
  try {
    const raw = JSON.parse(await readFile(path.join(root, record.evidence_ref), 'utf8'));
    const actualHash = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    if (actualHash !== record.raw_sha256) reasons.push('mismatch:evidence_hash');
  } catch { reasons.push('missing:evidence_file'); }
  if (reasons.length) rejected.push({ record, reasons });
  else verified.push(record);
}

await mkdir(path.join(root, 'data/rejected'), { recursive: true });
await writeFile(path.join(root, 'data/rejected/latest.json'), JSON.stringify(rejected, null, 2) + '\n');
const output = { schema_version: '1.0', generated_at: input.generated_at, record_count: verified.length, rejected_count: rejected.length, records: verified };
await writeFile(path.join(root, 'comments.json'), JSON.stringify(output, null, 2) + '\n');
console.log(`Verified ${verified.length}; rejected ${rejected.length}.`);
