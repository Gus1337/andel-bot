// ==UserScript==
// @name         Andelsbolig Group Watcher (pilot)
// @namespace    andelsbolig-bot
// @version      0.17
// @description  Pilot: extract new posts from one Facebook group feed, POST to local bridge
// @match        https://www.facebook.com/groups/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  // Pilot phase: conservative interval. Tighten later once we've validated
  // the extraction and seen how the account holds up.
  const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
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

  function expandSeeMore() {
    const buttons = document.querySelectorAll('div[role="button"]');
    buttons.forEach((btn) => {
      const text = (btn.innerText || '').trim().toLowerCase();
      if (text === 'se mere' || text === 'see more') {
        btn.click();
      }
    });
  }

  function extractPostText(article, debug) {
    const selectors = [
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
      '[data-ad-preview="message"]',
    ];
    for (const sel of selectors) {
      const el = article.querySelector(sel);
      if (el && el.innerText.trim()) {
        if (debug) console.log('[andelsbolig-bot] text via selector:', sel);
        return el.innerText.trim();
      }
    }

    // Shared posts (e.g. Marketplace listings shared into the group) put the
    // post body in a <blockquote> that sits OUTSIDE the role="article" element
    // as a sibling in the same parent wrapper. Check both inside and in siblings.
    const bq = article.querySelector('blockquote') || (() => {
      const parent = article.parentElement;
      if (!parent) return null;
      for (const sib of parent.children) {
        if (sib !== article) {
          const found = sib.tagName === 'BLOCKQUOTE' ? sib : sib.querySelector('blockquote');
          if (found) return found;
        }
      }
      return null;
    })();

    if (bq) {
      // Collect all [dir="auto"] innerTexts, deduplicate, pick longest (parent
      // elements repeat their children's text — the longest is the full body).
      const texts = [...new Set(
        Array.from(bq.querySelectorAll('[dir="auto"]'))
          .map(el => el.innerText.trim())
          .filter(t => t.length > 5)
      )].sort((a, b) => b.length - a.length);
      if (texts.length > 0 && texts[0].length > 10) {
        if (debug) console.log('[andelsbolig-bot] text via blockquote');
        return texts[0];
      }
    }

    // Regular posts: longest [dir="auto"] anywhere in the article
    const candidates = Array.from(article.querySelectorAll('[dir="auto"]'))
      .map(el => el.innerText.trim())
      .filter(t => t.length > 10)
      .sort((a, b) => b.length - a.length);
    if (debug) console.log(`[andelsbolig-bot] dir=auto candidates: ${candidates.length}, longest: ${candidates[0]?.length ?? 0} chars`);
    if (candidates.length > 0) {
      if (debug) console.log('[andelsbolig-bot] text via longest dir=auto');
      return candidates[0];
    }

    console.warn('[andelsbolig-bot] extractPostText: no text found');
    return '';
  }

  function extractPermalink(article) {
    const links = article.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.includes('/posts/') || href.includes('permalink') || href.includes('multi_permalinks')) {
        const clean = href.split('?')[0];
        return clean.startsWith('http') ? clean : 'https://www.facebook.com' + clean;
      }
    }
    return null;
  }

  // Facebook's feed renders posts as loading placeholders
  // ([data-visualcompletion="loading-state"]) before their real content
  // exists. A fixed delay before scanning is really just a guess at how
  // long that takes -- it's fine on a warmed-up profile/cache but silently
  // skips every post on a slow/cold page load (nothing to extract yet).
  // Poll until no placeholders remain instead of guessing a fixed wait.
  function waitForArticlesReady(maxAttempts, intervalMs, callback) {
    let attempts = 0;
    function check() {
      attempts++;
      const stillLoading = document.querySelectorAll(
        'div[role="article"] [data-visualcompletion="loading-state"]'
      ).length;
      if (stillLoading === 0 || attempts >= maxAttempts) {
        if (stillLoading > 0) {
          console.log(`[andelsbolig-bot] giving up waiting for ${stillLoading} loading article(s) after ${attempts} attempts`);
        }
        callback();
      } else {
        setTimeout(check, intervalMs);
      }
    }
    check();
  }

  function scanFeed() {
    expandSeeMore();

    // Give expanded "see more" text a moment to render before reading it
    waitForArticlesReady(10, 1000, () => {
      const seen = loadSeen();
      // Keys dispatched during THIS scan pass, to avoid double-POSTing the
      // same post twice before the bridge has confirmed either one -- kept
      // separate from `seen`, which is only updated on confirmed delivery.
      const inFlight = new Set();
      const allArticles = document.querySelectorAll('div[role="article"]');
      // Comments carry the same role="article" attribute as top-level posts,
      // but live nested inside their parent post's subtree -- only keep
      // articles that are NOT nested inside another article.
      const articles = Array.from(allArticles).filter((el) => {
        return el.parentElement && !el.parentElement.closest('div[role="article"]');
      });
      let newCount = 0;

      articles.forEach((article) => {
        const permalink = extractPermalink(article);
        const text = extractPostText(article, true);
        if (!text && !permalink) return;

        const key = permalink || text.slice(0, 300);
        if (seen.has(key) || inFlight.has(key)) return;
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
      });

      console.log(`[andelsbolig-bot] scan complete: ${allArticles.length} total article-elements (${articles.length} top-level posts) on page, ${newCount} new`);
    });
  }

  window.addEventListener('load', () => {
    if (!withinRunWindow()) {
      console.log('[andelsbolig-bot] outside run window (07:00-23:00), skipping scan');
      return;
    }
    // Ensure we're on chronological sort before scanning.
    // If not, redirect now — the resulting load event will scan correctly.
    if (!location.href.includes('sorting_setting=CHRONOLOGICAL')) {
      const base = location.href.split('?')[0];
      location.href = base + '?sorting_setting=CHRONOLOGICAL';
      return;
    }
    setTimeout(scanFeed, 3000);
  });

  // Periodic re-navigation to keep the chronological sort and pick up new
  // posts. Outside the run window this just skips the tick -- the next tick
  // after 07:00 will pick back up without any extra wiring needed.
  setInterval(() => {
    if (!withinRunWindow()) {
      console.log('[andelsbolig-bot] outside run window (07:00-23:00), skipping refresh');
      return;
    }
    const base = location.href.split('?')[0];
    location.href = base + '?sorting_setting=CHRONOLOGICAL';
  }, REFRESH_INTERVAL_MS);
})();
