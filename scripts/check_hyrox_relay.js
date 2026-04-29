#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL =
  'https://korea.hyrox.com/checkout/airasia-hyrox-incheon-season-25-26-h48hij?embedded=true&meta%5BviUrl%5D=https%3A%2F%2Fhyrox.com%2Fevent%2Fhyrox-incheon%2F&meta%5BviReferrer%5D=https%3A%2F%2Fhyrox.com%2Ffind-my-race%2F&boxOnly=true';
const TICKET_LABEL = 'HYROX WOMENS RELAY 여자 릴레이 | SUNDAY';
const STATE_FILE = path.join(__dirname, '..', 'logs', 'hyrox-open-women-relay-state.json');
const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
  if (ticketText.includes('매진 임박')) {
    return 'low_availability';
  }
  if (ticketText.includes('티켓 구매 가능')) {
    return 'available';
  }
  if (ticketText.includes('매진')) {
    return 'sold_out';
  }
  return 'unknown';
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveExecutablePath(),
  });

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
    const status = detectStatus(ticketText);
    const now = new Date().toISOString();
    const previous = loadState();

    const result = {
      checkedAt: now,
      status,
      previousStatus: previous?.status || null,
      changed: previous?.status ? previous.status !== status : false,
      target: {
        category: 'Relay',
        class: 'Open',
        gender: 'Women',
        label: TICKET_LABEL,
      },
      ticketText,
    };

    saveState(result);

    if (previous?.status === 'sold_out' && status !== 'sold_out') {
      result.alert = true;
      result.alertMessage = `HYROX Incheon Open Women Relay changed from sold out to ${status}.`;
    } else {
      result.alert = false;
    }

    console.log(JSON.stringify(result, null, 2));

    if (status === 'unknown') {
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
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
