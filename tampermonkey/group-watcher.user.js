// ==UserScript==
// @name         Andelsbolig Group Watcher (pilot)
// @namespace    andelsbolig-bot
// @version      0.22
// @description  Pilot: extract new posts from one Facebook group feed, POST to local bridge
// @match        https://www.facebook.com/groups/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/Gus1337/andel-bot/main/tampermonkey/group-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/Gus1337/andel-bot/main/tampermonkey/group-watcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Test set: cycle through these three groups from a single tab, one at a
  // time, instead of needing one tab open per group.
  const GROUP_URLS = [
    'https://www.facebook.com/groups/2013736325520631/',
    'https://www.facebook.com/groups/3528177187299944/',
    'https://www.facebook.com/groups/885823616059794/',
  ];
  const CYCLE_INTERVAL_MS = 60 * 1000; // 1 minute per group, for this test run
  const MAX_SEEN = 500; // cap stored history so it doesn't grow forever

  // Posts are assumed not to appear overnight, and running fewer hours/day
  // reduces the "always-on" bot signature. Relies on the VM's system
  // timezone being Europe/Copenhagen (set in deploy/setup.sh).
  const RUN_WINDOW_START_HOUR = 7;  // inclusive, 07:00
  const RUN_WINDOW_END_HOUR = 23;   // exclusive, up to 23:00

  function withinRunWindow() {
    const hour = new Date().getHours();
    return hour >= RUN_WINDOW_START_HOUR && hour < RUN_WINDOW_END_HOUR;
  }

  // Cycling state (which group we're on) is persisted via GM storage --
  // each navigation is a fresh page load/script execution, so this can't
  // just live in a variable.
  function currentGroupIndex() {
    const base = location.href.split('?')[0].replace(/\/$/, '') + '/';
    return GROUP_URLS.findIndex((u) => u.replace(/\/$/, '') + '/' === base);
  }

  function navigateToGroup(index) {
    GM_setValue('cycle_index', index);
    location.href = GROUP_URLS[index] + '?sorting_setting=CHRONOLOGICAL';
  }

  function loadSeen() {
    try {
      return new Set(JSON.parse(GM_getValue('seen_keys', '[]')));
    } catch (e) {
      return new Set();
    }
  }

  function saveSeen(seenSet) {
    const arr = Array.from(seenSet).slice(-MAX_SEEN);
    GM_setValue('seen_keys', JSON.stringify(arr));
  }

  // Strips common feed chrome that ends up mixed into dir="auto" text
  // alongside the real post body (reaction counts, group-join prompts,
  // bare timestamp fragments) so extracted text is the post, not UI noise.
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\bog \d+ (andre|flere)\b/gi, '')
      .replace(/\bDeltag i gruppen\b/gi, '')
      .replace(/\bSponsoreret\b/gi, '')
      .replace(/\bAlle reaktioner:?/gi, '')
      .replace(/^\d+\s*(s|m|t|u|d)$/gim, '')
      .replace(/\s\s+/g, ' ')
      .trim();
  }

  // Collects every meaningfully-different dir="auto" text block instead of
  // just the single longest one -- a post's body can be split across
  // multiple elements (e.g. a paragraph plus a separately-rendered price
  // line), and taking only the longest silently drops the rest.
  function extractPostText(container) {
    const blocks = Array.from(container.querySelectorAll('div[dir="auto"]'))
      .map((el) => cleanText(el.innerText))
      .filter((t) => t.length > 10)
      .sort((a, b) => b.length - a.length);

    const unique = [];
    blocks.forEach((t) => {
      if (!unique.some((kept) => kept.includes(t))) unique.push(t);
    });
    return unique.join('\n\n');
  }

  // A post's timestamp anchor carries its real permalink -- prefer that
  // specifically over any other link in the container, since a post can
  // also contain unrelated links (a tagged page, a commenter's profile,
  // an external URL in the post body) that would otherwise get grabbed
  // first by a naive "any href containing /posts/" scan.
  const TIME_LINK_PATTERN = /\b(ago|for nylig|just now)\b|^\d+\s*(s|m|min|h|t|d|u|w|uge)$|^\d+\s*(sekund|minut|time|dag|uge)(er)?$/i;

  function extractPermalink(container) {
    const groupMatch = location.href.match(/\/groups\/(\d+)/);
    const groupId = groupMatch ? groupMatch[1] : null;
    const links = Array.from(container.querySelectorAll('a[href]'));

    for (const a of links) {
      const text = (a.innerText || '').trim().toLowerCase();
      if (!TIME_LINK_PATTERN.test(text)) continue;
      const href = a.getAttribute('href') || '';
      if (href.includes('comment_id=')) continue;
      try {
        const url = new URL(href, location.href);
        const postId = url.searchParams.get('multi_permalinks');
        if (groupId && postId) return `https://www.facebook.com/groups/${groupId}/posts/${postId}/`;
      } catch (e) { /* malformed href, fall through to the broader scan below */ }
    }

    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.includes('comment_id=')) continue;
      if (href.includes('/posts/') || href.includes('multi_permalinks')) {
        const clean = href.split('?')[0];
        return clean.startsWith('http') ? clean : 'https://www.facebook.com' + clean;
      }
    }
    return null;
  }

  async function expandSeeMoreIn(container) {
    let clicked = false;
    container.querySelectorAll('div[role="button"]').forEach((btn) => {
      const t = (btn.innerText || '').trim().toLowerCase();
      if (t === 'se mere' || t === 'see more') {
        btn.click();
        clicked = true;
      }
    });
    if (clicked) await new Promise((r) => setTimeout(r, 500));
  }

  // Facebook's feed is virtualized: an off-screen item stays an unmounted
  // loading stub until something actually scrolls it into the viewport --
  // waiting longer on a fixed timer never helps if a container just never
  // gets scrolled to. Nudge it into view ourselves and give React a moment
  // to hydrate real content in.
  async function forceHydration(container) {
    try {
      container.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.warn('[andelsbolig-bot] forceHydration failed', e);
    }
  }

  async function scanFeed() {
    const feedRoot = document.querySelector('div[role="feed"]');
    if (!feedRoot) {
      console.log('[andelsbolig-bot] no role="feed" container on this page yet, skipping scan');
      return;
    }

    // Anchoring on the feed's own direct children (rather than querying
    // role="article" globally) is what actually excludes comments -- they
    // render outside this structure entirely, so there's nothing to filter
    // out after the fact.
    const containers = Array.from(feedRoot.children).filter((el) => el.offsetHeight > 100);
    const seen = loadSeen();
    // Keys dispatched during THIS scan pass, to avoid double-POSTing the
    // same post twice before the bridge has confirmed either one -- kept
    // separate from `seen`, which is only updated on confirmed delivery.
    const inFlight = new Set();
    let newCount = 0;

    for (const container of containers) {
      let permalink = extractPermalink(container);
      if (!permalink) {
        await forceHydration(container);
        permalink = extractPermalink(container);
      }
      // Require a real permalink rather than falling back to a text-based
      // key -- a genuine post reliably has its own /posts/ link, and this
      // avoids ever alerting on something we can't actually link back to.
      if (!permalink) continue;

      await expandSeeMoreIn(container);
      const text = extractPostText(container);

      const key = permalink;
      if (seen.has(key) || inFlight.has(key)) continue;
      inFlight.add(key);
      newCount++;

      console.log('[andelsbolig-bot] NEW POST', { permalink, textPreview: text.slice(0, 120) });
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://127.0.0.1:5000/post',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ permalink, text, group_url: location.href }),
        onload: (r) => {
          console.log('[andelsbolig-bot] bridge →', r.status, r.responseText);
          // Only remember this post once the bridge has actually confirmed
          // it (alerted, or already-seen server-side). If the bridge is
          // down or errors, do NOT mark it seen -- leaving it out means
          // the next scan will find and retry it, instead of the post
          // being silently and permanently dropped.
          if (r.status >= 200 && r.status < 300) {
            const current = loadSeen();
            current.add(key);
            saveSeen(current);
          } else {
            console.warn('[andelsbolig-bot] bridge rejected post, will retry next scan:', key);
          }
        },
        onerror: (e) => {
          console.warn('[andelsbolig-bot] bridge unreachable, will retry next scan:', key, e);
        },
      });
    }

    console.log(`[andelsbolig-bot] scan complete: ${containers.length} feed containers checked, ${newCount} new`);
  }

  window.addEventListener('load', () => {
    if (!withinRunWindow()) {
      console.log('[andelsbolig-bot] outside run window (07:00-23:00), skipping scan');
      return;
    }

    const idx = currentGroupIndex();
    if (idx === -1) {
      // Not on one of the target groups (first load, or Facebook stripped
      // our query param) -- jump to wherever we left off, or the start.
      navigateToGroup(GM_getValue('cycle_index', 0));
      return;
    }

    // Ensure we're on chronological sort before scanning.
    // If not, redirect now — the resulting load event will scan correctly.
    if (!location.href.includes('sorting_setting=CHRONOLOGICAL')) {
      const base = location.href.split('?')[0];
      location.href = base + '?sorting_setting=CHRONOLOGICAL';
      return;
    }

    GM_setValue('cycle_index', idx); // keep persisted index in sync with reality

    // Two staggered passes catch feed items that simply hadn't hydrated
    // yet on the first one -- cheap even for content already sent, since
    // dedup (via the bridge's confirmed-seen check) skips anything already
    // alerted rather than re-sending it.
    setTimeout(scanFeed, 4000);
    setTimeout(scanFeed, 12000);
  });

  // Every minute, move on to the next group in the list (wrapping around).
  // Outside the run window this just skips the tick -- the next tick after
  // 07:00 will pick back up without any extra wiring needed.
  setInterval(() => {
    if (!withinRunWindow()) {
      console.log('[andelsbolig-bot] outside run window (07:00-23:00), skipping cycle');
      return;
    }
    const idx = currentGroupIndex();
    const nextIndex = (idx === -1 ? 0 : (idx + 1) % GROUP_URLS.length);
    navigateToGroup(nextIndex);
  }, CYCLE_INTERVAL_MS);
})();
