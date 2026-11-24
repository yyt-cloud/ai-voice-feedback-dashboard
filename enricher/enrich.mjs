import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dataPath = path.join(root, 'comments.json');
const apiKey = process.env.DEEPSEEK_API_KEY;
const apiBase = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const batchSize = Math.max(1, Math.min(20, Number(process.env.ENRICH_BATCH_SIZE || 10)));

if (!apiKey) {
  console.log('DEEPSEEK_API_KEY is not configured; enrichment skipped.');
  process.exit(0);
}

const taxonomy = [
  ['一、语音输入与转写', '1.1 识别准确率', '1.1.2 混杂语言与方言'],
  ['一、语音输入与转写', '1.2 声学环境适应', '1.2.1 降噪与耳语'],
  ['一、语音输入与转写', '1.3 上屏时延', '1.3.1 流式出字速度'],
  ['二、AI润色与文本处理', '2.1 口语化清理', '2.1.1 语气词与废话消除'],
  ['二、AI润色与文本处理', '2.1 口语化清理', '2.1.2 自动排版与结构化'],
  ['二、AI润色与文本处理', '2.2 语音指令控制', '2.2.1 实时编辑指令'],
  ['二、AI润色与文本处理', '2.2 语音指令控制', '2.2.2 语气风格切换与过度重写'],
  ['二、AI润色与文本处理', '2.3 翻译与多语言', '2.3.1 跨语言翻译与语境转换'],
  ['二、AI润色与文本处理', '2.4 个性化定制', '2.4.1 自定义热词与专有词库'],
  ['二、AI润色与文本处理', '2.4 个性化定制', '2.4.2 上下文记忆与屏幕感知'],
  ['三、软件交互与性能', '3.1 跨应用兼容', '3.1.1 界面交互与输入体验'],
  ['三、软件交互与性能', '3.1 跨应用兼容', '3.1.2 系统权限与无障碍冲突'],
  ['三、软件交互与性能', '3.1 跨应用兼容', '3.1.3 跨平台与特定设备适应'],
  ['三、软件交互与性能', '3.2 设备与性能占用', '3.2.2 系统资源占用与卡顿'],
  ['三、软件交互与性能', '3.3 隐私与离线', '3.3.1 离线与端侧识别需求'],
  ['四、付费订阅与服务', '4.1 价格与套餐', '4.1.1 免费额度与试用限制'],
  ['四、付费订阅与服务', '4.1 价格与套餐', '4.1.2 订阅定价与扣费争议']
];
const allowedPaths = new Set(taxonomy.map(parts => parts.join('\u0001')));
const sentiments = new Set(['Positive', 'Neutral', 'Negative']);
const labels = { Positive: '正向好评', Neutral: '中立讨论', Negative: '负面/痛点' };

const payload = JSON.parse(await readFile(dataPath, 'utf8'));
const needsEnrichment = record => !record.content_translation || !record.enrichment_sha256 ||
  record.enrichment_sha256 !== record.raw_sha256 || record.category_lvl1 === '待分类';
const pending = payload.records.filter(needsEnrichment);

function validate(result, source) {
  if (!result || result.id !== source.id) throw new Error(`Mismatched result id for ${source.id}`);
  const sentiment = sentiments.has(result.sentiment) ? result.sentiment : source.sentiment;
  const translation = String(result.content_translation || '').trim();
  const summary = String(result.summary || '').trim();
  const tag = String(result.tag || '').trim();
  if (!translation || !summary || !tag) throw new Error(`Incomplete enrichment for ${source.id}`);
  const categories = [result.category_lvl1, result.category_lvl2, result.category_lvl3].map(value => String(value || '').trim());
  const generic = categories.every(value => value === '');
  if (!generic && !allowedPaths.has(categories.join('\u0001'))) throw new Error(`Invalid taxonomy for ${source.id}`);
  return {
    content_translation: translation,
    sentiment,
    sentimentLabel: labels[sentiment],
    tag,
    category_lvl1: categories[0],
    category_lvl2: categories[1],
    category_lvl3: categories[2],
    summary,
    enrichment_provider: 'deepseek',
    enrichment_model: model,
    enrichment_sha256: source.raw_sha256,
    enriched_at: new Date().toISOString()
  };
}

async function enrichBatch(records, attempt = 1) {
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `你是AI语音产品评论分析器。只返回JSON对象，格式为{"records":[...] }。每条必须包含 id、content_translation、sentiment、tag、category_lvl1、category_lvl2、category_lvl3、summary。sentiment只能为Positive/Neutral/Negative。翻译必须忠实，不添加原文没有的信息。summary和tag必须简洁且基于原文。三级分类只能从下列完整路径中选择；若评论只是good app、great、very bad等无具体功能细节的泛评，三级分类全部返回空字符串。分类路径：${JSON.stringify(taxonomy)}`
        },
        {
          role: 'user',
          content: JSON.stringify(records.map(({ id, product, platform, rating, content_original }) => ({ id, product, platform, rating, content_original })))
        }
      ]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, attempt * 3000));
      return enrichBatch(records, attempt + 1);
    }
    throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
  if (!Array.isArray(parsed.records) || parsed.records.length !== records.length) throw new Error('DeepSeek returned an incomplete batch');
  return parsed.records;
}

console.log(`Enriching ${pending.length} of ${payload.records.length} verified records.`);
for (let offset = 0; offset < pending.length; offset += batchSize) {
  const batch = pending.slice(offset, offset + batchSize);
  const results = await enrichBatch(batch);
  const byId = new Map(results.map(result => [result.id, result]));
  for (const source of batch) Object.assign(source, validate(byId.get(source.id), source));
  await writeFile(dataPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Enriched ${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
}

