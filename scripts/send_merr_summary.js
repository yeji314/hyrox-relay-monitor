#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const RESULT_FILE = path.join(__dirname, '..', 'logs', 'merr-blog-latest.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SLACK_WEBHOOK_URL = process.env.MERR_SLACK_WEBHOOK_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function truncate(text, maxLength) {
  const value = (text || '').trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function buildPrompt(data) {
  const post = data.post || {};
  const informativeComments = (data.comments?.informative || []).slice(0, 8);
  const sourceList = (post.sources || [])
    .slice(0, 12)
    .map((source, index) => `${index + 1}. ${source.text || source.href} - ${source.href}`)
    .join('\n');
  const commentList = informativeComments
    .map(
      (comment, index) =>
        `${index + 1}. ${comment.userName}: ${comment.contents} (공감 ${comment.sympathyCount}, 답글 ${comment.replyCount})`
    )
    .join('\n');

  return [
    '아래는 네이버 블로그 새 글과 댓글 요약 데이터입니다.',
    '이 내용을 바탕으로 한국어 Slack 메시지 하나만 작성하세요.',
    '반드시 다음 섹션을 포함하세요: 제목/날짜, 핵심 요약, 사실확인, 댓글 포인트, 산업/종목군 메모.',
    '사실확인 섹션에서는 웹 검색을 사용해 핵심 주장 2~4개를 검증하고, 각 bullet마다 클릭 가능한 URL을 포함하세요.',
    '댓글 포인트 섹션에서는 정보성 댓글만 2~4개 반영하고, 단순 감사/감탄 표현은 제외하세요.',
    '산업/종목군 메모는 정보 제공 목적이라는 점을 분명히 하고, 개인화 투자 조언처럼 쓰지 마세요.',
    'Slack에 바로 붙여넣을 수 있게 간결한 bullet 위주로 작성하세요.',
    '',
    `블로그 제목: ${post.title || data.latestTitle || ''}`,
    `블로그 날짜: ${post.dateLabel || post.publishedAt || data.latestPublishedAt || ''}`,
    `블로그 링크: ${post.link || data.latestLink || ''}`,
    `블로그 카테고리: ${post.category || ''}`,
    '',
    '본문 요약용 원문:',
    truncate(post.contentText || post.description || '', 12000),
    '',
    '블로그 본문에 포함된 출처 링크:',
    sourceList || '없음',
    '',
    '정보성 댓글 후보:',
    commentList || '없음',
  ].join('\n');
}

async function createSummary(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error('Missing GitHub Actions secret: OPENAI_API_KEY');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      input: prompt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI Responses API failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const message = Array.isArray(data.output)
    ? data.output.find((item) => item.type === 'message')
    : null;
  const textPart = Array.isArray(message?.content)
    ? message.content.find((item) => item.type === 'output_text' || item.type === 'text')
    : null;
  const summaryText = textPart?.text || data.output_text;

  if (!summaryText) {
    throw new Error('OpenAI response did not include summary text.');
  }

  const annotations = Array.isArray(textPart?.annotations) ? textPart.annotations : [];
  const citations = [];
  const seen = new Set();

  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation' || !annotation.url) {
      continue;
    }
    if (seen.has(annotation.url)) {
      continue;
    }
    seen.add(annotation.url);
    citations.push(`- ${annotation.title || annotation.url}: ${annotation.url}`);
  }

  if (!citations.length) {
    return summaryText.trim();
  }

  return `${summaryText.trim()}\n\n출처 링크\n${citations.join('\n')}`;
}

async function sendSlackMessage(text) {
  if (!SLACK_WEBHOOK_URL) {
    throw new Error('Missing GitHub Actions secret: MERR_SLACK_WEBHOOK_URL');
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed: ${response.status} ${body}`);
  }
}

async function main() {
  const result = loadJson(RESULT_FILE);
  if (!result.hasNewPost) {
    console.log('No new post to summarize.');
    return;
  }

  const summary = await createSummary(buildPrompt(result));
  await sendSlackMessage(summary);
  console.log('Sent Merr blog summary to Slack.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
