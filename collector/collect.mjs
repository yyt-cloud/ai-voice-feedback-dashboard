import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import gplay from 'google-play-scraper';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'config/products.json'), 'utf8'));
const fetchedAt = new Date().toISOString();
const runId = fetchedAt.replace(/[:.]/g, '-');
const rawDir = path.join(root, 'data/raw', runId);
await mkdir(rawDir, { recursive: true });

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanText = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const iso = value => new Date(value).toISOString();
const records = [];
const pending = [];

async function saveEvidence(source, id, raw) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const relative = `data/raw/${runId}/${source}-${safeId}.json`;
  await writeFile(path.join(root, relative), JSON.stringify(raw, null, 2) + '\n');
  return relative;
}

for (const app of config.google_play) {
  for (const country of app.countries) {
    for (const lang of app.languages) {
      const result = await gplay.reviews({
        appId: app.app_id,
        sort: gplay.sort.NEWEST,
        num: 200,
        country,
        lang
      });
      for (const review of result.data || []) {
        const sourceId = String(review.id || '');
        if (!sourceId || !cleanText(review.text)) continue;
        const evidenceRef = await saveEvidence('google-play', sourceId, review);
        records.push({
          source: 'google_play',
          source_id: sourceId,
          product_id: app.app_id,
          product: app.product,
          platform: 'Google Play',
          context: `Google Play Store official review (${country.toUpperCase()})`,
          author: cleanText(review.userName) || 'Google Play user',
          published_at: iso(review.date),
          date: iso(review.date).replace('T', ' ').slice(0, 16),
          rating: Number(review.score),
          content_original: cleanText(review.text),
          content_translation: '',
          sentiment: Number(review.score) >= 4 ? 'Positive' : Number(review.score) <= 2 ? 'Negative' : 'Neutral',
          sentimentLabel: Number(review.score) >= 4 ? '正向好评' : Number(review.score) <= 2 ? '负面/痛点' : '中立讨论',
          tag: '待证据化分类',
          category_lvl1: '待分类',
          category_lvl2: '待分类',
          category_lvl3: '待分类',
          fetched_at: fetchedAt,
          raw_sha256: sha256(review),
          evidence_ref: evidenceRef,
          verification_status: 'official_api_verified',
          risk_status: 'Verified',
          risk_label: '官方商店响应已留证',
          url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.app_id)}&reviewId=${encodeURIComponent(sourceId)}`,
          id: `GP-${sourceId}`
        });
      }
    }
  }
}

for (const app of config.app_store || []) {
  for (const country of app.countries) {
    for (let page = 1; page <= 10; page += 1) {
      const endpoint = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${app.app_id}/sortby=mostrecent/json`;
      const response = await fetch(endpoint);
      if (response.status === 404) break;
      if (!response.ok) throw new Error(`App Store reviews failed for ${app.product}/${country}: ${response.status}`);
      const payload = await response.json();
      const entries = Array.isArray(payload.feed?.entry) ? payload.feed.entry : [];
      if (entries.length === 0) break;
      for (const review of entries) {
        if (!review['im:rating']) continue;
        const sourceId = cleanText(review.id?.label);
        const text = cleanText(review.content?.label);
        if (!sourceId || !text) continue;
        const evidenceRef = await saveEvidence('app-store', `${country}-${sourceId}`, review);
        const rating = Number(review['im:rating']?.label);
        records.push({
          source: 'app_store', source_id: sourceId, product_id: app.app_id,
          bundle_id: app.bundle_id, product: app.product, platform: 'App Store',
          context: `Apple App Store official customer review (${country.toUpperCase()})`,
          author: cleanText(review.author?.name?.label) || 'App Store user',
          published_at: iso(review.updated?.label), date: iso(review.updated?.label).replace('T', ' ').slice(0, 16),
          updated_at: iso(review.updated?.label), rating,
          app_version: cleanText(review['im:version']?.label), country,
          content_original: text, content_translation: '',
          sentiment: rating >= 4 ? 'Positive' : rating <= 2 ? 'Negative' : 'Neutral',
          sentimentLabel: rating >= 4 ? '正向好评' : rating <= 2 ? '负面/痛点' : '中立讨论',
          tag: '待证据化分类', category_lvl1: '待分类', category_lvl2: '待分类', category_lvl3: '待分类',
          fetched_at: fetchedAt, raw_sha256: sha256(review), evidence_ref: evidenceRef,
          verification_status: 'official_api_verified', risk_status: 'Verified',
          risk_label: 'Apple 官方评论响应已留证',
          url: cleanText(review.link?.attributes?.href) || `https://apps.apple.com/${country}/app/id${app.app_id}`,
          id: `AS-${country}-${sourceId}`
        });
      }
    }
  }
}

if (process.env.PRODUCT_HUNT_TOKEN) {
  const query = `query VerifiedComments($slug: String!) {
    post(slug: $slug) {
      id slug url
      makers { id username }
      comments(first: 100) {
        edges { node { id body createdAt votesCount user { id username name } } }
      }
    }
  }`;
  for (const item of config.product_hunt || []) {
    const response = await fetch('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PRODUCT_HUNT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { slug: item.slug } })
    });
    if (!response.ok) throw new Error(`Product Hunt API failed for ${item.product}: ${response.status}`);
    const payload = await response.json();
    if (payload.errors) throw new Error(`Product Hunt GraphQL error for ${item.product}: ${JSON.stringify(payload.errors)}`);
    const post = payload.data?.post;
    if (!post) continue;
    const makerIds = new Set((post.makers || []).map(maker => String(maker?.id || '')));
    for (const edge of post.comments?.edges || []) {
      const comment = edge.node;
      const sourceId = String(comment?.id || '');
      const text = cleanText(comment?.body);
      const authorId = String(comment?.user?.id || '');
      if (!sourceId || !text || !authorId || makerIds.has(authorId)) continue;
      const evidence = { post_id: post.id, post_slug: post.slug, comment };
      const evidenceRef = await saveEvidence('product-hunt', sourceId, evidence);
      records.push({
        source: 'product_hunt', source_id: sourceId, product_id: String(post.id), product: item.product,
        platform: 'Product Hunt', context: 'Product Hunt official GraphQL user comment',
        author_id: authorId, author: cleanText(comment.user?.name || comment.user?.username) || 'Product Hunt user',
        published_at: iso(comment.createdAt), date: iso(comment.createdAt).replace('T', ' ').slice(0, 16),
        rating: null, content_original: text, content_translation: '', sentiment: 'Unclassified', sentimentLabel: '待分类',
        tag: '待证据化分类', category_lvl1: '待分类', category_lvl2: '待分类', category_lvl3: '待分类',
        fetched_at: fetchedAt, raw_sha256: sha256(evidence), evidence_ref: evidenceRef,
        verification_status: 'official_api_verified', risk_status: 'Verified',
        risk_label: 'Product Hunt 官方用户评论响应已留证',
        url: `${post.url || `https://www.producthunt.com/posts/${item.slug}`}#comment-${sourceId}`,
        id: `PH-${sourceId}`
      });
    }
  }
}

if (process.env.X_BEARER_TOKEN) {
  for (const item of config.x || []) {
    const endpoint = new URL('https://api.x.com/2/tweets/search/recent');
    endpoint.searchParams.set('query', `${item.query} -is:retweet`);
    endpoint.searchParams.set('max_results', '100');
    endpoint.searchParams.set('tweet.fields', 'author_id,created_at,lang,public_metrics,conversation_id');
    endpoint.searchParams.set('expansions', 'author_id');
    endpoint.searchParams.set('user.fields', 'id,name,username,verified');
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
    if (!response.ok) throw new Error(`X API failed for ${item.product}: ${response.status}`);
    const payload = await response.json();
    const users = new Map((payload.includes?.users || []).map(user => [String(user.id), user]));
    const official = new Set((item.official_usernames || []).map(name => name.toLowerCase()));
    for (const tweet of payload.data || []) {
      const user = users.get(String(tweet.author_id));
      if (!tweet.id || !cleanText(tweet.text) || official.has(String(user?.username || '').toLowerCase())) continue;
      const evidence = { tweet, user };
      const evidenceRef = await saveEvidence('x', tweet.id, evidence);
      records.push({
        source: 'x', source_id: String(tweet.id), product_id: item.product, product: item.product,
        platform: 'X (Twitter)', context: 'X API v2 original public user post',
        author_id: String(tweet.author_id), author: cleanText(user?.username || user?.name) || 'X user',
        published_at: iso(tweet.created_at), date: iso(tweet.created_at).replace('T', ' ').slice(0, 16),
        rating: null, content_original: cleanText(tweet.text), content_translation: '',
        sentiment: 'Unclassified', sentimentLabel: '待分类', tag: '待证据化分类',
        category_lvl1: '待分类', category_lvl2: '待分类', category_lvl3: '待分类',
        fetched_at: fetchedAt, raw_sha256: sha256(evidence), evidence_ref: evidenceRef,
        verification_status: 'official_api_verified', risk_status: 'Verified',
        risk_label: 'X API v2 原创公开帖子已留证',
        url: `https://x.com/${encodeURIComponent(user?.username || 'i')}/status/${tweet.id}`,
        id: `X-${tweet.id}`
      });
    }
  }
}

for (const product of config.hacker_news) {
  const endpoint = new URL('https://hn.algolia.com/api/v1/search_by_date');
  endpoint.searchParams.set('query', product);
  endpoint.searchParams.set('tags', 'comment');
  endpoint.searchParams.set('hitsPerPage', '100');
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`Hacker News API failed for ${product}: ${response.status}`);
  const payload = await response.json();
  for (const hit of payload.hits || []) {
    const text = cleanText(hit.comment_text);
    const sourceId = String(hit.objectID || '');
    if (!sourceId || !text || !text.toLowerCase().includes(product.toLowerCase())) continue;
    const evidenceRef = await saveEvidence('hacker-news', sourceId, hit);
    pending.push({
      source: 'hacker_news',
      source_id: sourceId,
      product_id: product,
      product,
      platform: 'Hacker News',
      context: 'Hacker News official Algolia API comment',
      author: cleanText(hit.author) || 'Hacker News user',
      published_at: iso(hit.created_at),
      date: iso(hit.created_at).replace('T', ' ').slice(0, 16),
      rating: null,
      content_original: text,
      content_translation: '',
      sentiment: 'Unclassified',
      sentimentLabel: '待分类',
      tag: '待证据化分类',
      category_lvl1: '待分类',
      category_lvl2: '待分类',
      category_lvl3: '待分类',
      fetched_at: fetchedAt,
      raw_sha256: sha256(hit),
      evidence_ref: evidenceRef,
      verification_status: 'public_api_candidate',
      risk_status: 'Pending',
      risk_label: 'API 原文已留证，产品相关性待人工复核',
      url: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.story_id || sourceId)}`,
      id: `HN-${sourceId}`
    });
  }
}

if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const tokenResponse = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': process.env.REDDIT_USER_AGENT || 'voice-feedback-verifier/1.0'
    },
    body: 'grant_type=client_credentials'
  });
  if (!tokenResponse.ok) throw new Error(`Reddit OAuth failed: ${tokenResponse.status}`);
  const { access_token: token } = await tokenResponse.json();
  for (const product of config.reddit) {
    const endpoint = new URL('https://oauth.reddit.com/search');
    endpoint.searchParams.set('q', `\"${product}\"`);
    endpoint.searchParams.set('sort', 'new');
    endpoint.searchParams.set('limit', '100');
    endpoint.searchParams.set('restrict_sr', 'false');
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': process.env.REDDIT_USER_AGENT || 'voice-feedback-verifier/1.0'
      }
    });
    if (!response.ok) throw new Error(`Reddit API failed for ${product}: ${response.status}`);
    const payload = await response.json();
    for (const child of payload.data?.children || []) {
      const post = child.data;
      const text = cleanText(`${post.title || ''}\n${post.selftext || ''}`);
      if (!post.id || !text || !text.toLowerCase().includes(product.toLowerCase())) continue;
      const evidenceRef = await saveEvidence('reddit', post.id, post);
      pending.push({
        source: 'reddit', source_id: String(post.id), product_id: product, product,
        platform: 'Reddit', context: `Reddit r/${post.subreddit} official API post`,
        author: cleanText(post.author) || 'Reddit user', published_at: iso(post.created_utc * 1000),
        date: iso(post.created_utc * 1000).replace('T', ' ').slice(0, 16), rating: null,
        content_original: text, content_translation: '', sentiment: 'Unclassified', sentimentLabel: '待分类',
        tag: '待证据化分类', category_lvl1: '待分类', category_lvl2: '待分类', category_lvl3: '待分类',
        fetched_at: fetchedAt, raw_sha256: sha256(post), evidence_ref: evidenceRef,
        verification_status: 'public_api_candidate', risk_status: 'Pending', risk_label: '官方 API 原文已留证，产品相关性待人工复核',
        url: `https://www.reddit.com${post.permalink}`, id: `RD-${post.id}`
      });
    }
  }
}

await writeFile(path.join(root, 'data/collected.json'), JSON.stringify({ schema_version: '1.0', generated_at: fetchedAt, records }, null, 2) + '\n');
await writeFile(path.join(root, 'data/pending-review.json'), JSON.stringify({ schema_version: '1.0', generated_at: fetchedAt, records: pending }, null, 2) + '\n');
console.log(`Collected ${records.length} official-product records; ${pending.length} public-API candidates require product relevance review.`);
