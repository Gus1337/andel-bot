// ==UserScript==
// @name         FB Rental Parser - V10
// @namespace    http://tampermonkey.net/
// @version      10.13
// @match        https://www.facebook.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:9999/fb_rental_parser.js
// @downloadURL  http://127.0.0.1:9999/fb_rental_parser.js
// ==/UserScript==

(function () {
    'use strict';

    // Marionette (enabled for trusted-hover input) sets navigator.webdriver = true.
    // A real, non-automated browser reports `false` (not undefined) per the WebDriver
    // spec, so patch it back to that exact baseline rather than deleting the property.
    try {
        const realNav = typeof unsafeWindow !== 'undefined' ? unsafeWindow.navigator : navigator;
        const proto = Object.getPrototypeOf(realNav);
        Object.defineProperty(proto, 'webdriver', {
            get: function () { return false; },
            configurable: true,
            enumerable: true,
        });
    } catch (e) {
        console.log('[FB-Parser] webdriver patch failed', e);
    }

    (function reportWebdriverOnce() {
        try {
            const realNav = typeof unsafeWindow !== 'undefined' ? unsafeWindow.navigator : navigator;
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'http://127.0.0.1:9999/webdriver-check',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ value: String(realNav.webdriver), type: typeof realNav.webdriver }),
            });
        } catch (e) { /* ignore */ }
    })();

    const CONFIG = { minTextLength: 15, debug: true };
    const API = 'http://127.0.0.1:9999';

    const log = (msg, data) => CONFIG.debug && console.log(`[FB-Parser] ${msg}`, data || '');

    // ---- Text helpers ----

    function cleanGarbage(text) {
        if (!text) return '';
        let c = text.replace(/(?:\n[a-z0-9]\s*){3,}/gmi, ' ');
        [
            /and \d+ others/gi, /and \d+ friends/gi, /Join Group/gi,
            /Photos from .* post/gi, /All reactions:/gi, /Shared with Public/gi,
            /Yesterday at .*/gi, /^\d+ h$/gi, /^\d+ m$/gi, /Sponsored/gi,
            /Suggest Changes/gi
        ].forEach(re => (c = c.replace(re, '')));
        return c.replace(/\s\s+/g, ' ').trim();
    }

    function extractEmail(text) {
        const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (!m) return null;
        const domain = m[0].split('@')[1].toLowerCase();
        return ['facebook.com', 'fb.com', 'messenger.com'].some(d => domain.includes(d))
            ? null
            : m[0];
    }

    // ---- URL detection ----

    function findPostUrl(container) {
        const groupLink = container.querySelector('a[href*="/groups/"]');
        const groupMatch = groupLink && groupLink.href.match(/\/groups\/(\d+)/);
        const groupId = groupMatch && groupMatch[1];

        // Strategy 1: timestamp link with multi_permalinks (English + Danish)
        for (const a of container.querySelectorAll('a[href]')) {
            const text = (a.innerText || '').toLowerCase().trim();
            const isTimestamp =
                /\b(ago|just now|about an? (minute|hour|day)|netop nu|lige nu|for nylig)\b/.test(text) ||
                /^\d+\s*(h|m|s|d|w|t)$/.test(text) ||   // 't' = Danish 'timer'
                /^\d+\s*(min|sek|tim|time|timer|minut|minutter)$/.test(text);
            if (!isTimestamp) continue;
            const url = new URL(a.href);
            const postId = url.searchParams.get('multi_permalinks');
            if (groupId && postId)
                return `https://www.facebook.com/groups/${groupId}/posts/${postId}/`;
            // Also try story_fbid from timestamp link
            const storyFbid = url.searchParams.get('story_fbid');
            const id = url.searchParams.get('id');
            if (storyFbid && id)
                return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${id}`;
        }

        // Strategy 2: direct group post link (most reliable fallback)
        // ID can be numeric OR an opaque "pfbid..." token — match both.
        for (const a of container.querySelectorAll('a[href*="/posts/"]')) {
            const m = a.href.match(/\/groups\/(\d+)\/posts\/([\w-]+)/);
            if (m) return `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`;
        }

        // Strategy 3: photo link with pcb set (photo posts)
        if (groupId) {
            const photoLink = container.querySelector('a[href*="set=pcb."]');
            if (photoLink) {
                const pcbMatch = photoLink.href.match(/set=pcb\.(\d+)/);
                if (pcbMatch)
                    return `https://www.facebook.com/groups/${groupId}/posts/${pcbMatch[1]}/`;
            }
        }

        // Strategy 4: commerce listing
        const listingLink = container.querySelector('a[href*="/commerce/listing/"]');
        if (listingLink) {
            const m = listingLink.href.match(/\/commerce\/listing\/(\d+)/);
            if (m) return `https://www.facebook.com/commerce/listing/${m[1]}/`;
        }

        // Strategy 5: permalink with story_fbid + id
        for (const a of container.querySelectorAll('a[href]')) {
            const url = new URL(a.href);
            const storyFbid = url.searchParams.get('story_fbid');
            const id = url.searchParams.get('id');
            if (storyFbid && id)
                return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${id}`;
        }

        // Strategy 6: photo with fbid
        const photoLink = container.querySelector('a[href*="/photo/"]');
        if (photoLink) {
            const url = new URL(photoLink.href);
            const fbid = url.searchParams.get('fbid');
            if (fbid) return `https://www.facebook.com/photo/?fbid=${fbid}`;
        }

        return null;
    }

    // ---- Posted-time text ----
    // Same anchor that carries the obfuscated permalink also carries the
    // human-visible timestamp as its innerText (e.g. "3 t.", "17. juli") --
    // the server parses this to skip stale posts before spending an OpenAI call.
    function findPostedText(container) {
        const link = container.querySelector('a[role="link"][href^="?"]');
        const text = link ? (link.innerText || '').trim() : '';
        return text || null;
    }

    // ---- Best-guess fallback link ----
    // When no exact permalink can be found (common on search-result pages and
    // condensed group cards that never render a timestamp/permalink anchor),
    // build the closest clickable link we can from what IS present: the
    // author's post history within the group, an in-group text search, the
    // author's profile, or a last-resort global search. This is NEVER used
    // for de-duplication — only to make the notification link somewhere useful.

    const NON_PROFILE_HREF = /\/(groups|search|pages|stories|watch|commerce|photo)\/|permalink\.php|^https:\/\/l\.facebook\.com/;

    function findGroupId(container) {
        const groupLink = container.querySelector('a[href*="/groups/"]');
        const m = groupLink && groupLink.href.match(/\/groups\/(\d+)/);
        return m ? m[1] : null;
    }

    function findAuthorUserId(container, groupId) {
        if (!groupId) return null;
        const link = container.querySelector(`a[href*="/groups/${groupId}/user/"]`);
        const m = link && link.href.match(/\/groups\/\d+\/user\/(\d+)/);
        return m ? m[1] : null;
    }

    function findAuthorProfileUrl(container) {
        for (const a of container.querySelectorAll('a[href]')) {
            const href = a.href;
            if (!href.startsWith('https://www.facebook.com/')) continue;
            if (NON_PROFILE_HREF.test(href)) continue;
            try {
                const u = new URL(href);
                u.search = '';
                return u.toString();
            } catch { /* skip malformed */ }
        }
        return null;
    }

    function findBestGuessUrl(container, content) {
        const groupId = findGroupId(container);
        const searchWords = content.trim().split(/\s+/).slice(0, 6).join(' ');

        if (groupId) {
            const userId = findAuthorUserId(container, groupId);
            if (userId) {
                return { url: `https://www.facebook.com/groups/${groupId}/user/${userId}/`, kind: 'group_author' };
            }
            if (searchWords) {
                return { url: `https://www.facebook.com/groups/${groupId}/search/?q=${encodeURIComponent(searchWords)}`, kind: 'group_search' };
            }
        }

        const profileUrl = findAuthorProfileUrl(container);
        if (profileUrl) {
            return { url: profileUrl, kind: 'author_profile' };
        }

        if (searchWords) {
            return { url: `https://www.facebook.com/search/top/?q=${encodeURIComponent(searchWords)}`, kind: 'global_search' };
        }

        return null;
    }

    // ---- Hydration retry ----
    // If findPostUrl() finds nothing moments after the page loads, the anchor
    // almost certainly hasn't hydrated yet (virtualized/lazy-rendered feed
    // item) -- Facebook only mounts a feed item's real DOM once it's actually
    // scrolled into view. This used to also dispatch synthetic hover events on
    // the obfuscated-href anchor to try to reveal the real permalink directly,
    // but Facebook ignores untrusted (non-browser-generated) hover input for
    // that specific reveal, so it never actually worked -- real link
    // resolution now happens on demand via hover_sweeper.py's trusted
    // Marionette input (see server.py's _request_hover), only for posts
    // OpenAI already approved. The scroll itself still earns its keep: it's
    // what forces the container to fully hydrate so text extraction (and
    // expandSeeMore()) sees the real content instead of an unmounted stub.
    async function forceHydration(container) {
        try {
            container.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(r => setTimeout(r, 300));
        } catch (e) {
            log('forceHydration failed', e);
        }
    }

    // ---- Debug dump enrichment ----
    // Structured, size-bounded facts about a container that failed URL
    // extraction, meant to be read by a human (or Claude) later to design a
    // better findPostUrl() strategy — without re-deriving everything from a
    // truncated raw-HTML blob full of Facebook's generated CSS class soup.

    function simpleHash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    function findAriaAttr(container, attr) {
        let el = container;
        for (let i = 0; i < 4 && el; i++) {
            if (el.hasAttribute && el.hasAttribute(attr)) return el.getAttribute(attr);
            el = el.parentElement;
        }
        const desc = container.querySelector(`[${attr}]`);
        return desc ? desc.getAttribute(attr) : null;
    }

    function summarizeInteractiveElements(container) {
        const els = container.querySelectorAll('a, [role="link"], [role="button"]');
        return Array.from(els).slice(0, 100).map(el => ({
            tag: el.tagName.toLowerCase(),
            href: el.getAttribute('href') || null,
            text: (el.innerText || '').trim().slice(0, 60),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            ariaHidden: el.getAttribute('aria-hidden'),
        }));
    }

    function summarizeContainerMeta(container) {
        const rect = container.getBoundingClientRect();
        return {
            offsetHeight: container.offsetHeight,
            rectTop: Math.round(rect.top),
            rectBottom: Math.round(rect.bottom),
            inViewportAtCapture: rect.top < window.innerHeight && rect.bottom > 0,
            ariaPosinset: findAriaAttr(container, 'aria-posinset'),
            ariaSetsize: findAriaAttr(container, 'aria-setsize'),
            totalAnchorCount: container.querySelectorAll('a[href]').length,
            totalRoleLinkCount: container.querySelectorAll('[role="link"]').length,
            totalRoleButtonCount: container.querySelectorAll('[role="button"]').length,
        };
    }

    // Clones the container and strips Facebook's atomic-CSS class/style noise
    // so the serialized HTML is mostly real structure instead of "x9f619
    // x1n2onr6..." soup — makes far more of the actual DOM fit under maxLen.
    function cleanedOuterHtml(root, maxLen) {
        const KEEP_ATTRS = new Set([
            'href', 'role', 'aria-label', 'aria-posinset', 'aria-setsize',
            'aria-hidden', 'dir', 'tabindex', 'data-visualcompletion',
        ]);
        const clone = root.cloneNode(true);
        const walk = el => {
            if (el.nodeType !== 1) return;
            Array.from(el.attributes).forEach(attr => {
                if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
            });
            Array.from(el.children).forEach(walk);
        };
        walk(clone);
        const html = clone.outerHTML;
        return html.length > maxLen ? html.slice(0, maxLen) + '…[truncated]' : html;
    }

    // Persistent (survives page reloads) set of content-hashes already sent
    // as a debug dump, so we stop re-uploading the same unresolved post every
    // ~30-60s the script re-runs. Keeps the debug_logs/ folder as unique
    // signal instead of thousands of near-duplicate files.
    const DUMP_CACHE_KEY = 'fbParserDumpedHashes';
    const DUMP_CACHE_MAX = 1000;

    function alreadyDumped(hash) {
        const list = GM_getValue(DUMP_CACHE_KEY, []);
        return list.includes(hash);
    }

    function markDumped(hash) {
        let list = GM_getValue(DUMP_CACHE_KEY, []);
        list.push(hash);
        if (list.length > DUMP_CACHE_MAX) list = list.slice(-DUMP_CACHE_MAX);
        GM_setValue(DUMP_CACHE_KEY, list);
    }

    // ---- UI helpers ----

    function css(el, styles) {
        Object.assign(el.style, styles);
    }

    function makeBtn(label, bg, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        css(btn, {
            background: bg, color: '#fff', border: 'none', borderRadius: '5px',
            padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
            marginRight: '5px', marginTop: '5px', lineHeight: '1.4'
        });
        btn.addEventListener('click', onClick);
        return btn;
    }

    // ---- Panel ----

    function createPanel(results) {
        document.getElementById('fb-rental-panel')?.remove();

        const panel = document.createElement('div');
        panel.id = 'fb-rental-panel';
        css(panel, {
            position: 'fixed', bottom: '20px', right: '20px',
            width: '355px', maxHeight: '520px', background: '#1a1a2e',
            border: '1px solid #3d5a80', borderRadius: '12px',
            color: '#e0e0e0',
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            fontSize: '13px', zIndex: '999999',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden'
        });

        // Header
        const header = document.createElement('div');
        css(header, {
            padding: '11px 16px', background: '#16213e',
            borderBottom: '1px solid #3d5a80',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            cursor: 'pointer', userSelect: 'none', flexShrink: '0'
        });
        const hText = document.createElement('span');
        hText.innerHTML = `🏠 <strong>FB Rental</strong> — ${results.length} listing${results.length !== 1 ? 's' : ''}`;
        const toggle = document.createElement('span');
        toggle.textContent = '▲';
        toggle.style.fontSize = '12px';
        header.appendChild(hText);
        header.appendChild(toggle);

        // Body
        const body = document.createElement('div');
        css(body, { overflowY: 'auto', padding: '8px', flex: '1' });
        results.forEach(r => body.appendChild(createCard(r)));

        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'block';
            toggle.textContent = collapsed ? '▼' : '▲';
        });

        panel.appendChild(header);
        panel.appendChild(body);
        document.body.appendChild(panel);
    }

    function createCard(result) {
        const email = extractEmail(result.content);

        const card = document.createElement('div');
        css(card, {
            background: '#16213e', border: '1px solid #2d4a6e',
            borderRadius: '8px', padding: '10px', marginBottom: '8px'
        });

        // URL row
        const urlRow = document.createElement('div');
        urlRow.style.marginBottom = '6px';
        if (result.postUrl) {
            const link = document.createElement('a');
            link.href = result.postUrl;
            link.target = '_blank';
            link.textContent =
                '🔗 ' + result.postUrl.replace('https://www.facebook.com', '').substring(0, 44) + '…';
            css(link, { color: '#7eb8f7', textDecoration: 'none', fontSize: '11px', wordBreak: 'break-all' });
            urlRow.appendChild(link);
        } else if (result.bestGuessUrl) {
            const link = document.createElement('a');
            link.href = result.bestGuessUrl;
            link.target = '_blank';
            link.textContent =
                '🔍 ~' + result.bestGuessUrl.replace('https://www.facebook.com', '').substring(0, 42) + '…';
            css(link, { color: '#f7c59f', textDecoration: 'none', fontSize: '11px', wordBreak: 'break-all' });
            urlRow.appendChild(link);
            const hint = document.createElement('span');
            hint.textContent = ' (nearest guess, not exact post)';
            css(hint, { color: '#666', fontSize: '10px' });
            urlRow.appendChild(hint);
        } else {
            urlRow.textContent = '🔗 Unknown URL';
            urlRow.style.color = '#666';
        }
        card.appendChild(urlRow);

        // Email row
        const emailRow = document.createElement('div');
        emailRow.style.marginBottom = '8px';
        if (email) {
            css(emailRow, { color: '#a8e6cf', display: 'flex', alignItems: 'center', gap: '6px' });
            const emailText = document.createElement('span');
            emailText.textContent = '📧 ' + email;
            emailRow.appendChild(emailText);
            const copyBtn = makeBtn('Copy', '#2d7a4f', () => {
                navigator.clipboard.writeText(email);
                copyBtn.textContent = '✓';
                setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
            });
            css(copyBtn, { padding: '2px 7px', fontSize: '11px', marginTop: '0' });
            emailRow.appendChild(copyBtn);
        } else {
            emailRow.textContent = 'No email found';
            css(emailRow, { color: '#555', fontSize: '11px' });
        }
        card.appendChild(emailRow);

        // Action buttons
        const btnRow = document.createElement('div');
        const genBtn = makeBtn('✏️ Generate Message', '#1a6eb5', () => generateMessage(result, genBtn));
        btnRow.appendChild(genBtn);
        if (email) {
            const sendBtn = makeBtn('📤 Send Email', '#7a3e96', () => sendEmailManual(result, email, sendBtn));
            btnRow.appendChild(sendBtn);
        }
        card.appendChild(btnRow);

        return card;
    }

    // ---- Generate message ----

    function generateMessage(result, btn) {
        const original = btn.textContent;
        btn.textContent = '⏳ Generating…';
        btn.disabled = true;

        const email = extractEmail(result.content);

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API}/generate-message`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                content: result.content,
                post_url: result.postUrl || '',
                user_context: ''
            }),
            onload: res => {
                btn.textContent = original;
                btn.disabled = false;
                try {
                    const data = JSON.parse(res.responseText);
                    if (data.error) { alert('Error: ' + data.error); return; }
                    showMessageModal(data.english || '', data.danish || '', result, email);
                } catch (e) {
                    alert('Failed to parse server response.');
                }
            },
            onerror: () => {
                btn.textContent = original;
                btn.disabled = false;
                alert('Could not reach server. Is it running on port 9999?');
            }
        });
    }

    function showMessageModal(english, danish, result, email) {
        document.getElementById('fb-msg-modal')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'fb-msg-modal';
        css(overlay, {
            position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.78)', zIndex: '9999999',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const box = document.createElement('div');
        css(box, {
            background: '#1a1a2e', border: '1px solid #3d5a80', borderRadius: '12px',
            padding: '22px', width: '500px', maxWidth: '96vw', maxHeight: '82vh',
            overflowY: 'auto', color: '#e0e0e0',
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        });

        const title = document.createElement('h3');
        title.textContent = '✉️ Generated Messages';
        css(title, { margin: '0 0 18px', color: '#7eb8f7', fontSize: '16px' });
        box.appendChild(title);

        const danishSection = makeMsgSection('🇩🇰 Danish', danish, '#f7c59f', '#b56a1a', true);
        if (email) {
            const emailBtn = makeBtn('📧 Send Email to ' + email, '#7a3e96', () => {
                if (!confirm('Send the Danish message to ' + email + '?')) return;
                emailBtn.textContent = '⏳ Sending…';
                emailBtn.disabled = true;
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API}/send-email`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        to_email: email,
                        post_url: result.postUrl || '',
                        content: result.content,
                        body: danish
                    }),
                    onload: res => {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data.status === 'sent') {
                                emailBtn.textContent = '✅ Email Sent';
                                emailBtn.style.background = '#2d7a4f';
                            } else {
                                emailBtn.textContent = '📧 Send Email to ' + email;
                                emailBtn.disabled = false;
                                alert('Error: ' + (data.error || 'Unknown'));
                            }
                        } catch (e) {
                            emailBtn.textContent = '📧 Send Email to ' + email;
                            emailBtn.disabled = false;
                        }
                    },
                    onerror: () => {
                        emailBtn.textContent = '📧 Send Email to ' + email;
                        emailBtn.disabled = false;
                        alert('Could not reach server.');
                    }
                });
            });
            emailBtn.style.marginTop = '5px';
            danishSection.appendChild(emailBtn);
        }
        box.appendChild(danishSection);
        box.appendChild(makeMsgSection('🇬🇧 English', english, '#a8e6cf', '#1a6eb5', false));

        const closeBtn = makeBtn('Close', '#5a2a2a', () => overlay.remove());
        css(closeBtn, { float: 'right', padding: '6px 16px', fontSize: '13px', marginTop: '8px' });
        box.appendChild(closeBtn);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    function makeMsgSection(label, text, labelColor, btnColor, showTelegram) {
        const section = document.createElement('div');
        section.style.marginBottom = '18px';

        const lbl = document.createElement('div');
        lbl.textContent = label;
        css(lbl, { color: labelColor, fontWeight: 'bold', marginBottom: '7px' });
        section.appendChild(lbl);

        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        css(ta, {
            width: '100%', height: '95px', background: '#0f3460',
            border: '1px solid #3d5a80', borderRadius: '6px',
            color: '#e0e0e0', padding: '8px', fontSize: '13px',
            resize: 'vertical', boxSizing: 'border-box', display: 'block',
            fontFamily: 'inherit'
        });
        section.appendChild(ta);

        const copyBtn = makeBtn('📋 Copy', btnColor, () => {
            navigator.clipboard.writeText(ta.value);
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => (copyBtn.textContent = '📋 Copy'), 1600);
        });
        copyBtn.style.marginTop = '5px';
        section.appendChild(copyBtn);

        if (showTelegram) {
            const tgBtn = makeBtn('📨 Send to Telegram', '#1a7a6e', () => {
                tgBtn.textContent = '⏳ Sending…';
                tgBtn.disabled = true;
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API}/send-to-telegram`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ message: ta.value }),
                    onload: res => {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data.status === 'sent') {
                                tgBtn.textContent = '✅ Sent';
                                tgBtn.style.background = '#2d7a4f';
                            } else {
                                tgBtn.textContent = '📨 Send to Telegram';
                                tgBtn.disabled = false;
                                alert('Error: ' + (data.error || 'Unknown'));
                            }
                        } catch (e) {
                            tgBtn.textContent = '📨 Send to Telegram';
                            tgBtn.disabled = false;
                        }
                    },
                    onerror: () => {
                        tgBtn.textContent = '📨 Send to Telegram';
                        tgBtn.disabled = false;
                        alert('Could not reach server.');
                    }
                });
            });
            tgBtn.style.marginTop = '5px';
            section.appendChild(tgBtn);
        }

        return section;
    }

    // ---- Send email (manual) ----

    function sendEmailManual(result, email, btn) {
        if (!confirm(`Send email to ${email}?\n\nA pre-written Danish inquiry will be sent from your Gmail.`)) return;

        const original = btn.textContent;
        btn.textContent = '⏳ Sending…';
        btn.disabled = true;

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API}/send-email`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                to_email: email,
                post_url: result.postUrl || '',
                content: result.content
            }),
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    if (data.status === 'sent') {
                        btn.textContent = '✅ Sent';
                        btn.disabled = true;
                        btn.style.background = '#2d7a4f';
                    } else {
                        btn.textContent = original;
                        btn.disabled = false;
                        alert('Error: ' + (data.error || 'Unknown error'));
                    }
                } catch (e) {
                    btn.textContent = original;
                    btn.disabled = false;
                    alert('Failed to parse response.');
                }
            },
            onerror: () => {
                btn.textContent = original;
                btn.disabled = false;
                alert('Could not reach server.');
            }
        });
    }

    // ---- Extraction ----

    // Clicks a container's own "See more"/"Se mere" button(s), if any, and
    // gives React a moment to re-render the expanded text. Scoped per-container
    // and run right before reading its text (rather than one global pass over
    // the whole document up front) because a post below the fold can still be
    // virtualized/unmounted at the time of an upfront pass -- by the time the
    // per-container loop below reaches it (having scrolled it into view via
    // forceHydration), its "See more" button exists but was never clicked,
    // and the extracted content silently truncates at the preview text.
    async function expandSeeMore(container) {
        let clicked = false;
        container.querySelectorAll('div[role="button"]').forEach(btn => {
            const t = (btn.innerText || '').toLowerCase();
            if (t.includes('see more') || t.includes('se mere')) {
                btn.click();
                clicked = true;
            }
        });
        if (clicked) await new Promise(r => setTimeout(r, 500));
        return clicked;
    }

    async function runExtraction() {
        console.clear();
        log('Starting V10 (Generate + Email)…');

        const containers = document.querySelectorAll('div[role="feed"] > div');
        log(`Found ${containers.length} containers.`);

        const results = [];
        const seenContent = new Set();

        for (const container of containers) {
            if (container.offsetHeight < 100) continue;

            let postUrl = findPostUrl(container);
            let hydrationRetried = false;
            if (!postUrl) {
                await forceHydration(container);
                postUrl = findPostUrl(container);
                hydrationRetried = true;
            }
            await expandSeeMore(container);
            const textBlocks = Array.from(container.querySelectorAll('div[dir="auto"]'));

            let rawStrings = textBlocks
                .map(b => cleanGarbage(b.innerText))
                .filter(t => t.length > CONFIG.minTextLength);

            rawStrings.sort((a, b) => b.length - a.length);
            const uniqueLines = [];
            rawStrings.forEach(str => {
                if (!uniqueLines.some(saved => saved.includes(str))) uniqueLines.push(str);
            });

            const finalContent = uniqueLines.join('\n\n');
            const contentKey = finalContent.substring(0, 60).replace(/\s/g, '');

            if (finalContent.length > CONFIG.minTextLength && !seenContent.has(contentKey)) {
                const bestGuess = postUrl ? null : findBestGuessUrl(container, finalContent);
                const postedText = findPostedText(container);
                // Tags the live container so hover_sweeper.py can re-find this
                // exact post later (via Marionette) if the server's OpenAI
                // check comes back relevant and we still need a real link --
                // on-demand instead of hovering every post up front.
                const contentHash = simpleHash(finalContent);
                container.setAttribute('data-fb-content-hash', contentHash);
                results.push({ postUrl, bestGuessUrl: bestGuess?.url || null, content: finalContent, postedText, contentHash });
                seenContent.add(contentKey);
                console.log(
                    `%c[FB-Parser] Post found`,
                    'color:#7eb8f7;font-weight:bold',
                    '\nURL:', postUrl || `⚠️ NULL (best guess [${bestGuess?.kind}]: ${bestGuess?.url || 'none'})`,
                    hydrationRetried ? (postUrl ? '(recovered via hydration retry)' : '(hydration retry did not help)') : '',
                    '\nContent preview:', finalContent.substring(0, 120) + '…'
                );

                if (!postUrl) {
                    const dumpHash = simpleHash(finalContent);
                    if (alreadyDumped(dumpHash)) {
                        log(`Skipping debug dump — already captured this post (hash ${dumpHash})`);
                    } else {
                        // Collect enriched debug info and ship to server for later analysis
                        const links = Array.from(container.querySelectorAll('a[href]'))
                            .map(a => a.href)
                            .filter((v, i, arr) => arr.indexOf(v) === i)
                            .slice(0, 60);
                        const elements = summarizeInteractiveElements(container);
                        const meta = summarizeContainerMeta(container);
                        const containerHtml = cleanedOuterHtml(container, 40000);
                        console.warn('[FB-Parser] ⚠️ No URL found — sending debug dump', { links, elements, meta, bestGuess, preview: finalContent.substring(0, 200) });
                        GM_xmlhttpRequest({
                            method: 'POST',
                            url: `${API}/debug-post`,
                            headers: { 'Content-Type': 'application/json' },
                            data: JSON.stringify({
                                pageUrl: location.href,
                                content: finalContent,
                                links,
                                elements,
                                meta,
                                hydrationRetried,
                                bestGuessUrl: bestGuess?.url || null,
                                bestGuessKind: bestGuess?.kind || null,
                                containerHtml,
                            }),
                            onload: res => log(`Debug dump response: ${res.responseText}`),
                            onerror: () => log('Failed to send debug dump'),
                        });
                        markDumped(dumpHash);
                    }
                }
            } else if (finalContent.length <= CONFIG.minTextLength) {
                log('Skipped container — too short');
            }
        }

        if (results.length > 0) {
            console.log(
                `%c ✅ Extracted ${results.length} listing${results.length !== 1 ? 's' : ''}`,
                'color:lime;font-weight:bold;font-size:16px'
            );
            window.__fbResults = results;

            results.forEach(r => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API}/post`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        postUrl: r.postUrl || '',
                        bestGuessUrl: r.bestGuessUrl || '',
                        content: r.content,
                        postedText: r.postedText || '',
                        contentHash: r.contentHash || '',
                        pageUrl: location.href,
                    }),
                    onload: res => {
                        try {
                            const d = JSON.parse(res.responseText);
                            const icon = d.status === 'sent' ? '✅' : (d.status === 'skipped' ? '⏭' : '⚠️');
                            console.log(`%c[FB-Parser] ${icon} ${d.status}${d.reason ? ' (' + d.reason + ')' : ''}`, 'color:#a8e6cf', r.postUrl);
                        } catch {
                            log(`API raw: ${r.postUrl} → ${res.responseText}`);
                        }
                    },
                    onerror: () => log(`❌ Could not reach API for ${r.postUrl}`)
                });
            });

            createPanel(results);
        } else {
            console.log('%c No results found.', 'color:orange');
        }
    }

    // Re-run a couple more times to catch posts that simply hadn't hydrated
    // yet on the first pass (virtualized/lazy-rendered feed items) -- cheap
    // even for content already sent, since the server recognizes the same
    // content-hash and skips it as already-seen rather than re-running AI/
    // Telegram. Link resolution itself no longer depends on this: the server
    // only asks hover_sweeper.py to resolve a link on demand, after its own
    // OpenAI check already came back relevant.
    setTimeout(runExtraction, 4000);
    setTimeout(runExtraction, 12000);

    // Nothing here ever scrolls the feed, so Facebook's virtualized/paginated
    // feed never fetches past whatever rendered on initial load -- true
    // regardless of tab focus. Only the most recent post matters for this
    // use case, so instead of trying to keep the feed live in place, just
    // force a full reload every ~60s: a real navigation always fetches fresh
    // content server-side, unlike client-side pagination which depends on
    // scroll/visibility signals we don't control. Small random jitter keeps
    // tabs from all reloading in the same instant.
    setTimeout(() => location.reload(), 60000 + Math.random() * 5000);
})();
