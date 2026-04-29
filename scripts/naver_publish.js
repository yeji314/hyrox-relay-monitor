#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const POSTS_DIR = path.join(WORKSPACE_ROOT, "posts");
const LOGS_DIR = path.join(WORKSPACE_ROOT, "logs");
const PROFILE_NAME = process.env.NAVER_PROFILE_NAME || "naver-profile";
const PROFILE_DIR = path.join(WORKSPACE_ROOT, ".browser", PROFILE_NAME);

function usage() {
  console.log("Usage: node scripts/naver_publish.js [post-file]");
  console.log("Required env: NAVER_BLOG_ID");
  console.log("Optional env: NAVER_CATEGORY_NO, NAVER_HEADLESS=1");
}

function listMarkdownPosts() {
  if (!fs.existsSync(POSTS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(POSTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(POSTS_DIR, name))
    .sort();
}

function resolveTargetFile(argvPath) {
  if (argvPath) {
    return path.resolve(process.cwd(), argvPath);
  }
  const files = listMarkdownPosts();
  return files.length ? files[files.length - 1] : null;
}

function parseDraft(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const meta = {
    title: "",
    primaryKeyword: "",
    thumbnailText: "",
    hashtags: "",
  };

  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      bodyStart = i + 1;
      break;
    }
    if (line.startsWith("Title: ")) meta.title = line.slice(7).trim();
    if (line.startsWith("PrimaryKeyword: ")) meta.primaryKeyword = line.slice(16).trim();
    if (line.startsWith("ThumbnailText: ")) meta.thumbnailText = line.slice(15).trim();
    if (line.startsWith("Hashtags: ")) meta.hashtags = line.slice(10).trim();
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  if (!meta.title || !body) {
    throw new Error("Draft format invalid. Expected Title header and markdown body.");
  }
  return { ...meta, body };
}

async function askEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => rl.question(`${message}\n`, resolve));
  rl.close();
}

async function hasNaverSession(context) {
  const cookies = await context.cookies([
    "https://naver.com",
    "https://www.naver.com",
    "https://blog.naver.com",
    "https://nid.naver.com",
  ]);
  return cookies.some((cookie) => cookie.name === "NID_SES" && cookie.value);
}

async function waitForLogin(context, page) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await hasNaverSession(context)) {
      return true;
    }

    for (const currentPage of context.pages()) {
      const url = currentPage.url();
      if (url && !url.includes("nidlogin")) {
        return true;
      }
    }

    const url = page.url();
    if (url && !url.includes("nidlogin")) {
      return true;
    }

    await page.waitForTimeout(1000);
  }
  return false;
}

async function getActiveNaverPage(context, fallbackPage) {
  const pages = context.pages();
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const currentPage = pages[i];
    const url = currentPage.url();
    if (url && (url.includes("blog.naver.com") || url.includes("naver.com")) && !url.includes("nidlogin")) {
      return currentPage;
    }
  }
  return fallbackPage;
}

function buildDebugLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(LOGS_DIR, `naver-publish-debug-${stamp}.log`);
}

async function writeDebugLog(context, page, filePath, step) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const cookies = await context.cookies([
    "https://naver.com",
    "https://www.naver.com",
    "https://blog.naver.com",
    "https://nid.naver.com",
  ]);
  const lines = [
    `step=${step}`,
    `current_url=${page.url()}`,
    `page_count=${context.pages().length}`,
    `has_nid_ses=${cookies.some((cookie) => cookie.name === "NID_SES" && cookie.value)}`,
    "pages:",
    ...context.pages().map((p, i) => `  [${i}] ${p.url()}`),
    "cookies:",
    ...cookies.map((cookie) => `  ${cookie.name} @ ${cookie.domain}`),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function appendElementDebugLog(page, filePath) {
  const frameDetails = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const details = await frame.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('input, textarea, button, a, [contenteditable="true"], [role="textbox"]')
        );
        return {
          title: document.title,
          url: location.href,
          samples: nodes.slice(0, 120).map((el) => ({
            tag: el.tagName,
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            id: el.getAttribute("id") || "",
            className: (el.getAttribute("class") || "").replace(/\s+/g, " ").trim().slice(0, 160),
            placeholder: el.getAttribute("placeholder") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            role: el.getAttribute("role") || "",
            contenteditable: el.getAttribute("contenteditable") || "",
            text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          })),
        };
      });
      frameDetails.push(`frame[${index}] url=${details.url}`);
      frameDetails.push(`frame[${index}] title=${details.title}`);
      frameDetails.push(
        ...details.samples.map(
          (item) =>
            `  ${item.tag} type=${item.type} name=${item.name} id=${item.id} class=${item.className} placeholder=${item.placeholder} aria=${item.ariaLabel} role=${item.role} editable=${item.contenteditable} text=${item.text}`
        )
      );
    } catch (error) {
      frameDetails.push(`frame[${index}] evaluate_failed=${error.message}`);
    }
  }
  fs.appendFileSync(filePath, `element_scan:\n${frameDetails.join("\n")}\n`, "utf8");
}

async function openWritePage(context, writeUrl, fallbackPage) {
  const newPage = await context.newPage();
  try {
    await newPage.goto(writeUrl, { waitUntil: "domcontentloaded" });
    await newPage.waitForLoadState("networkidle").catch(() => {});
    await newPage.waitForTimeout(3000);
    return newPage;
  } catch (_) {
    await newPage.close().catch(() => {});
    await fallbackPage.goto(writeUrl, { waitUntil: "domcontentloaded" });
    await fallbackPage.waitForLoadState("networkidle").catch(() => {});
    await fallbackPage.waitForTimeout(3000);
    return fallbackPage;
  }
}

function buildWriteUrls(blogId, categoryNo) {
  const category = categoryNo || "0";
  return [
    `https://blog.naver.com/${encodeURIComponent(blogId)}?Redirect=Write&categoryNo=${encodeURIComponent(category)}`,
    `https://blog.naver.com/PostWriteForm.naver?blogId=${encodeURIComponent(blogId)}&Redirect=Write&categoryNo=${encodeURIComponent(category)}&redirect=Write&widgetTypeCall=true`,
    `https://blog.naver.com/PostWriteForm.naver?blogId=${encodeURIComponent(blogId)}&Redirect=Write&categoryNo=${encodeURIComponent(category)}`,
  ];
}

function isLikelyWritePage(url) {
  return /PostWriteForm|Redirect=Write|SmartEditor|editor/i.test(url);
}

async function clickWriteFromHome(page) {
  const selectors = [
    "a:has-text('글쓰기')",
    "button:has-text('글쓰기')",
    "[role='button']:has-text('글쓰기')",
    "a:has-text('작성')",
    "button:has-text('작성')",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        const popupPromise = page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null);
        await locator.click({ timeout: 3000 });
        const popup = await popupPromise;
        const target = popup || page;
        await target.waitForLoadState("domcontentloaded").catch(() => {});
        await target.waitForLoadState("networkidle").catch(() => {});
        await target.waitForTimeout(3000);
        return target;
      } catch (_) {
        // Try the next selector.
      }
    }
  }
  return null;
}

async function dismissEditorPopups(page) {
  const selectors = [
    "button.se-popup-button-cancel",
    "button[class*='cancel']",
    "button:has-text('취소')",
    "button:has-text('닫기')",
    "button:has-text('다음에')",
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const button = frame.locator(selector).first();
      if (await button.count()) {
        try {
          await button.click({ timeout: 1500 });
        } catch (_) {
          // Ignore transient popup mismatches.
        }
      }
    }
  }
}

async function resetFormatting(page) {
  for (const frame of page.frames()) {
    const strikeButton = frame.locator('button.se-strikethrough-toolbar-button').first();
    if (await strikeButton.count().catch(() => 0)) {
      try {
        const pressed =
          (await strikeButton.getAttribute("aria-pressed").catch(() => null)) === "true";
        const className = await strikeButton.getAttribute("class").catch(() => "");
        const active = pressed || /active|selected|checked|on/.test(className || "");
        if (active) {
          await strikeButton.click({ timeout: 2000 });
        }
      } catch (_) {
        // Ignore toolbar state mismatches.
      }
    }

    const textFormatButton = frame.locator('button.se-text-format-toolbar-button').first();
    if (await textFormatButton.count().catch(() => 0)) {
      try {
        const label = (await textFormatButton.innerText().catch(() => "")).trim();
        if (label && label !== "본문") {
          await textFormatButton.click({ timeout: 2000 });
          const bodyOption = frame.locator('button:has-text("본문"), [role="option"]:has-text("본문")').first();
          if (await bodyOption.count().catch(() => 0)) {
            await bodyOption.click({ timeout: 2000 });
          }
        }
      } catch (_) {
        // Ignore if the style menu is not available.
      }
    }
  }
}

async function findWorkingFrame(page, selectors) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        try {
          if (await locator.count()) {
            return frame;
          }
        } catch (_) {
          // Ignore frames that are not ready yet.
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function tryTypeIntoLocator(locator, value) {
  await locator.click({ timeout: 5000 });
  try {
    await locator.fill(value);
  } catch (_) {
    try {
      await locator.press("Meta+A");
    } catch (_) {
      // Some editable nodes do not support press directly.
    }
    await locator.type(value, { delay: 8 });
  }
}

async function fillTitle(page, title) {
  const selectorGroups = [
    [
      'textarea[name="title"]',
      'input[name="title"]',
      '[contenteditable="true"][placeholder*="제목"]',
      '[contenteditable="true"][aria-label*="제목"]',
      '.se-title-input',
      '.se-documentTitle',
    ],
    [
      'div[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
    ],
  ];

  for (const selectors of selectorGroups) {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locators = frame.locator(selector);
        const count = await locators.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const locator = locators.nth(i);
          const box = await locator.boundingBox().catch(() => null);
          if (!box) continue;
          const tag = await locator.evaluate((el) => el.tagName).catch(() => "");
          if (tag === "BODY") continue;
          await tryTypeIntoLocator(locator, title);
          return true;
        }
      }
    }
  }
  return false;
}

async function fillBody(page, body) {
  const selectors = [
    'body[contenteditable="true"]',
    '.se-main-container [contenteditable="true"]',
    '.se-component-content [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="true"][aria-label*="본문"]',
    '.se-section-text .se-text-paragraph',
    '[contenteditable="true"]',
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locators = frame.locator(selector);
      const count = await locators.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const locator = locators.nth(i);
        const box = await locator.boundingBox().catch(() => null);
        if (!box) continue;
        const tag = await locator.evaluate((el) => el.tagName).catch(() => "");
        if (tag !== "BODY" && selector === '[contenteditable="true"]') {
          const text = await locator.evaluate((el) => (el.innerText || "").trim()).catch(() => "");
          if (text && text.includes("글감을 검색")) continue;
        }
        await tryTypeIntoLocator(locator, body);
        return true;
      }
    }
  }
  return false;
}

async function fillTags(frame, hashtags) {
  if (!hashtags) return false;
  const cleaned = hashtags
    .split(/\s+/)
    .map((tag) => tag.replace(/^#/, "").trim())
    .filter(Boolean)
    .join(",");
  if (!cleaned) return false;

  const openButtons = [
    "button:has-text('태그')",
    "button:has-text('주제')",
    '[class*="tag"] button',
  ];
  for (const selector of openButtons) {
    const button = frame.locator(selector).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 2000 });
        break;
      } catch (_) {
        // Keep trying other selectors.
      }
    }
  }

  const inputs = [
    'input[placeholder*="태그"]',
    'textarea[placeholder*="태그"]',
    'input[name*="tag"]',
  ];
  for (const selector of inputs) {
    const input = frame.locator(selector).first();
    if (await input.count()) {
      await input.fill(cleaned);
      return true;
    }
  }
  return false;
}

async function clickPublish(page) {
  const selectors = [
    "button.publish_btn__m9KHH",
    "button:has-text('발행')",
    "button:has-text('등록')",
    '[class*="publish"]',
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const buttons = frame.locator(selector);
      const count = await buttons.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        const box = await button.boundingBox().catch(() => null);
        if (!box) continue;
        try {
          await button.click({ timeout: 5000 });
          await page.waitForTimeout(1500);
          return true;
        } catch (_) {
          // Try another candidate.
        }
      }
    }
  }
  return false;
}

async function confirmPublish(page) {
  const selectors = [
    "[role='dialog'] button:has-text('발행')",
    "[role='dialog'] button:has-text('확인')",
    "[role='dialog'] button:has-text('완료')",
    "[class*='layer'] button:has-text('발행')",
    "[class*='popup'] button:has-text('발행')",
    "[class*='modal'] button:has-text('발행')",
    "button:has-text('발행')",
    "button:has-text('확인')",
    "button:has-text('완료')",
    "button:has-text('등록')",
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    let clicked = false;
    await page.waitForTimeout(1200);

    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const buttons = frame.locator(selector);
        const count = await buttons.count().catch(() => 0);
        for (let i = count - 1; i >= 0; i -= 1) {
          const button = buttons.nth(i);
          const box = await button.boundingBox().catch(() => null);
          if (!box) continue;

          try {
            const text = ((await button.innerText().catch(() => "")) || "").trim();
            if (!text) continue;
            await button.click({ timeout: 2500 });
            await page.waitForTimeout(1500);
            clicked = true;
            break;
          } catch (_) {
            // Try another button candidate.
          }
        }
        if (clicked) break;
      }
      if (clicked) break;
    }

    if (!clicked) {
      break;
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const targetFile = resolveTargetFile(process.argv[2]);
  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error("No draft file found. Put a markdown draft in posts/ or pass a path.");
  }

  const blogId = process.env.NAVER_BLOG_ID;
  if (!blogId) {
    throw new Error("NAVER_BLOG_ID is required.");
  }

  const categoryNo = process.env.NAVER_CATEGORY_NO || "0";
  const headless = process.env.NAVER_HEADLESS === "1";
  const post = parseDraft(targetFile);
  const debugLogPath = buildDebugLogPath();

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 1024 },
  });
  const page = context.pages()[0] || (await context.newPage());

  const writeUrls = buildWriteUrls(blogId, categoryNo);

  console.log("네이버 글쓰기 화면으로 바로 이동합니다.");
  await page.goto(writeUrls[0], { waitUntil: "domcontentloaded" });
  await writeDebugLog(context, page, debugLogPath, "after-initial-write-url");

  if (page.url().includes("nidlogin")) {
    console.log("브라우저가 열렸습니다. 브라우저에서 네이버 로그인을 완료해 주세요.");
    console.log("로그인이 끝나면 자동으로 다시 글쓰기 화면 진입을 시도합니다.");
    const loginDetected = await waitForLogin(context, page);
    await writeDebugLog(context, page, debugLogPath, "after-login-wait");
    if (!loginDetected) {
      await askEnter("로그인이 끝났다면 이 Enter는 브라우저가 아니라 터미널에서 눌러 주세요.");
    }
  }

  console.log("글쓰기 화면 진입을 다시 시도합니다.");
  let activePage = await getActiveNaverPage(context, page);
  for (const candidateUrl of writeUrls) {
    activePage = await openWritePage(context, candidateUrl, activePage);
    if (isLikelyWritePage(activePage.url())) {
      break;
    }
  }

  if (!isLikelyWritePage(activePage.url())) {
    const clickedPage = await clickWriteFromHome(activePage);
    if (clickedPage) {
      activePage = clickedPage;
    }
  }

  await writeDebugLog(context, activePage, debugLogPath, "after-open-write-page");
  await appendElementDebugLog(activePage, debugLogPath);
  await dismissEditorPopups(activePage);
  await resetFormatting(activePage);

  const titleOk = await fillTitle(activePage, post.title);
  const bodyOk = await fillBody(activePage, `${post.body}\n\n${post.hashtags}`);
  const editorFrame = await findWorkingFrame(activePage, [
    'button[class*="publish"]',
    'button[class*="save"]',
    'body[contenteditable="true"]',
    'div[contenteditable="true"]',
  ]);
  const tagOk = editorFrame ? await fillTags(editorFrame, post.hashtags) : false;

  if (!titleOk || !bodyOk) {
    console.error(`[naver_publish] Debug log saved to ${debugLogPath}`);
    throw new Error("Editor fields were detected incompletely. Naver editor layout may have changed.");
  }

  console.log(`Loaded draft: ${path.relative(WORKSPACE_ROOT, targetFile)}`);
  console.log(`Thumbnail text: ${post.thumbnailText || "(none)"}`);
  console.log(`Tags applied: ${tagOk ? "yes" : "no"}`);

  const published = await clickPublish(activePage);
  fs.appendFileSync(debugLogPath, `publish_clicked=${published}\n`, "utf8");
  if (!published) {
    throw new Error("Publish button was not found. Review manually in the opened browser.");
  }
  await confirmPublish(activePage);

  console.log("Publish button click was attempted successfully.");
  if (!headless) {
    console.log("브라우저는 로그인 세션 유지를 위해 열어둡니다. 작업이 끝나면 직접 닫아주세요.");
    return;
  }
  await context.close();
}

main().catch((error) => {
  if (String(error.message).includes("ProcessSingleton")) {
    console.error("[naver_publish] Browser profile is already in use.");
    console.error(`[naver_publish] Close the previously opened automation browser window, then try again.`);
    console.error(`[naver_publish] If needed, run with a different profile: NAVER_PROFILE_NAME=naver-profile-2 ./scripts/publish_naver.sh`);
  } else {
    console.error(`[naver_publish] ${error.message}`);
  }
  process.exitCode = 1;
});
