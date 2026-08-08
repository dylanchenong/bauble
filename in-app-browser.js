/* Instagram and Facebook render pages in a WKWebView that can't hand off to the
   App Store: tapping an apps.apple.com link starts a navigation, Apple answers
   with the itms-apps:// scheme, and the webview has no way to follow it. The tap
   dies silently. Long-press works because that path hands the URL to iOS itself,
   which resolves it as a universal link.

   No script can escape those browsers reliably — x-safari-https://, window.open,
   and itms-apps:// are all intercepted. So instead of letting the button look
   broken, explain the situation and offer the routes that do work.

   Outside these browsers this file does nothing at all. */
(function () {
  var ua = navigator.userAgent;

  // Only iOS is affected; the Android in-app browsers hand off to Play fine.
  if (!/iPhone|iPad|iPod/.test(ua)) return;

  var app = /Instagram/.test(ua) ? 'Instagram'
          : /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook'
          : null;
  if (!app) return;

  var dialog, panel, opener, copyBtn, copyLabel, copyTimer;

  function focusable() {
    return panel.querySelectorAll('a[href], button');
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { close(); return; }
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
    } catch (e) {
      done(false);
    }
  }

  function build(url) {
    dialog = document.createElement('div');
    dialog.className = 'iab-backdrop';
    dialog.innerHTML =
      '<div class="iab-panel" role="dialog" aria-modal="true" aria-labelledby="iabTitle" aria-describedby="iabBody">' +
        '<h2 class="iab-title" id="iabTitle">' + app + ' can&rsquo;t open the App&nbsp;Store</h2>' +
        '<p class="iab-body" id="iabBody">Its built-in browser can&rsquo;t hand links to the App&nbsp;Store. ' +
          'Tap the <span class="iab-dots">&middot;&middot;&middot;</span> menu, then <strong>Open in browser</strong> &mdash; ' +
          'the download works normally there.</p>' +
        '<p class="iab-alt">Or press and hold this link and choose <strong>Open</strong>:</p>' +
        '<a class="iab-link" href="' + url + '">Bauble on the App Store</a>' +
        '<div class="iab-actions">' +
          '<button type="button" class="iab-btn iab-btn-primary" data-iab-copy><span data-iab-copy-label>Copy link</span></button>' +
          '<button type="button" class="iab-btn" data-iab-close>Close</button>' +
        '</div>' +
      '</div>';

    panel = dialog.querySelector('.iab-panel');
    copyBtn = dialog.querySelector('[data-iab-copy]');
    copyLabel = dialog.querySelector('[data-iab-copy-label]');

    copyBtn.addEventListener('click', function () { copy(url); });
    dialog.querySelector('[data-iab-close]').addEventListener('click', close);
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) close();   // tap the backdrop to dismiss
    });

    document.body.appendChild(dialog);
  }

  function open(url, trigger) {
    opener = trigger;
    if (!dialog) build(url);
    dialog.classList.add('is-open');
    document.body.classList.add('iab-locked');
    document.addEventListener('keydown', onKeydown);
    focusable()[0].focus();
  }

  function close() {
    if (!dialog) return;
    dialog.classList.remove('is-open');
    document.body.classList.remove('iab-locked');
    document.removeEventListener('keydown', onKeydown);
    if (opener && opener.focus) opener.focus();   // hand focus back where it came from
    opener = null;
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href*="apps.apple.com"]');
    if (!link) return;
    e.preventDefault();
    open(link.href, link);
  });
})();
