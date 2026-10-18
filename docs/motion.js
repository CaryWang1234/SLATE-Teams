/* SLATE 官网动效层 · motion.js
   依赖：anime.js（可选）。没有 anime 或用户要求减少动效时，各段独立优雅退出，
   页面内容与排版不受影响——动效只做加法，从不承担信息传达。 */
(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasAnime = typeof window.anime === "function";
  var anime = window.anime;

  var q = function (sel) { return document.querySelector(sel); };
  var qa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ── 1. Hero 字标逐字上浮，其余元素顺时序落位 ─────────────── */
  if (hasAnime && !reduced) {
    var title = q(".hero-title");
    var letters = [];
    if (title) {
      // 逐字上浮，但字必须装在"词"里：全是并列 inline-block 时，
      // 浏览器可以在任意两字之间折行，"SLATE Teams" 会断成 SLATE Tea / ms。
      var words = title.textContent.trim().split(/\s+/);
      title.textContent = "";
      words.forEach(function (word, wi) {
        if (wi) title.appendChild(document.createTextNode(" "));
        var wrap = document.createElement("span");
        wrap.className = "ht-word";
        title.appendChild(wrap);
        Array.from(word).forEach(function (ch) {
          var span = document.createElement("span");
          span.className = "ht-letter";
          span.textContent = ch;
          wrap.appendChild(span);
          letters.push(span);
        });
      });
    }

    var mark = q(".hero-mark");
    var actions = q(".hero-actions");
    var badges = qa(".hero-badges .badge");
    var footnotes = qa(".hero-install, .hero-shipped");
    var prehide = [mark]
      .concat(letters, [q(".hero-sub"), q(".hero-en"), q(".hero-type"), actions], badges, footnotes)
      .filter(Boolean);

    if (prehide.length) anime.set(prehide, { opacity: 0 });
    if (letters.length) anime.set(letters, { translateY: 46, rotate: -6, scale: 0.94 });

    var tl = anime.timeline({ easing: "easeOutCubic" });
    if (mark) tl.add({ targets: mark, opacity: [0, 1], translateY: [18, 0], duration: 520 });
    if (letters.length) {
      tl.add({
        targets: letters,
        opacity: [0, 1],
        translateY: [46, 0],
        rotate: [-6, 0],
        scale: [0.94, 1],
        duration: 860,
        delay: anime.stagger(72),
        easing: "easeOutBack",
      }, "-=280");
    }
    if (q(".hero-sub") || q(".hero-en")) {
      tl.add({
        targets: qa(".hero-sub, .hero-en"),
        opacity: [0, 1],
        translateY: [16, 0],
        duration: 560,
        delay: anime.stagger(110),
      }, "-=580");
    }
    if (actions) {
      tl.add({ targets: actions, opacity: [0, 1], translateY: [16, 0], duration: 520 }, "-=440");
    }
    if (badges.length) {
      tl.add({
        targets: badges,
        opacity: [0, 1],
        translateY: [14, 0],
        scale: [0.92, 1],
        duration: 480,
        delay: anime.stagger(64),
        easing: "easeOutBack",
      }, "-=380");
    }
    if (footnotes.length) {
      tl.add({
        targets: footnotes,
        opacity: [0, 1],
        translateY: [12, 0],
        duration: 470,
        delay: anime.stagger(90),
      }, "-=300");
    }

    /* 保底：动效只负责“好看”，不负责“能不能看见”。
       时间轴跑完（或超时 4s 仍未跑完）时强制清掉行内 opacity/transform，
       哪怕 anime 被中断、页面被冻结在后台，文字也一定会回到可见状态。 */
    var settle = function () {
      prehide.forEach(function (el) {
        if (window.getComputedStyle(el).opacity === "0") {
          el.style.opacity = "1";
          el.style.transform = "none";
        }
      });
    };
    if (tl.finished && typeof tl.finished.then === "function") {
      tl.finished.then(settle).catch(settle);
    }
    window.setTimeout(settle, 4000);
  }

  /* ── 2. 差异区块：序号砸下，证据条依次点亮 ───────────────── */
  if (hasAnime && !reduced) {
    var indexes = qa(".diff-index");
    var evidence = qa(".diff-evidence code");
    if (indexes.length) anime.set(indexes, { opacity: 0 });
    if (evidence.length) anime.set(evidence, { opacity: 0, translateY: 12 });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        entry.target.dataset.lit = "1";
        var el = entry.target;
        if (el.classList.contains("diff-head")) {
          var idx = el.querySelector(".diff-index");
          if (idx) {
            anime({
              targets: idx,
              opacity: [0, 1],
              scale: [0.55, 1],
              rotate: [-10, 0],
              duration: 720,
              delay: 130,
              easing: "easeOutBack",
            });
          }
        } else {
          var chips = el.querySelectorAll("code");
          if (chips.length) {
            anime({
              targets: chips,
              opacity: [0, 1],
              translateY: [12, 0],
              duration: 500,
              delay: anime.stagger(88, { start: 240 }),
            });
          }
        }
      });
    }, { threshold: 0.12 });
    var diffBlocks = qa(".diff-head, .diff-evidence");
    diffBlocks.forEach(function (el) { observer.observe(el); });

    /* 保底：上面那批是被 anime.set 写成行内 opacity:0 的，行内样式连
       prefers-reduced-motion 那条降级规则都盖不住。而 IntersectionObserver 只在
       "相交状态变化"的那一帧派发 —— 一次大滚动/拖滚动条/按 End/带位置刷新会让区块
       从视口下方直接跳到上方，回调一次都不来，序号和证据条就永久看不见。
       这里按盒子位置补一遍：已经越过的直接落终态，不再补动画。 */
    var settleBlock = function (el) {
      var targets = el.classList.contains("diff-head")
        ? el.querySelectorAll(".diff-index")
        : el.querySelectorAll("code");
      Array.prototype.forEach.call(targets, function (t) {
        t.style.opacity = "1";
        t.style.transform = "none";
      });
    };
    var sweeping = false;
    var sweep = function () {
      sweeping = false;
      diffBlocks.forEach(function (el) {
        if (el.dataset.lit) return;
        if (el.getBoundingClientRect().bottom >= 0) return;
        el.dataset.lit = "1";
        observer.unobserve(el);
        settleBlock(el);
      });
    };
    window.addEventListener("scroll", function () {
      if (!sweeping) { sweeping = true; requestAnimationFrame(sweep); }
    }, { passive: true });
    window.addEventListener("load", function () { requestAnimationFrame(sweep); });
    requestAnimationFrame(sweep);
  }

  /* ── 3. 事实跑马灯：把页面上已经说过的口径摊成一条底噪 ──────
     内容取自首页正文，刻意不写任何新数字——数字全由 check_docs_site 守卫。 */
  (function () {
    var host = q(".ticker");
    if (!host) return;
    var track = host.querySelector(".ticker-track");
    if (!track) return;

    var zh = track.getAttribute("data-lang") === "zh";
    var lines = zh ? [
      "MIT 协议",
      "密钥是你的 · 机器是你的",
      "无账号，无遥测",
      "一个循环内核，一本本地账本",
      "真人席位与模型同桌：谁说的记在谁名下",
      "停止会掐断流，子进程跟着一起被 kill",
      "data/chat_history.db 是你随手能打开的文件",
      "data/skills/my-skill/SKILL.md 下一条消息就生效",
      "没有 npm，没有打包器 —— 改文件、刷新、就能用",
      "mcp__{serverId}__{toolName}",
      "花销 = token 数，价格由你选的那家说了算",
    ] : [
      "MIT License",
      "your keys · your machine",
      "no account, no telemetry",
      "one loop kernel, one local ledger",
      "a human seat at the same table — every line attributed",
      "stop closes the stream — the child process dies with it",
      "data/chat_history.db is a file you can open",
      "data/skills/my-skill/SKILL.md goes live on the next message",
      "no npm, no bundler — edit a file, refresh, it works",
      "mcp__{serverId}__{toolName}",
      "usage = tokens, priced by the provider you chose",
    ];

    var html = lines.map(function (t) {
      var span = document.createElement("span");
      span.textContent = t;
      return span.outerHTML;
    }).join("");
    track.innerHTML = html + html; /* 两遍：位移 -50% 即可无缝循环 */
  })();

  /* ── 4. 导航当前章节：滚到哪一节，哪一条金线常驻 ─────────── */
  (function () {
    var links = qa('.nav-links a[href^="#"]');
    if (!links.length) return;

    var map = [];
    links.forEach(function (a) {
      var target = document.getElementById(a.getAttribute("href").slice(1));
      if (target) map.push({ link: a, target: target });
    });
    if (!map.length) return;

    var ticking = false;
    function update() {
      ticking = false;
      var line = window.scrollY + window.innerHeight * 0.32;
      var current = null;
      map.forEach(function (item) {
        if (item.target.offsetTop <= line) current = item;
      });
      map.forEach(function (item) {
        item.link.classList.toggle("is-active", item === current);
      });
    }

    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();
  })();
})();
