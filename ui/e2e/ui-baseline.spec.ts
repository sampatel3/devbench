import { expect, test, type Page } from '@playwright/test';
import {
  accountHealth,
  consoleState,
  fixtureGuide,
  FIXED_NOW,
  instances,
  ISSUE,
  metrics,
  metricsSnapshot,
  notifications,
  workSources,
  worktreePlan,
} from './fixtures/console-state';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
] as const;

const SHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  scale: 'css' as const,
  maxDiffPixelRatio: 0.002,
};

type FixtureOptions = {
  deferInfo?: boolean;
  failInfo?: boolean;
  state?: typeof consoleState;
};

type FixtureHarness = {
  unexpectedRequests: string[];
  releaseInfo: () => void;
};

async function installFixture(page: Page, options: FixtureOptions = {}): Promise<FixtureHarness> {
  const unexpectedRequests: string[] = [];
  let resolveInfo: (() => void) | null = null;
  const infoReady = options.deferInfo
    ? new Promise<void>((resolve) => {
        resolveInfo = resolve;
      })
    : Promise.resolve();

  await page.clock.install({ time: new Date(FIXED_NOW) });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.addInitScript((state) => {
    class FixtureEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      readonly url: string;
      readonly withCredentials = false;
      readyState = FixtureEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          const open = new Event('open');
          this.onopen?.(open);
          this.dispatchEvent(open);

          const message = new MessageEvent('message', { data: JSON.stringify(state) });
          this.onmessage?.(message);
          this.dispatchEvent(message);
        });
      }

      close(): void {
        this.readyState = FixtureEventSource.CLOSED;
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: FixtureEventSource,
    });
  }, options.state ?? consoleState);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = async (body: unknown, status = 200): Promise<void> => {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    };

    if (request.method() === 'GET' && url.pathname === '/api/sources') {
      await json(workSources);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/summary/counts') {
      await json({
        range: {
          from: '2026-08-25',
          to: '2026-08-25',
          sinceIso: '2026-08-25T04:00:00.000Z',
          untilIso: '2026-08-26T04:00:00.000Z',
        },
        counts: { ticketsStarted: 3, prsRaised: 2, prsMerged: 1, issuesClosed: 1 },
        beyondAudit: false,
        warnings: [],
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/notifications') {
      await json({ entries: notifications });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/notifications/read') {
      await json({ ok: true, message: 'Fixture notifications marked read' });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/instances') {
      await json(instances);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/metrics/snapshot') {
      await json({ snapshot: metricsSnapshot });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/accounts') {
      await json({ accounts: accountHealth });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/metrics') {
      await json(metrics);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/info') {
      await infoReady;
      if (options.failInfo) await json({ message: 'Fixture guide is deliberately unavailable' }, 503);
      else await json({ markdown: fixtureGuide });
      return;
    }

    if (
      request.method() === 'GET' &&
      url.pathname === `/api/issues/${ISSUE.unstarted}/worktree-plan`
    ) {
      await json({ ok: true, message: 'Fixture worktree plan ready', plan: worktreePlan });
      return;
    }

    // The rebuild status the header control reads on mount. Idle, and unable
    // to restart, exactly as a console outside its launch agent reports.
    if (request.method() === 'GET' && url.pathname === '/api/system/rebuild') {
      await json({
        state: 'idle',
        at: null,
        log: '',
        canRestart: false,
        why: 'Fixture console cannot restart itself',
      });
      return;
    }

    // The two Status-summary reads that arrived after this harness was written.
    // Both come back measurably empty, so the tiles above them stand alone: the
    // chart hides itself below two days, and the averages card hides at n 0.
    if (request.method() === 'GET' && url.pathname === '/api/summary/series') {
      await json({ days: [], auditFrom: '2026-07-26', warnings: [] });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/summary/cycle') {
      const empty = { n: 0, medianMin: null, meanMin: null };
      await json({
        perIssue: [],
        summary: { toRaise: empty, toMerge: empty, toClose: empty },
        recent: { toRaise: empty, toMerge: empty, toClose: empty },
        recentDays: 7,
        trend: { toRaise: null, toMerge: null, toClose: null },
        warnings: [],
      });
      return;
    }

    // The cycle line the detail pane reads per issue. Nothing measured, so the
    // component renders nothing — the averages have their own card and their
    // own fixture is not this suite's concern.
    if (request.method() === 'GET' && /^\/api\/issues\/\d+\/cycle$/.test(url.pathname)) {
      const empty = { n: 0, medianMin: null, meanMin: null };
      await json({
        issue: Number(url.pathname.split('/')[3]),
        mine: null,
        summary: { toRaise: empty, toMerge: empty, toClose: empty },
        recent: { toRaise: empty, toMerge: empty, toClose: empty },
        recentDays: 7,
        trend: { toRaise: null, toMerge: null, toClose: null },
        warnings: [],
      });
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    await json({ ok: false, message: 'Unexpected API request in deterministic UI fixture' }, 500);
  });

  return {
    unexpectedRequests,
    releaseInfo: () => resolveInfo?.(),
  };
}

async function expectNoRootOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
    offenders: Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).replace(/\s+/g, '.')}` : ''}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((item) => item.left < -1 || item.right > window.innerWidth + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5),
  }));

  const detail = overflow.offenders.map((item) => `${item.element} [${item.left}, ${item.right}]`).join(', ');
  expect(overflow.document, `document overflowed by ${overflow.document}px: ${detail}`).toBeLessThanOrEqual(1);
  expect(overflow.body, `body overflowed by ${overflow.body}px: ${detail}`).toBeLessThanOrEqual(1);
}

/** The screenshot surface itself, including field values and destinations. */
async function expectSanitizedSurface(page: Page): Promise<void> {
  const surface = await page.evaluate(() => ({
    text: [
      document.body.innerText,
      ...Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map(
        (field) => field.value,
      ),
    ].join('\n'),
    externalLinks: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((anchor) => anchor.href)
      .filter((href) => {
        const url = new URL(href);
        return url.origin !== window.location.origin;
      }),
  }));

  // The fixtures are neutral, so this list is the guard that keeps them that
  // way: a screenshot published from a real console must never carry the
  // operator's handle, home directory or employer. Every string is written out
  // verbatim on purpose — de-identifying THIS list would leave the check
  // passing while it guards nothing.
  //
  // Colleagues' logins are deliberately NOT here. A public repo is the wrong
  // place to publish a roster of real people, and the fixture handles below
  // never carry one, so the surface is checked against the accounts this
  // console is configured for instead.
  const forbiddenOnScreen = [
    'sampatel',
    's2shape',
    's2ai',
    'secondsight',
    'shape-local',
    'deeplight',
    'taali',
    '/users/',
    '/home/',
    'github.com/s2ai',
  ];
  for (const forbidden of forbiddenOnScreen) {
    expect(surface.text.toLowerCase(), `screenshot surface contains ${forbidden}`).not.toContain(forbidden);
  }
  for (const href of surface.externalLinks) {
    expect(
      href.startsWith('https://example.invalid/') ||
        href === 'https://github.com/fixture-author' ||
        href === 'https://linear.app/settings/api' ||
        href === 'https://sentry.io/settings/account/api/auth-tokens/',
      `unexpected external destination on screenshot surface: ${href}`,
    ).toBe(true);
  }
}

async function expectPageScreenshot(page: Page, name: string): Promise<void> {
  await expectSanitizedSurface(page);
  await expect(page).toHaveScreenshot(name, SHOT);
}

function railIssue(page: Page, number: number) {
  return page.locator('.rail-item').filter({ hasText: `#${number}` }).first();
}

async function openIssue(page: Page, number: number): Promise<void> {
  await railIssue(page, number).click();
  await expect(railIssue(page, number)).toHaveClass(/\bon\b/);
}

async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

test.describe.configure({ mode: 'serial' });

test('matches the maximum-contract responsive baseline without root overflow', async ({ page }) => {
  const harness = await installFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'worker console' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Console view' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tickets' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`Fixture GitHub · ${consoleState.issues.length}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sent back from UAT', exact: true })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectNoRootOverflow(page);
    await expectPageScreenshot(page, `worker-console-${viewport.width}.png`);
  }

  expect(harness.unexpectedRequests).toEqual([]);
});

test('exercises every primary view and consequential worker state', async ({ page }) => {
  const harness = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText(`Fixture GitHub · ${consoleState.issues.length}`)).toBeVisible();

  // UAT is deliberately the default selection because a returned release wins
  // over priority. The list also carries every other operational state.
  await expect(page.getByRole('heading', { name: 'Sent back from UAT', exact: true })).toBeVisible();
  await expect(railIssue(page, ISSUE.uat).locator('.chip.uat')).toContainText('UAT FAIL');
  await expect(railIssue(page, ISSUE.running).locator('.chip.active')).toContainText('active');
  await expect(railIssue(page, ISSUE.paused).locator('.chip.paused')).toContainText('paused');
  await expect(railIssue(page, ISSUE.waiting).locator('.chip.aside')).toContainText('blocked');
  await expect(railIssue(page, ISSUE.held).locator('.chip.held')).toContainText('checkpoint');
  await expect(railIssue(page, ISSUE.completed).locator('.chip.none')).toContainText('closed');
  await expect(railIssue(page, ISSUE.failed).locator('.chip.failed')).toContainText('failed');

  await openIssue(page, ISSUE.running);
  await expect(page.getByRole('heading', { name: /Running — Claude · Fixture model/ })).toBeVisible();
  await expect(page.getByText('npm run fixture:validate', { exact: false })).toBeVisible();
  await expectPageScreenshot(page, 'state-running.png');

  await openIssue(page, ISSUE.paused);
  await expect(page.getByRole('heading', { name: /Paused — Claude · Fixture model/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume it' })).toBeVisible();
  await expectPageScreenshot(page, 'state-paused.png');

  await openIssue(page, ISSUE.waiting);
  await expect(page.getByRole('heading', { name: 'Waiting on someone else' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For you to follow up' })).toBeVisible();

  await openIssue(page, ISSUE.held);
  await expect(page.locator('.detail .chip.held')).toHaveText('checkpoint');
  await expect(page.getByRole('button', { name: 'Start a worker' })).toBeVisible();

  await openIssue(page, ISSUE.completed);
  await expect(page.locator('.detail .chip.none')).toHaveText('closed');
  await expect(page.getByText('fixture issue is closed')).toBeVisible();

  await openIssue(page, ISSUE.failed);
  await expect(page.locator('.detail .chip.failed')).toHaveText('failed');
  await expect(page.getByText('Last run failed: The deterministic fixture check returned exit code 1.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a worker' })).toBeVisible();
  await expectPageScreenshot(page, 'state-failed.png');

  await openIssue(page, ISSUE.gate);
  await expect(page.getByRole('heading', { name: 'Gate A — waiting for you' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve gate A' })).toBeEnabled();
  await expectPageScreenshot(page, 'state-gate-a.png');

  await openIssue(page, ISSUE.unstarted);
  await expect(railIssue(page, ISSUE.unstarted)).toHaveAttribute('aria-pressed', 'true');
  const selectedRailPresentation = await railIssue(page, ISSUE.unstarted).evaluate((node) => {
    const host = node.closest<HTMLElement>('[data-cs-app]');
    if (!host) throw new Error('Console Standard root is missing');
    const reference = document.createElement('span');
    reference.style.borderLeft = '4px solid var(--cs-selection-edge)';
    host.append(reference);
    const selectionEdge = getComputedStyle(reference).borderLeftColor;
    reference.remove();
    const matchingBoxShadowRules: string[] = [];
    const collectRules = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (rule.style.boxShadow && node.matches(rule.selectorText)) {
            matchingBoxShadowRules.push(`${rule.selectorText} => ${rule.style.boxShadow}`);
          }
        } else if ('cssRules' in rule) {
          collectRules((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        collectRules(sheet.cssRules);
      } catch {
        // Cross-origin stylesheets are not expected in the fixture; ignore if
        // a browser extension injects one while running locally.
      }
    }
    return {
      className: node.className,
      boxShadow: getComputedStyle(node).boxShadow,
      selectionEdge,
      selectionWidth: getComputedStyle(node).getPropertyValue('--cs-selection-width').trim(),
      tokenEdge: getComputedStyle(node).getPropertyValue('--cs-selection-edge').trim(),
      forcedColours: matchMedia('(forced-colors: active)').matches,
      matchingBoxShadowRules,
    };
  });
  expect(
    selectedRailPresentation.boxShadow,
    `selected rail presentation: ${JSON.stringify(selectedRailPresentation)}`,
  ).toContain(selectedRailPresentation.selectionEdge);
  const selectedRail = railIssue(page, ISSUE.unstarted);
  const selectedRailIndex = await selectedRail.evaluate((node) =>
    Array.from(node.parentElement?.querySelectorAll('.rail-item') ?? []).indexOf(node),
  );
  expect(selectedRailIndex).toBeGreaterThan(0);
  await page.locator('.rail-item').nth(selectedRailIndex - 1).focus();
  await page.keyboard.press('Tab');
  await expect(selectedRail).toBeFocused();
  const selectedRailFocus = await selectedRail.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      boxShadow: style.boxShadow,
      outlineOffset: style.outlineOffset,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(selectedRailFocus.boxShadow).toContain('inset');
  expect(selectedRailFocus.boxShadow).toContain('0px 0px 0px 5px inset');
  expect(selectedRailFocus.outlineWidth).toBe('2px');
  expect(selectedRailFocus.outlineOffset).toBe('-2px');

  await page.emulateMedia({ forcedColors: 'active' });
  const forcedSelectedRail = await selectedRail.evaluate((node) => {
    const unselected = node.parentElement?.querySelector<HTMLElement>(
      '.rail-item:not(.on):not(.gate):not(.uat):not(.aside)',
    );
    if (!unselected) throw new Error('Fixture needs an unselected neutral rail row');
    const selectedMarker = getComputedStyle(node, '::before');
    const unselectedMarker = getComputedStyle(unselected, '::before');
    return {
      selected: {
        backgroundColor: selectedMarker.backgroundColor,
        content: selectedMarker.content,
        insetInlineStart: selectedMarker.insetInlineStart,
        width: Number.parseFloat(selectedMarker.width),
      },
      unselected: {
        backgroundColor: unselectedMarker.backgroundColor,
        content: unselectedMarker.content,
        width: Number.parseFloat(unselectedMarker.width),
      },
    };
  });
  expect(forcedSelectedRail.selected.content).not.toBe('none');
  expect(forcedSelectedRail.selected.backgroundColor).not.toBe(
    forcedSelectedRail.unselected.backgroundColor,
  );
  expect(forcedSelectedRail.selected.width).toBeGreaterThanOrEqual(6);
  expect(forcedSelectedRail.selected.insetInlineStart).toBe('5px');
  expect(forcedSelectedRail.unselected.content).toBe('none');
  await page.emulateMedia({ forcedColors: 'none' });

  await page.getByRole('button', { name: 'Create a worktree…' }).click();
  await expect(page.getByRole('heading', { name: `Create a worktree for #${ISSUE.unstarted}?` })).toBeVisible();
  await expect(page.getByText('/fixture/worktrees/1008', { exact: true })).toBeVisible();
  await expectNoRootOverflow(page);
  await expectPageScreenshot(page, 'state-confirmation.png');

  await openView(page, 'Overview');
  // The tracker leads the tab, open, on today — no fold to click and no date to
  // pick before there is a number on screen.
  await expect(page.getByRole('heading', { name: 'Status summary' })).toBeVisible();
  await expect(page.getByText('today, in Eastern days')).toBeVisible();
  await expect(page.locator('.counts-tiles .count-tile')).toHaveCount(4);
  // …and above the grid, not below it.
  const trackerFirst = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.grid-wrap .card h3')).map((h) => h.textContent);
    return cards[0];
  });
  expect(trackerFirst).toBe('Status summary');
  await expect(page.getByText('Every ticket in this workspace')).toBeVisible();
  await expect(page.locator('table.grid tbody tr')).toHaveCount(consoleState.issues.length);
  expect(await page.locator('table.grid thead th').count()).toBeGreaterThanOrEqual(16);
  await expectPageScreenshot(page, 'view-overview-dense.png');

  await openView(page, 'Activity');
  await expect(page.getByText('Fixture UAT returned the release.')).toBeVisible();
  await expect(page.locator('ul.log > li')).toHaveCount(notifications.length);
  const clear = page.getByRole('button', { name: 'clear', exact: true });
  const click = clear.click();
  const dialog = await page.waitForEvent('dialog');
  expect(dialog.message()).toContain('Clear the log?');
  expect(dialog.message()).toContain('does not touch the actions feed');
  await dialog.dismiss();
  await click;

  await openView(page, 'System');
  await expect(page.getByRole('heading', { name: 'The machine' })).toBeVisible();
  await expect(page.getByText('fixture-edge-runtime')).toBeVisible();
  await expect(page.getByText('Not enough fixture diversity to choose a router.')).toBeVisible();

  await openView(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Agent accounts' })).toBeVisible();
  await expect(page.getByText('Ready — pick it under “Run as” when you start a worker.')).toBeVisible();
  const metricsTable = page.locator('.md-table table');
  await expect(metricsTable.locator('tbody tr')).toHaveCount(metrics.cells.length);
  await expect(metricsTable.locator('thead th')).toHaveCount(14);
  await metricsTable.scrollIntoViewIfNeeded();
  await expectSanitizedSurface(page);
  await expect(page.locator('.md-table')).toHaveScreenshot('view-settings-metrics.png', SHOT);

  await openView(page, 'Guide');
  await expect(page.getByRole('heading', { name: 'Fixture Worker Console Guide' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operating contract' })).toBeVisible();

  await openView(page, 'Tickets');
  const search = page.getByRole('searchbox', { name: 'search tickets' });
  await search.fill('fixture-state-that-does-not-exist');
  await expect(page.getByText('nothing matches that')).toBeVisible();
  await search.fill('');
  await expect(railIssue(page, ISSUE.uat)).toBeVisible();

  expect(harness.unexpectedRequests).toEqual([]);
});

test('shows one plain product question on the PR that needs the answer', async ({ page }) => {
  const decisionState: typeof consoleState = {
    ...consoleState,
    issues: consoleState.issues.map((row) =>
      row.number === ISSUE.held
        ? {
            ...row,
            status: 'awaiting-post' as const,
            statusDetail: 'drafted a product question for @fixture-owner — needs your OK to post',
            commentRequest: {
              issue: ISSUE.held,
              kind: 'decision' as const,
              target: { kind: 'pr' as const, number: 11006 },
              addressee: '@fixture-owner',
              to: { handle: '@fixture-owner', known: true, why: 'they own this decision.' },
              blocks: true,
              why: 'PR #11006 cannot be correct until the owner names the live domain.',
              context: `#${ISSUE.held} does not identify the live password-reset domain.`,
              question: 'Which domain should PR #11006 use for password-reset links?',
              draftBody:
                `@fixture-owner — #${ISSUE.held} does not identify the live password-reset domain.\n\n` +
                'Which domain should PR #11006 use for password-reset links?',
              sessionId: 'fixture-session-held',
              requestedAt: '2026-08-25T11:50:00.000Z',
            },
          }
        : row,
    ),
  };

  const harness = await installFixture(page, { state: decisionState });
  await page.goto('/');
  await openIssue(page, ISSUE.held);

  await expect(page.getByRole('heading', { name: 'Question for @fixture-owner — post on PR #11006?' })).toBeVisible();
  await expect(page.getByText('PR #11006 cannot be correct until the owner names the live domain.')).toBeVisible();
  await expect(page.locator('textarea')).toHaveValue(
    `@fixture-owner — #${ISSUE.held} does not identify the live password-reset domain.\n\n` +
      'Which domain should PR #11006 use for password-reset links?',
  );
  await expect(page.getByRole('button', { name: 'Post this question' })).toBeVisible();
  await expect(page.getByText('after posting', { exact: true })).toHaveCount(0);
  expect(harness.unexpectedRequests).toEqual([]);
});

test('renders explicit loading and error states for the technical guide', async ({ page }) => {
  const loading = await installFixture(page, { deferInfo: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.getByText(`Fixture GitHub · ${consoleState.issues.length}`)).toBeVisible();
  await openView(page, 'Guide');
  await expect(page.getByText('loading…')).toBeVisible();
  await expectPageScreenshot(page, 'state-loading.png');
  loading.releaseInfo();
  await expect(page.getByRole('heading', { name: 'Fixture Worker Console Guide' })).toBeVisible();
  expect(loading.unexpectedRequests).toEqual([]);

  const errorPage = await page.context().newPage();
  const failed = await installFixture(errorPage, { failInfo: true });
  await errorPage.setViewportSize({ width: 1024, height: 768 });
  await errorPage.goto('/');
  await expect(errorPage.getByText(`Fixture GitHub · ${consoleState.issues.length}`)).toBeVisible();
  await openView(errorPage, 'Guide');
  await expect(errorPage.getByText('Fixture guide is deliberately unavailable')).toBeVisible();
  await expectPageScreenshot(errorPage, 'state-error.png');
  expect(failed.unexpectedRequests).toEqual([]);
  await errorPage.close();
});

test('keeps critical navigation and mobile detail controls keyboard-operable', async ({ page }) => {
  const harness = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText(`Fixture GitHub · ${consoleState.issues.length}`)).toBeVisible();

  const overview = page.getByRole('button', { name: 'Overview' });
  for (let index = 0; index < 8 && !(await overview.evaluate((node) => node === document.activeElement)); index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(overview).toBeFocused();
  const focusStyle = await overview.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  const hasOutline =
    focusStyle.outlineStyle !== 'none' && Number.parseFloat(focusStyle.outlineWidth) >= 2;
  const hasTwoRingShadow =
    focusStyle.boxShadow !== 'none' &&
    focusStyle.boxShadow.includes('0px 0px 0px 2px') &&
    focusStyle.boxShadow.includes('0px 0px 0px 5px');
  expect(hasOutline || hasTwoRingShadow).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page.getByText('Every ticket in this workspace')).toBeVisible();

  const presentationStates = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-cs-app]');
    if (!host) throw new Error('Console Standard root is missing');

    const sampleButton = (className: string, disabled: boolean) => {
      const button = document.createElement('button');
      button.className = className;
      button.disabled = disabled;
      button.textContent = 'Fixture control';
      host.append(button);
      const style = getComputedStyle(button);
      const result = {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
      button.remove();
      return result;
    };

    const selectionReference = document.createElement('span');
    selectionReference.style.borderBottom = '1px solid var(--cs-selection-edge)';
    host.append(selectionReference);
    const selectionEdge = getComputedStyle(selectionReference).borderBottomColor;
    selectionReference.remove();

    const activeView = document.querySelector<HTMLElement>('.views button.on');
    if (!activeView) throw new Error('Current view marker is missing');

    return {
      primary: {
        active: sampleButton('primary', false),
        disabled: sampleButton('primary', true),
      },
      danger: {
        active: sampleButton('danger', false),
        disabled: sampleButton('danger', true),
      },
      activeViewBorder: getComputedStyle(activeView).borderBottomColor,
      selectionEdge,
    };
  });

  expect(presentationStates.primary.disabled.backgroundColor).not.toBe(
    presentationStates.primary.active.backgroundColor,
  );
  expect(presentationStates.primary.disabled.color).not.toBe(presentationStates.primary.active.color);
  expect(presentationStates.danger.disabled.backgroundColor).not.toBe(
    presentationStates.danger.active.backgroundColor,
  );
  expect(presentationStates.danger.disabled.borderColor).not.toBe(
    presentationStates.danger.active.borderColor,
  );
  expect(presentationStates.activeViewBorder).toBe(presentationStates.selectionEdge);

  await page.setViewportSize({ width: 320, height: 720 });
  const viewPicker = page.getByRole('combobox', { name: 'View' });
  await viewPicker.selectOption('list');
  const ticket = railIssue(page, ISSUE.uat);
  await ticket.focus();
  const selectedTicketFocus = await ticket.evaluate((node) => {
    const matchingBoxShadowRules: string[] = [];
    const collectRules = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (rule.style.boxShadow && node.matches(rule.selectorText)) {
            matchingBoxShadowRules.push(`${rule.selectorText} => ${rule.style.boxShadow}`);
          }
        } else if ('cssRules' in rule) {
          collectRules((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        collectRules(sheet.cssRules);
      } catch {
        // Ignore unexpected cross-origin extension styles in local browsers.
      }
    }
    const style = getComputedStyle(node);
    return {
      boxShadow: style.boxShadow,
      className: node.className,
      matchingBoxShadowRules,
      outlineOffset: style.outlineOffset,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(selectedTicketFocus.boxShadow, JSON.stringify(selectedTicketFocus)).toContain('inset');
  expect(selectedTicketFocus.boxShadow).toContain('0px 0px 0px 5px inset');
  expect(selectedTicketFocus.outlineWidth).toBe('2px');
  expect(selectedTicketFocus.outlineOffset).toBe('-2px');
  await page.keyboard.press('Enter');
  const back = page.getByRole('button', { name: '‹ All tickets' });
  await expect(back).toBeVisible();
  await expectNoRootOverflow(page);
  await expectPageScreenshot(page, 'worker-console-320-detail.png');

  await back.focus();
  await page.keyboard.press('Enter');
  await expect(ticket).toBeVisible();

  await page.emulateMedia({ forcedColors: 'active' });
  await ticket.focus();
  const forcedColourFocus = await ticket.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(forcedColourFocus.outlineOffset).toBe('-2px');
  expect(forcedColourFocus.outlineStyle).not.toBe('none');
  expect(forcedColourFocus.outlineWidth).toBeGreaterThanOrEqual(2);

  const forcedStatus = await ticket.evaluate((node) => {
    const neutral = node.parentElement?.querySelector<HTMLElement>(
      '.rail-item:not(.on):not(.gate):not(.uat):not(.aside)',
    );
    if (!neutral) throw new Error('Fixture needs an unselected neutral rail row');
    const statusMarker = getComputedStyle(node, '::before');
    const neutralMarker = getComputedStyle(neutral, '::before');
    return {
      statusInsetInlineStart: statusMarker.insetInlineStart,
      statusContent: statusMarker.content,
      statusWidth: Number.parseFloat(statusMarker.width),
      neutralWidth: Number.parseFloat(neutralMarker.width),
    };
  });
  expect(forcedStatus.statusContent).not.toBe('none');
  expect(forcedStatus.statusInsetInlineStart).toBe('5px');
  expect(forcedStatus.statusWidth).toBeGreaterThanOrEqual(3);
  expect(Number.isNaN(forcedStatus.neutralWidth)).toBe(true);
  expect(harness.unexpectedRequests).toEqual([]);
});
