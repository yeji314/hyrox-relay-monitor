# Naver Blog Automation

This workspace is prepared for a Codex automation that creates daily Naver blog content for the topics `운동` and `건강`.

## Output

- Draft posts are stored in `posts/`.
- Run logs or follow-up notes can be stored in `logs/`.
- Draft structure template lives in `templates/naver_post_template.md`.
- Browser publishing helpers live in `scripts/`.

## Current Schedule

- Every day at 10:00 AM Asia/Seoul

## Operating Model

Because Naver does not provide a public blog publishing API, the automation is configured to:

1. Generate a Naver-style post draft for the day's topic.
2. Save the draft in this workspace.
3. Attempt browser-based publishing only if an authenticated session and usable browser automation are available.
4. Leave a clear note when publishing is blocked by login, captcha, or editor changes.

## Draft Schema

Each generated markdown draft should start with:

- `Title: `
- `PrimaryKeyword: `
- `ThumbnailText: `
- `Hashtags: `

Then one blank line and the markdown body.

## Ranking Style

The automation is tuned for Naver-style search-friendly writing:

- strong long-tail keyword near the beginning of the title
- relatable pain point in the first paragraph
- short readable paragraphs
- practical sections with clear subheadings
- curiosity without spammy clickbait
- actionable ending that gives the reader one immediate next step
- conversational blog tone instead of textbook tone
- empathy-led opening and softer transitions in the body

Recommended title pattern:

- keyword + benefit + curiosity

Examples:

- `아침 운동 효과, 2주만 실천해도 달라지는 이유`
- `초보자 홈트 루틴, 매일 10분으로 습관 만드는 방법`
- `건강한 식습관, 자꾸 실패하는 이유와 쉬운 해결법`

## Topic Selection

The automation now prefers trend-aligned topic selection:

- use current Naver DataLab trend signals when available
- choose only keywords that still fit the blog's core areas of `운동` and `건강`
- fall back to evergreen high-intent keywords if live trend lookup is unavailable

This keeps topics closer to what people are already searching for while staying inside the blog's niche.

## Publish Helper

For this workspace, the Naver blog id is already saved in `.naver-blog.env`, so you can usually run the publisher directly:

```bash
./scripts/publish_naver.sh
```

To publish a specific draft:

```bash
./scripts/publish_naver.sh posts/2026-04-22-exercise-sample.md
```

The current saved blog id in this workspace is `mooomicho`.

If you want to change the account later, edit `.naver-blog.env`.

### How to find `NAVER_BLOG_ID`

Open your Naver blog in a browser and check the address.

- If your blog URL looks like `https://blog.naver.com/myblogid`, then `NAVER_BLOG_ID` is `myblogid`.
- If a post URL looks like `https://blog.naver.com/PostView.naver?blogId=myblogid&logNo=...`, then the value after `blogId=` is your blog id.
- If you are unsure, open your blog home and copy the account-style part used in the blog URL.

Example:

```bash
export NAVER_BLOG_ID="myblogid"
```

You can still override the saved value in your current shell session:

```bash
cd /Users/a60157119/Documents/Codex/project1
export NAVER_BLOG_ID="myblogid"
./scripts/publish_naver.sh posts/2026-04-22-exercise-sample.md
```

Optional:

```bash
export NAVER_CATEGORY_NO="1"
export NAVER_HEADLESS="1"
./scripts/publish_naver.sh posts/2026-04-22-topic.md
```

If you see a `ProcessSingleton` error, it means the saved browser profile is already open in another automation browser window. Close that browser window first, then retry.

If you want to use a separate login profile:

```bash
NAVER_PROFILE_NAME="naver-profile-2" ./scripts/publish_naver.sh
```

The script uses a persistent browser profile under `.browser/naver-profile` so your login session can be reused after the first manual sign-in.
