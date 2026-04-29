#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RSS_URL = 'https://rss.blog.naver.com/ranto28.xml';
const STATE_FILE = path.join(__dirname, '..', 'logs', 'merr-blog-state.json');
const RESULT_FILE = path.join(__dirname, '..', 'logs', 'merr-blog-latest.json');

function normalize(text) {
  return (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(text) {
  return (text || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(text) {
  return normalize(
    decodeHtml(text)
      .replace(/<img[^>]*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseLatestRssItem(xml) {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) {
    throw new Error('No RSS items found.');
  }

  const itemXml = itemMatch[1];
  const extract = (tag) => {
    const match = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? decodeHtml(match[1]) : '';
  };

  const link = extract('link').replace(/\?fromRss=true.*$/, '');
  const mobileLink = link.replace('https://blog.naver.com/', 'https://m.blog.naver.com/');

  return {
    title: normalize(extract('title')),
    category: normalize(extract('category')),
    link,
    mobileLink,
    guid: normalize(extract('guid')),
    description: stripHtml(extract('description')),
    publishedAt: normalize(extract('pubDate')),
  };
}

function pickInformativeComments(commentList) {
  const trivialPattern =
    /(감사|잘 읽|좋은 글|유익|항상 감사|늘 감사|최고예요|최고입니다|좋네요|멋지네요|배우고 갑니다|화이팅|존경|👍|^^|ㅎㅎ|ㅋㅋ)/;

  return commentList
    .map((comment) => ({
      userName: normalize(comment.userName),
      contents: normalize(comment.contents),
      sympathyCount: comment.sympathyCount || 0,
      replyCount: comment.replyCount || 0,
      regTime: comment.regTime || null,
    }))
    .filter((comment) => {
      if (!comment.contents) {
        return false;
      }
      if (comment.contents.length >= 45) {
        return true;
      }
      if (comment.sympathyCount >= 2 && comment.contents.length >= 20) {
        return true;
      }
      return !trivialPattern.test(comment.contents);
    })
    .sort((a, b) => {
      if (b.sympathyCount !== a.sympathyCount) {
        return b.sympathyCount - a.sympathyCount;
      }
      return b.contents.length - a.contents.length;
    })
    .slice(0, 12);
}

function parseJsonp(jsonpText) {
  const start = jsonpText.indexOf('(');
  const end = jsonpText.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to parse JSONP payload.');
  }
  return JSON.parse(jsonpText.slice(start + 1, end));
}

async function extractPostData(post) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 3000 } });
  let commentPayloadText = null;

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('web_naver_list_jsonp.json') && !commentPayloadText) {
      commentPayloadText = await response.text();
    }
  });

  try {
    await page.goto(post.mobileLink, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    const postData = await page.evaluate(() => {
      const textFrom = (selector) => {
        const node = document.querySelector(selector);
        return (node?.innerText || '').replace(/\s+/g, ' ').trim();
      };

      const contentRoot = document.querySelector('.se-viewer');
      const contentText = (contentRoot?.innerText || '').replace(/\s+\n/g, '\n').trim();
      const sources = Array.from(contentRoot?.querySelectorAll('a') || [])
        .map((anchor) => ({
          text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
          href: anchor.href || '',
        }))
        .filter((item) => item.href)
        .filter((item) => !item.href.startsWith('https://m.blog.naver.com/') || item.text.includes('출처'));

      const property = document.querySelector('#_post_property');
      const commentCount = Number(property?.getAttribute('commentCount') || 0);

      return {
        title: textFrom('.se-title-text'),
        author: textFrom('.blog_author strong'),
        dateLabel: textFrom('.blog_date'),
        category: textFrom('.blog_category a'),
        contentText,
        sources,
        commentCount,
      };
    });

    const commentButton = page.locator('button.comment_btn__TUucZ').first();
    if (await commentButton.count()) {
      await commentButton.click({ timeout: 5000 });
      await page.waitForTimeout(3500);
    }

    let comments = [];
    if (commentPayloadText) {
      const parsed = parseJsonp(commentPayloadText);
      comments = parsed?.result?.commentList || [];
    }

    return {
      ...postData,
      comments,
    };
  } finally {
    await browser.close();
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.text();
}

async function main() {
  const rssXml = await fetchText(RSS_URL);
  const latestPost = parseLatestRssItem(rssXml);
  const previousState = loadJson(STATE_FILE);

  const baseResult = {
    checkedAt: new Date().toISOString(),
    latestGuid: latestPost.guid,
    latestTitle: latestPost.title,
    latestLink: latestPost.link,
    latestPublishedAt: latestPost.publishedAt,
  };

  if (previousState?.latestGuid === latestPost.guid) {
    const result = {
      ...baseResult,
      hasNewPost: false,
    };
    saveJson(RESULT_FILE, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const extracted = await extractPostData(latestPost);
  const informativeComments = pickInformativeComments(extracted.comments);

  const result = {
    ...baseResult,
    hasNewPost: true,
    post: {
      title: extracted.title || latestPost.title,
      category: extracted.category || latestPost.category,
      author: extracted.author,
      publishedAt: latestPost.publishedAt,
      dateLabel: extracted.dateLabel,
      link: latestPost.link,
      mobileLink: latestPost.mobileLink,
      description: latestPost.description,
      contentText: extracted.contentText,
      sources: extracted.sources,
    },
    comments: {
      count: extracted.commentCount,
      informative: informativeComments,
      rawSampleCount: extracted.comments.length,
    },
  };

  saveJson(STATE_FILE, {
    latestGuid: latestPost.guid,
    latestTitle: latestPost.title,
    latestLink: latestPost.link,
    latestPublishedAt: latestPost.publishedAt,
    checkedAt: result.checkedAt,
  });
  saveJson(RESULT_FILE, result);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error.message,
        stack: error.stack,
      },
      null,
      2
    )
  );
  process.exit(1);
});
