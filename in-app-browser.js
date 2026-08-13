/* Instagram, Threads, Facebook, Messenger and TikTok render pages in a webview
   that can't hand off to the App Store: tapping an apps.apple.com link starts a
   navigation, Apple answers with the itms-apps:// scheme, and the webview has no
   way to follow it. The tap dies silently.

   So don't try to open the store from inside the webview at all — break OUT to
   the system browser first, using the host app's own escape scheme, and let that
   browser resolve the store link. Two things make this work or fail:

     1. The scheme must fire SYNCHRONOUSLY inside the click handler. iOS only
        honours custom-scheme navigation with a real user gesture on the stack;
        a setTimeout or an await in front of it and the call is dropped without
        a word. Nothing in breakOut() may be deferred.

     2. The scheme must be the one that app actually listens for.
        instagram://extbrowser/ is Instagram's own — the app intercepts it and
        opens Safari itself. x-safari-https:// via location.href is NOT it; the
        Instagram webview ignores that, and so does a bare itms-apps:// fired on
        load. Facebook is the reverse case: window.open('x-safari-…') works.

   There is no callback for "the scheme fired", so success is inferred from the
   page being backgrounded (visibilitychange / pagehide / blur). If none of those
   arrive, we assume the escape was swallowed and show the manual routes.

   Outside these browsers this file does nothing at all: no listener is
   registered, no link is intercepted, no markup is added. */
(function (window, document) {
  'use strict';

  var navigator = window.navigator;
  var location = window.location;
  var ua = (navigator && navigator.userAgent) || '';

  var STORE_HOST = 'apps.apple.com';
  var STORE_SELECTOR = 'a[href*="' + STORE_HOST + '"]';

  /* How long to wait for proof of backgrounding before showing the fallback.
     Long enough that a slow hand-off isn't cut off mid-flight, short enough
     that a swallowed scheme doesn't leave the user staring at a dead page. */
  var ESCAPE_TIMEOUT = 1500;

  /* ---------- detection ---------- */

  function isIOS() {
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPadOS 13+ reports itself as a Mac; touch points give it away.
    return /Macintosh/.test(ua) && !!navigator && navigator.maxTouchPoints > 1;
  }

  function isAndroid() {
    return /Android/.test(ua);
  }

  // Threads ships under its Barcelona codename in the UA string.
  function isInstagram() {
    return /Instagram/.test(ua) || /Threads|Barcelona/.test(ua);
  }

  function isFacebook() {
    return /FBAN|FBAV|FB_IAB|FBIOS|FBDV/.test(ua) || /Messenger/.test(ua);
  }

  function isTikTok() {
    return /BytedanceWebview|musical_ly|TikTok|Bytedance/i.test(ua);
  }

  function isInApp() {
    return isInstagram() || isFacebook() || isTikTok();
  }

  /* ---------- escape ---------- */

  /* Mark our own URLs so the browser we escape into doesn't run the escape
     again and bounce straight back. Store links are left untouched — we never
     get control again once Apple has them. */
  function bounce(url) {
    var origin = location.origin || (location.protocol + '//' + location.host);
    if (url.indexOf(origin) !== 0) return url;
    if (/[?&]esc=1(&|$)/.test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'esc=1';
  }

  function escaped() {
    return /[?&]esc=1(&|$)/.test(location.search || '');
  }

  /* Fires the host app's escape scheme. MUST be reached synchronously from a
     user gesture. Returns true if an escape was attempted, false if this
     browser has no route out (TikTok, and anything we don't recognise).

     Everything here is a plain assignment for that reason: no timers, no
     promises, no feature probing that could yield the stack. */
  function breakOut(url) {
    var target = bounce(url);

    if (isAndroid()) {
      location.href = 'intent://' + target.replace(/^https?:\/\//, '') +
                      '#Intent;scheme=https;end';
      return true;
    }

    if (!isIOS()) return false;

    if (isInstagram()) {
      location.href = 'instagram://extbrowser/?url=' + encodeURIComponent(target);
      return true;
    }

    if (isFacebook()) {
      window.open('x-safari-' + target, '_blank');
      return true;
    }

    return false;
  }

  /* ---------- did it work? ---------- */

  var watchTimer = null;

  function stopWatching() {
    if (watchTimer === null) return;
    clearTimeout(watchTimer);
    watchTimer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHidden);
    window.removeEventListener('blur', onHidden);
  }

  // Backgrounding is the only evidence we get that the scheme was honoured.
  function onHidden() {
    stopWatching();
  }

  // visibilitychange also fires on the way back in; only "hidden" is proof.
  function onVisibility() {
    if (document.hidden || document.visibilityState === 'hidden') stopWatching();
  }

  function watch(url, trigger) {
    stopWatching();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('blur', onHidden);
    watchTimer = setTimeout(function () {
      stopWatching();
      openDialog(url, trigger);
    }, ESCAPE_TIMEOUT);
  }

  /* One attempt: escape synchronously, then start watching. The watch is set up
     after the scheme fires so nothing delays the gesture-bound call. */
  function attempt(url, trigger) {
    var fired = breakOut(url);
    if (fired) watch(url, trigger);
    else openDialog(url, trigger);   // no route out of this webview
    return fired;
  }

  /* ---------- fallback dialog ---------- */

  var dialog, panel, opener, copyLabel, copyTimer, dialogUrl;

  function appName() {
    if (isInstagram()) return /Threads|Barcelona/.test(ua) ? 'Threads' : 'Instagram';
    if (isFacebook()) return /Messenger/.test(ua) ? 'Messenger' : 'Facebook';
    if (isTikTok()) return 'TikTok';
    return 'This browser';
  }

  function menuHint() {
    // Instagram and Threads put the overflow menu at the top right; the others
    // move it around by version, so stay vague rather than send people wrong.
    return isInstagram()
      ? 'Or tap <strong>&hellip;</strong> at the top right, then <strong>Open in browser</strong>.'
      : 'Or tap <strong>&hellip;</strong> in this browser&rsquo;s toolbar, then <strong>Open in browser</strong>.';
  }

  function focusable() {
    return panel.querySelectorAll('a[href], button');
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { closeDialog(); return; }
    if (e.key !== 'Tab') return;

    // Keep Tab inside the dialog while it's open.
    var items = focusable();
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function copy(url) {
    function done(ok) {
      copyLabel.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(function () { copyLabel.textContent = 'Copy link'; }, 2400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
      return;
    }
    // Older WKWebViews predate the async clipboard API.
    try {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:absolute;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, url.length);
      done(document.execCommand('copy'));
      document.body.removeChild(ta);
    } catch (err) {
      done(false);
    }
  }

  function build(url) {
    dialog = document.createElement('div');
    dialog.className = 'iab-backdrop';
    dialog.innerHTML =
      '<div class="iab-panel" role="dialog" aria-modal="true" aria-labelledby="iabTitle" aria-describedby="iabBody">' +
        '<h2 class="iab-title" id="iabTitle">Open in your browser</h2>' +
        '<p class="iab-alt" id="iabBody">' + appName() + ' can&rsquo;t open the App&nbsp;Store directly.</p>' +
        '<button type="button" class="iab-btn iab-btn-primary iab-btn-wide" data-iab-retry>Try again</button>' +
        '<p class="iab-alt iab-hint">' + menuHint() + '</p>' +
        '<p class="iab-alt">Or press and hold this link and choose <strong>Open</strong>:</p>' +
        '<a class="iab-link" href="' + url + '">Bauble on the App&nbsp;Store</a>' +
        '<div class="iab-actions">' +
          '<button type="button" class="iab-btn" data-iab-copy><span data-iab-copy-label>Copy link</span></button>' +
          '<button type="button" class="iab-btn" data-iab-close>Close</button>' +
        '</div>' +
      '</div>';

    panel = dialog.querySelector('.iab-panel');
    copyLabel = dialog.querySelector('[data-iab-copy-label]');

    /* A direct tap on "Try again" is a fresh user gesture, which is the whole
       point: iOS will let the scheme fire again from here. */
    dialog.querySelector('[data-iab-retry]').addEventListener('click', function () {
      closeDialog();
      attempt(dialogUrl, null);
    });
    dialog.querySelector('[data-iab-copy]').addEventListener('click', function () {
      copy(dialogUrl);
    });
    dialog.querySelector('[data-iab-close]').addEventListener('click', closeDialog);
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) closeDialog();   // tap the backdrop to dismiss
    });

    document.body.appendChild(dialog);
  }

  function openDialog(url, trigger) {
    if (!document.body) return;   // nothing to attach to yet
    dialogUrl = url;
    opener = trigger;
    if (!dialog) build(url);
    dialog.classList.add('is-open');
    document.body.classList.add('iab-locked');
    document.addEventListener('keydown', onKeydown);
    focusable()[0].focus();
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.classList.remove('is-open');
    document.body.classList.remove('iab-locked');
    document.removeEventListener('keydown', onKeydown);
    if (opener && opener.focus) opener.focus();   // hand focus back where it came from
    opener = null;
  }

  /* ---------- wiring ---------- */

  function closest(node, selector) {
    while (node && node.nodeType === 1) {
      if (node.matches ? node.matches(selector) : node.msMatchesSelector(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  // Set by bindPage(): makes every tap on the page an escape trigger.
  var pageUrl = null;

  function onDocumentClick(e) {
    if (!isInApp()) return;            // normal browsers: never intercepted
    if (e.defaultPrevented) return;    // already handled by an explicit bind()
    if (closest(e.target, '.iab-backdrop')) return;   // the dialog runs its own buttons

    var link = closest(e.target, STORE_SELECTOR);
    var url = link ? link.href : pageUrl;
    if (!url) return;

    e.preventDefault();
    attempt(url, link);
  }

  /* Site-wide: every apps.apple.com link on every page that loads this file.
     Apple links only — Play Store links are handed off correctly by these
     webviews, so intervening there would break something that works. */
  document.addEventListener('click', onDocumentClick);

  /* Attach the escape to one specific element. The element keeps its href, so
     it still works untouched in a normal browser and for crawlers; the default
     is only prevented inside a webview. */
  function bind(element, url) {
    if (!element) return;
    element.addEventListener('click', function (e) {
      if (!isInApp()) return;
      e.preventDefault();
      attempt(url || element.href, element);
    });
  }

  /* Make the whole page the trigger, so a tap anywhere escapes — not just the
     one on the button. */
  function bindPage(url) {
    pageUrl = url;
  }

  /* Speculative, zero-tap escape on load. Instagram gates the scheme on
     navigation type (.linkActivated vs .other), so a load-time attempt is
     usually ignored — but it costs nothing, and on webviews that do allow it
     the user is through with no tap at all. Deliberately no fallback UI on
     failure: the page's own CTA is the fallback. */
  function autoEscape(url) {
    if (!isInApp() || escaped()) return false;

    // Once per tab, so returning to the webview doesn't re-trigger a bounce.
    try {
      if (window.sessionStorage.getItem('bauble-esc') ) return false;
      window.sessionStorage.setItem('bauble-esc', '1');
    } catch (err) { /* storage blocked — go ahead and try */ }

    return breakOut(url);
  }

  /* One-call entry point for the /download route: leave immediately in a normal
     browser, and in a webview arm the page and take the free shot at escaping. */
  function download(url) {
    if (!isInApp()) {
      location.replace(url);
      return;
    }
    bindPage(url);
    autoEscape(url);
  }

  window.InAppBrowser = {
    isInApp: isInApp,
    isIOS: isIOS,
    isAndroid: isAndroid,
    isInstagram: isInstagram,
    isFacebook: isFacebook,
    isTikTok: isTikTok,
    breakOut: breakOut,
    bind: bind,
    bindPage: bindPage,
    download: download
  };
})(window, document);
