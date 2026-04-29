#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL =
  'https://korea.hyrox.com/checkout/airasia-hyrox-incheon-season-25-26-h48hij?embedded=true&meta%5BviUrl%5D=https%3A%2F%2Fhyrox.com%2Fevent%2Fhyrox-incheon%2F&meta%5BviReferrer%5D=https%3A%2F%2Fhyrox.com%2Ffind-my-race%2F&boxOnly=true';
const TICKET_LABEL = 'HYROX WOMENS RELAY 여자 릴레이 | SUNDAY';
const STATE_FILE = path.join(__dirname, '..', 'logs', 'hyrox-open-women-relay-state.json');
const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOW_AVAILABILITY_THRESHOLD = 3;

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function resolveExecutablePath() {
  if (process.env.HYROX_MONITOR_CHROME_PATH) {
    return process.env.HYROX_MONITOR_CHROME_PATH;
  }
  if (fs.existsSync(DEFAULT_CHROME_PATH)) {
    return DEFAULT_CHROME_PATH;
  }
  return undefined;
}

function buildLaunchOptions(useExecutablePath) {
  const options = {
    headless: true,
  };

  if (useExecutablePath) {
    options.executablePath = useExecutablePath;
  }

  return options;
}

async function launchBrowser() {
  const attempts = [
    buildLaunchOptions(resolveExecutablePath()),
    buildLaunchOptions(undefined),
  ];

  let lastError = null;

  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function clickExact(page, label) {
  await page.getByText(label, { exact: true }).click();
  await page.waitForTimeout(800);
}

async function getTicketText(page) {
  const title = page.getByText(TICKET_LABEL, { exact: true }).first();

  if (!(await title.count())) {
    throw new Error(`Target ticket label not found: ${TICKET_LABEL}`);
  }

  const cardText = await title.evaluate((el) => {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.includes('₩163,400') || text.includes('매진') || text.includes('티켓 구매 가능')) {
        return text;
      }
    }
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  });

  return normalize(cardText);
}

function detectStatus(ticketText) {
  if (ticketText.includes('매진 임박') || ticketText.includes('LOW AVAILABILITY')) {
    return 'low_availability';
  }
  if (ticketText.includes('티켓 구매 가능') || ticketText.includes('TICKETS AVAILABLE')) {
    return 'available';
  }
  if (ticketText.includes('매진') || ticketText.includes('SOLD OUT')) {
    return 'sold_out';
  }
  return 'unknown';
}

function statusFromAvailabilityCount(count) {
  if (typeof count !== 'number' || Number.isNaN(count)) {
    return 'unknown';
  }
  if (count <= 0) {
    return 'sold_out';
  }
  if (count <= LOW_AVAILABILITY_THRESHOLD) {
    return 'low_availability';
  }
  return 'available';
}

function buildTicketTextFromAvailability(count) {
  const priceText = '₩163,400';
  const status = statusFromAvailabilityCount(count);
  const prefix =
    status === 'sold_out'
      ? '매진'
      : status === 'low_availability'
        ? '매진 임박'
        : '티켓 구매 가능';

  return normalize(`${prefix} ${TICKET_LABEL} ${priceText}`);
}

function extractNextDataTicket(html) {
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );

  if (!nextDataMatch) {
    throw new Error('NEXT_DATA payload not found in checkout page.');
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const tickets = nextData?.props?.pageProps?.event?.tickets;

  if (!Array.isArray(tickets)) {
    throw new Error('Ticket list not found in NEXT_DATA payload.');
  }

  const ticket = tickets.find((item) => item?.name === TICKET_LABEL);

  if (!ticket) {
    throw new Error(`Target ticket label not found in NEXT_DATA payload: ${TICKET_LABEL}`);
  }

  return ticket;
}

async function fallbackFetchTicket() {
  const response = await fetch(TARGET_URL, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Checkout page fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const ticket = extractNextDataTicket(html);
  const availabilityCount = Number(ticket.v);

  return {
    ticketText: buildTicketTextFromAvailability(availabilityCount),
    status: statusFromAvailabilityCount(availabilityCount),
    availabilityCount,
    source: 'next_data_fallback',
  };
}

async function browserFetchTicket() {
  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1800 },
  });

  try {
    await page.goto(TARGET_URL, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await clickExact(page, 'Relay');
    await clickExact(page, 'Open');
    await clickExact(page, 'Women');
    await page.waitForTimeout(1200);

    const ticketText = await getTicketText(page);
    return {
      ticketText,
      status: detectStatus(ticketText),
      source: 'playwright_browser',
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  let fetchResult;
  let browserError = null;

  try {
    fetchResult = await browserFetchTicket();
  } catch (error) {
    browserError = error;
    fetchResult = await fallbackFetchTicket();
  }

  const now = new Date().toISOString();
  const previous = loadState();

  const result = {
    checkedAt: now,
    status: fetchResult.status,
    previousStatus: previous?.status || null,
    changed: previous?.status ? previous.status !== fetchResult.status : false,
    target: {
      category: 'Relay',
      class: 'Open',
      gender: 'Women',
      label: TICKET_LABEL,
    },
    ticketText: fetchResult.ticketText,
    source: fetchResult.source,
  };

  if (typeof fetchResult.availabilityCount === 'number') {
    result.availabilityCount = fetchResult.availabilityCount;
  }

  if (browserError) {
    result.browserFallback = {
      used: true,
      message: browserError.message,
    };
  }

  saveState(result);

  if (previous?.status === 'sold_out' && fetchResult.status !== 'sold_out') {
    result.alert = true;
    result.alertMessage = `HYROX Incheon Open Women Relay changed from sold out to ${fetchResult.status}.`;
  } else {
    result.alert = false;
  }

  console.log(JSON.stringify(result, null, 2));

  if (fetchResult.status === 'unknown') {
    process.exitCode = 2;
  }
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
