// ==UserScript==
// @name            TELAS Custom (Teikyo LMS Assistant)
// @namespace       TELAS-Custom
// @version         1.6.7-custom
// @description     Ultra 左侧导航：试题/作业、答题、批量下载、自动登录设置。支持简繁中文、日本语和 English。
// @description:zh-CN Ultra 左侧导航：试题/作业、答题、批量下载、自动登录设置。支持简繁中文、日本语和 English。
// @description:zh-TW Ultra 左側導覽：試題/作業、答題、批次下載、自動登入設定。支援繁簡中文、日本語和 English。
// @description:ja  Ultra の左メニューにテスト・課題、問題演習、一括ダウンロード、自動ログイン設定を追加します。
// @description:en  Adds tests/assignments, quiz helper, bulk download, and auto-login settings to Ultra.
// @author          NEMUI1218
// @match           https://lms2017.teikyo-u.ac.jp/*
// @match           https://vlib.ita.teikyo-u.ac.jp/Mediasite/*
// @match           https://teikyo.ex-tic.com/auth/session*
// @grant           GM_xmlhttpRequest
// @grant           GM.xmlHttpRequest
// @grant           GM_getValue
// @grant           GM.getValue
// @grant           GM_setValue
// @grant           GM.setValue
// @grant           GM_deleteValue
// @grant           GM.deleteValue
// @grant           unsafeWindow
// @grant           GM_cookie
// @grant           GM.cookie
// @connect         teikyo-u.ac.jp
// @connect         blackboard.com
// @connect         self
// @inject-into     content
// @run-at          document-start
// @noframes
// ==/UserScript==
/*
 * 兼容性说明（同一份脚本跑在两类管理器上）：
 * - Tampermonkey / Violentmonkey 认 GM_* 和 GM.*；iOS/macOS Safari 的 Userscripts 只认 GM.*（且只在
 *   @inject-into content 下提供 GM API），所以两套 @grant 都写上，代码里两种都探测。@connect 只有
 *   Tampermonkey 用，其余管理器忽略。
 * - Userscripts 的 GM.xmlHttpRequest 由扩展后台发请求，是否带上 Blackboard 的登录 Cookie 取决于 Safari，
 *   拿不准：取回的若是登录页 HTML 就判失败，再退回同源 fetch；仍失败的文件在树里给「↗ 手动打开」链接。
 * - iOS Safari 连续触发多个下载体验很差（逐个弹确认、可能被拦），所以 iOS 上默认打包成一个 ZIP，
 *   打包完再让用户点一下「保存」（保存需要用户手势）。
 */

/*
 * 下载为什么要用 GM_xmlhttpRequest：/bbcswebdav/ 文件地址会 302 跳到另一个域
 *（alt-*.blackboard.com → *.files.blackboard.com 的签名地址），浏览器里普通 fetch 跨域被 CORS
 * 挡住、读不到内容（全部失败）；而且最终响应是 inline，普通 <a download> 跨域时会直接在浏览器里打开
 * 而不是下载。GM_xmlhttpRequest 不受 CORS 限制，取到 blob 再本地另存。
 */

/*
 * 原理：复用浏览器登录会话，
 * 从 ROOT 遍历内容树，认 x-bb-file / x-bb-folder（递归）/ x-bb-document / x-bb-asmt-test-link
 *（抠 /bbcswebdav/ 链接）；讲义视频（Mediasite LTI）只给「打开」链接。学期从课程名识别、分组。
 * 只会碰你本人有权限的课程和文件。入口克隆现有导航项、SPA 重渲染后轮询补回。
 *
 * 答题模块复用同一条登录会话（BbRouter/BbSession + X-Blackboard-XSRF）。
 * BbRouter 是 HttpOnly，document.cookie 读不到 xsrf，所以额外拦截页面自己的 XHR/fetch 头、查 GM_cookie。
 */

(async function () {
  "use strict";

  // ---------------------------------------------------------------- 学校 App 的 SSO 入口 → 直接跳到 LMS
  // 从学校手机 App 打开 LMS 时，会先落到 Extic 的 https://teikyo.ex-tic.com/auth/session，
  // 不会直接进 lms2017。这里在页面渲染前（document-start）就跳到 lms2017，之后由自动登录模块接手。
  // 防死循环：15 秒内已经跳过一次又回到这里（比如 LMS 又把人送回 SSO），就停手，让页面按原流程走。
  // 其余 ex-tic 页面一律不碰，下面的 xsrf 钩子等也不会在 ex-tic 上安装。
  //
  if (location.hostname === "teikyo.ex-tic.com") {
    if (/^\/auth\/session\/?$/.test(location.pathname)) {
      const key = "telas_extic_redirect_ts";
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Date.now() - last > 15000) {
        sessionStorage.setItem(key, String(Date.now()));
        location.replace("https://lms2017.teikyo-u.ac.jp/");
      }
    }
    return;
  }

  const LMS = "https://lms2017.teikyo-u.ac.jp";
  const ORIGIN = location.origin;
  const API = (p) => ORIGIN + p;
  const NAV_ID = "bbdl-nav";
  const PANEL_ID = "bbdl-panel";
  const LS_THEME = "bbdl.theme";
  const LS_TERM = "bbdl.term";
  const LS_LANG = "bbdl.lang";
  const LS_ZIP = "bbdl.zip";
  // 答题面板
  const QZ_NAV_ID = "bbqz-nav";
  const QZ_PANEL_ID = "bbqz-panel";
  const TS_NAV_ID = "bbts-nav";
  const TS_PANEL_ID = "bbts-panel";
  const LS_TS_ARCHIVE = "bbts.archive.v1";
  const LS_QZ_THEME = "bbqz.theme";
  const LS_QZ_AIURL = "bbqz.aiurl";
  // iPadOS 默认报桌面 UA（MacIntel），靠触点数区分
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------------------------------------------------------------- xsrf 捕获（答题模块用）
  // 必须在页面脚本发出第一个请求之前挂钩，所以整段放在最前面，@run-at document-start 保证先跑。
  // BbRouter 是 HttpOnly，document.cookie 读不到，只能从“页面自己发出的请求头”里抓 token。
  //
  // 两种运行环境都要覆盖：
  //   A) Tampermonkey / Violentmonkey：unsafeWindow 就是真正的页面 window，
  //      直接改它的 XHR/fetch 就能拦到页面请求（下面的 direct hook）。
  //   B) iOS / macOS Safari 的 Userscripts：@inject-into content 下没有 unsafeWindow，
  //      脚本跑在隔离沙箱里，改沙箱的 window 拦不到页面请求。
  //      解决办法：往页面里插一段 <script>（在页面世界执行，不受沙箱限制），
  //      由它挂钩并回传 token（bridge script）。
  const PW = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;
  let capturedXsrf = "";
  let capturedSrc = "";
  const XSRF_MSG = "__bbqz_xsrf__";
  function noteXsrf(v, src) {
    try { if (v && typeof v === "string" && v.length >= 8 && v.length <= 128) { capturedXsrf = v; capturedSrc = src; } } catch (e) {}
  }
  // 沙箱侧接收 bridge 回传的 token（postMessage / 自定义事件 / DOM 属性三通道，谁先通用谁）
  try {
    // 用沙箱自己的 window 收消息：Firefox 上往页面 window（unsafeWindow）挂沙箱函数也可能出问题
    window.addEventListener("message", (ev) => {
      try {
        const d = ev && ev.data;
        if (d && d.__bbqz_xsrf__) noteXsrf(d.v, "bridge:" + (d.src || "?"));
      } catch (e) {}
    });
    document.addEventListener(XSRF_MSG, (ev) => {
      try { const d = ev && ev.detail; if (d && d.v) noteXsrf(d.v, "bridge-ev:" + (d.src || "?")); } catch (e) {}
    });
  } catch (e) {}
  // 在页面世界执行的一段钩子源码：抓到 X-Blackboard-XSRF 后回传沙箱。
  function bridgeSource() {
    return ";(function(){" +
      "if(window.__bbqz_xsrf_bridge)return;window.__bbqz_xsrf_bridge=1;" +
      "var MSG='" + XSRF_MSG + "';" +
      "function send(v,src){try{if(!v||typeof v!=='string'||v.length<8||v.length>128)return;" +
        "window.postMessage({__bbqz_xsrf__:1,v:v,src:src},'*');" +
        "try{document.dispatchEvent(new CustomEvent(MSG,{detail:{v:v,src:src}}));}catch(e){}" +
        "try{document.documentElement.setAttribute('data-bbqz-xsrf',v);}catch(e){}" +
      "}catch(e){}}" +
      "try{var XP=XMLHttpRequest.prototype,oO=XP.open,oS=XP.send,oH=XP.setRequestHeader;" +
        "XP.setRequestHeader=function(n,val){try{if(n&&/blackboard-xsrf/i.test(String(n)))send(val,'xhr');}catch(e){}return oH.apply(this,arguments);};" +
        "XP.open=function(m,u){try{var r=String(u||'').match(/[?&]X-Blackboard-XSRF=([^&#]+)/i);if(r){var v=r[1];try{v=decodeURIComponent(v);}catch(e){}send(v,'url');}}catch(e){}return oO.apply(this,arguments);};" +
        "XP.send=function(b){try{var r=String(b||'').match(/[?&]X-Blackboard-XSRF=([^&#]+)/i);if(r){var v=r[1];try{v=decodeURIComponent(v);}catch(e){}send(v,'body');}}catch(e){}return oS.apply(this,arguments);};" +
      "}catch(e){}" +
      "try{var oF=window.fetch;" +
        "if(typeof oF==='function'){window.fetch=function(input,init){try{var h=(init&&init.headers)||(input&&input.headers),v=null;" +
          "if(h&&typeof h.get==='function')v=h.get('X-Blackboard-XSRF')||h.get('x-blackboard-xsrf');" +
          "else if(h&&typeof h==='object')v=h['X-Blackboard-XSRF']||h['x-blackboard-xsrf'];" +
          "if(v)send(v,'fetch');}catch(e){}return oF.apply(this,arguments);};}" +
      "}catch(e){}" +
    "})();";
  }
  function installBridge() {
    try {
      const host = document.head || document.documentElement;
      if (!host) return false;
      if (document.getElementById("bbqz-xsrf-bridge")) return true;
      const s = document.createElement("script");
      s.id = "bbqz-xsrf-bridge";
      s.textContent = bridgeSource();
      host.appendChild(s);
      s.remove();
      return true;
    } catch (e) { return false; }
  }
  try {
    if (!installBridge()) {
      // document-start 时 <head> 还没出现：等它出现立刻装
      const mo = new MutationObserver(() => { if (installBridge()) mo.disconnect(); });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
      setTimeout(() => { try { installBridge(); mo.disconnect(); } catch (e) {} }, 0);
    }
  } catch (e) {}
  // 兼容路径 A：unsafeWindow 是真 window 时，直接在沙箱里再勾一遍（与 bridge 重复但幂等）
  // Firefox：unsafeWindow 是 Xray 解封后的页面 window，沙箱函数直接赋给页面对象，页面一调用就抛
  // "Permission denied to access object"，Blackboard 的所有 XHR/fetch 全挂 → 灰屏。
  // 所以 Firefox 上整段跳过，完全不从沙箱改页面对象；xsrf 只靠 bridge（页面世界）+ GM_cookie 获取。
  try {
    const IS_FX = /firefox/i.test(navigator.userAgent);
    const exp = (fn) => fn;
    if (!IS_FX && PW && PW !== window && !PW.__bbqz_xsrf_hooked) {
      PW.__bbqz_xsrf_hooked = true;
      const XP = PW.XMLHttpRequest.prototype;
      const origOpen = XP.open;
      const origSend = XP.send;
      const origSet = XP.setRequestHeader;
      const pickUrlToken = (s, src) => {
        const m = String(s || "").match(/[?&]X-Blackboard-XSRF=([^&#]+)/i);
        if (m) { let v = m[1]; try { v = decodeURIComponent(v); } catch (e) {} noteXsrf(v, src); }
      };
      // 有的前端用 xhr.setRequestHeader("X-Blackboard-XSRF", ...)，有的干脆把 token
      // 拼进 URL 或请求体（?X-Blackboard-XSRF=...），这几种都抓一下。
      XP.open = exp(function (method, url) {
        try { pickUrlToken(url, "page-url"); } catch (e) {}
        return origOpen.apply(this, arguments);
      });
      XP.send = exp(function (body) {
        try { if (typeof body === "string") pickUrlToken(body, "page-body"); } catch (e) {}
        return origSend.apply(this, arguments);
      });
      XP.setRequestHeader = exp(function (name, value) {
        try { if (name && /blackboard-xsrf/i.test(String(name))) noteXsrf(String(value), "page-xhr"); } catch (e) {}
        return origSet.apply(this, arguments);
      });
      const origFetch = PW.fetch;
      if (typeof origFetch === "function") {
        PW.fetch = exp(function (input, init) {
          try {
            const h = (init && init.headers) || (input && input.headers);
            let v = null;
            if (h && typeof h.get === "function") v = h.get("X-Blackboard-XSRF") || h.get("x-blackboard-xsrf");
            else if (h && typeof h === "object") v = h["X-Blackboard-XSRF"] || h["x-blackboard-xsrf"];
            if (v) noteXsrf(String(v), "page-fetch");
          } catch (e) {}
          return origFetch.apply(this, arguments);
        });
      }
    }
  } catch (e) { console.warn("[bbqz] xsrf hook skipped", e); }

  // ---------------------------------------------------------------- 多语言（默认日语）
  const T = {
    ja: {
      nav: "一括ダウンロード", title: "一括ダウンロード", sub_dl: "教材",
      theme: "テーマ", theme_light: "テーマ：ライト", theme_dark: "テーマ：ダーク",
      lang: "言語", close: "閉じる",
      pick: "学期とコースを選択", loading: "コースを読み込み中…",
      load_fail: "コースの読み込みに失敗：{0}（ログイン状態を確認）",
      count: "全 {0} コース", other: "その他",
      pick_course: "— コースを選択 —", scan: "スキャン", select_all: "すべて選択", download: "選択をダウンロード",
      scanning: "スキャン中…", found: "ファイル {0} 件", plus_videos: "（講義ビデオ {0} 件は🎬）",
      no_sel: "ファイルが選択されていません", downloading: "ダウンロード中 {0}/{1}：{2}",
      done: "完了：成功 {0}、失敗 {1}", done_err: "完了：成功 {0}、失敗 {1}（{2}）",
      vlink_title: "新しいタブで開く。ページ右下にダウンロードボタンが出ます",
      e_http: "HTTP {0}", e_net: "通信エラー", e_timeout: "タイムアウト", e_empty: "空のファイル",
      v_btn: "📥 ビデオをダウンロード (MP4)", v_resolving: "直リンク取得中…", v_started: "ダウンロード開始 ✓",
      v_fail: "失敗：{0}", v_no_mp4: "MP4 ストリームなし（HLS のみ、または権限なし）",
      v_not_play: "再生ページではありません", v_http: "GetPlayerOptions HTTP {0}",
      zip: "ZIP にまとめる", zipping: "ZIP 作成中…（{0} 件）", zip_save: "💾 ZIP を保存",
      zip_ready: "ZIP の準備完了：成功 {0}、失敗 {1}。「ZIP を保存」をタップ", zip_saved: "ZIP を保存しました：成功 {0}、失敗 {1}",
      e_login: "ログインページが返されました（Cookie が送られていない可能性）", manual: "新しいタブで開いて手動で保存", open_tab: "新しいタブで開く", copy_link: "リンクをコピー", link_copied: "リンクをコピーしました",
      al_title: "自動ログイン設定", al_sub: "ログイン", al_user: "ユーザー名（LMS ID）", al_pass: "パスワード",
      al_show: "表示", al_hide: "非表示", al_enable: "自動入力を有効にする",
      al_autosubmit: "入力後に自動でサインイン", al_delay: "自動ログインの遅延（ミリ秒）",
      al_clear: "アカウント削除", al_cancel: "キャンセル", al_save: "保存",
      al_cleared: "削除しました", al_saved: "保存しました",
      al_confirm_clear: "保存済みのユーザー名とパスワードを削除しますか？", al_nav: "自動ログイン設定",
      al_note: "ログイン後、左メニュー「自動ログイン設定」から変更できます。<br>パスワードはスクリプトマネージャーのローカルに平文で保存されます。共用端末では使用しないでください。<br>予備の入口：URL 末尾に <b>{0}</b>",
      qnav: "問題演習", qtitle: "問題演習サポート", sub_qz: "評量",
      pick_column: "— 評量を選択 —",
      getting_items: "評量を読み込み中…",
      selected_assessment: "選択: {0}",
      checking_attempt: "解答状況を確認中…",
      no_attempt_start: "進行中の attempt がありません。「受験を開始」を押してください",
      start_attempt: "受験を開始", creating_attempt: "attempt を作成中…",
      attempt_created: "attempt 作成: {0}", attempt_failed: "attempt 作成に失敗",
      attempt_resumed: "進行中の attempt を再開",
      no_attempt: "attempt がありません",
      attempt_limit_checking: "解答回数を確認中…",
      attempts_used: "解答回数: {0}/{1}",
      attempt_confirm_title: "確認",
      attempt_limit_reached: "解答回数の上限 ({0}) に達しました",
      attempt_confirm_msg: "{0}/{1} 回目の受験を開始しますか？",
      attempt_limit_unknown: "解答回数の上限が不明です。続行しますか？",
      attempt_confirm_unlimited: "解答回数に制限はありません。続行しますか？",
      loading_questions: "問題を読み込み中…", load_failed: "問題の読み込みに失敗",
      questions_loaded: "{0} 問読み込み完了",
      images_found: "画像 {0} 件",
      copy_ai: "問題をコピー", ask_ai: "AI に質問", copied: "コピーしました",
      attach_materials: "資料を添付", attach_materials_count: "資料を添付（{0}）",
      attach_title: "追加資料", attach_desc: "準備完了のファイル名をタップすると、そのファイルを共有します。",
      attach_loading: "現在のコースの PDF を読み込み中…", attach_none: "共有できる PDF がありません",
      attach_back: "戻る", attach_confirm: "追加を確定", attach_pick_one: "資料を選択してください",
      attach_preparing: "資料を準備中 {0}/{1}：{2}", attach_ready: "{0} 個の資料を準備しました",
      attach_failed: "資料を準備できませんでした：{0}", attach_not_pdf: "有効な PDF ではありません", attach_share_unsupported: "このブラウザーはファイル共有に対応していません。AI アプリのみ開きます。",
      attach_shared: "共有メニューを開きました", attach_share_cancelled: "共有をキャンセルしました",
      attach_save_files: "共有メニューで「ファイルに保存」を選択してください",
      open_ai_after_save: "ChatGPT を開く", attach_saved_next: "保存完了。もう一度押して ChatGPT を開いてください",
      ai_target_missing: "先に AI アプリまたは Web のアドレスを入力してください",
      select_quiz_first: "先に評量を選んでください",
      no_answers: "回答がありません",
      no_questions: "問題がありません",
      parse_ans: "解析", parsed_count: "解析済み: {0}/{1}", clear_input: "入力をクリア",
      submit_ans: "提出", confirm_submit: "{0} 問を提出しますか？",
      confirm_unanswered: "未回答: {0}",
      submit_done: "提出完了: 成功 {0}、失敗 {1}",
      submit_verify_failed: "書き込み後の確認に失敗しました（確認済み {0}/{1}）。ブラウザーで確認してください。",
      clear_ans: "全回答をクリア", confirm_clear: "すべての回答をクリアしますか？",
      clear_done: "クリア完了: 成功 {0}、失敗 {1}",
      browser_submit: "ブラウザで開く", browser_opened: "ブラウザで開きました",
      submit_manual: "サーバーがリクエストを拒否しました。attempt をブラウザで開きました。ページ内で手動で提出してください。",
      order_warning: "⚠ 問題の順番は LMS と同じです。AI の回答の番号と照合してください。",
      display_multi_select: "(複数選択可)",
      display_matching_options: "選択肢:",
      display_tf_true: "正",
      display_tf_false: "誤",
      ai_intro: "以下の問題に答えてください。各問題の番号 [1] に対応する答えを、次の形式で答えてください。\n",
      ai_intro_no_matching: "以下の問題に答えてください。答えは [番号] 答え の形式で、1 行に 1 問ずつ答えてください。\n例: [1] C\n",
      ai_matching_important: "【重要】マッチング問題の答え方（他の形式と混同しないでください）:\n",
      ai_matching_format1: "  [問題番号]-[小問番号] [答えの文字]\n",
      ai_matching_example: "  例: [1]-1 A, [1]-2 B, [1]-3 C\n",
      ai_matching_warning: "  ※ [1] A のような形式は使わないでください。\n",
      ai_other_format: "その他の問題:\n  選択問題: [番号] C または [番号] A, E（複数選択）\n  判断問題: [番号] 正 または [番号] 誤\n  填空問題: [番号]-1 答え1 | 答え2（複数空の場合）\n",
      ai_other_example: "  例: [2] C  [3] 正  [4] A, E  [5]-1 東京 | 大阪\n",
      ai_multi_format: "複数選択の問題は、該当するすべての選択肢の文字をカンマで区切って答えてください。\n",
      ai_fimb_format: "填空問題は、各空に答える語句を答えてください。\n",
      ai_images_note: "問題中の [Q1-1.png] は画像です。画像を別途確認してください。\n",
      preview_matching: "問{0}: {1}",
      preview_fimb: "問{0}: {1}",
      preview_truefalse: "問{0}: {1}",
      preview_choice: "問{0}: {1}",
      preview_over_limit: "⚠ 問{0}: {1} 件選択（上限 {2}）",
      preview_fimb_incomplete: "⚠ 問{0}: 空 {1} が未回答",
      preview_matching_incomplete: "⚠ 問{0}: 小問 {1} が未回答",
      preview_unanswered: "⚠ 未回答: {0}",
      question_group: "問題", answer_input_group: "AI の回答を貼り付け",
      preview_group: "解析結果", hint_text: "AI の回答をここに貼り付けてください",
      ai_url_label: "AI URL",
      f_term: "学期", f_course: "コース", f_column: "評量",
      dl_sec_course: "コースを選択", dl_desc: "コースを選ぶと教材を自動でスキャンします。講義ビデオ🎬は新しいタブで開きます。", dl_sec_files: "ファイル", dl_empty: "コースを選ぶと、ここにファイルが表示されます",
      qz_sec_pick: "評量を選択", qz_preview_empty: "AI の回答を貼り付けると、ここに解析結果が表示されます",
      al_sec_account: "アカウント", al_sec_behavior: "動作",
    },
    en: {
      nav: "Bulk Download", title: "Bulk Download", sub_dl: "Course materials",
      theme: "Theme", theme_light: "Theme: Light", theme_dark: "Theme: Dark",
      lang: "Language", close: "Close",
      pick: "Pick a term and course", loading: "Loading courses…",
      load_fail: "Failed to load courses: {0} (check you are logged in)",
      count: "{0} courses", other: "Other",
      pick_course: "— Select a course —", scan: "Scan", select_all: "Select all", download: "Download selected",
      scanning: "Scanning…", found: "{0} files", plus_videos: "({0} lecture videos, see 🎬)",
      no_sel: "No files selected", downloading: "Downloading {0}/{1}: {2}",
      done: "Done: {0} ok, {1} failed", done_err: "Done: {0} ok, {1} failed ({2})",
      vlink_title: "Opens in a new tab; a download button appears bottom-right",
      e_http: "HTTP {0}", e_net: "Network error", e_timeout: "Timeout", e_empty: "Empty file",
      v_btn: "📥 Download video (MP4)", v_resolving: "Getting direct link…", v_started: "Download started ✓",
      v_fail: "Failed: {0}", v_no_mp4: "No MP4 stream (HLS only, or no access)",
      v_not_play: "Not a play page", v_http: "GetPlayerOptions HTTP {0}",
      zip: "Pack as ZIP", zipping: "Building ZIP… ({0} files)", zip_save: "💾 Save ZIP",
      zip_ready: "ZIP ready: {0} ok, {1} failed. Tap “Save ZIP”", zip_saved: "ZIP saved: {0} ok, {1} failed",
      e_login: "Got the login page instead (cookies may not have been sent)", manual: "Open in a new tab and save manually", open_tab: "Open in a new tab", copy_link: "Copy link", link_copied: "Link copied",
      al_title: "Auto-login Settings", al_sub: "Login", al_user: "Username (LMS ID)", al_pass: "Password",
      al_show: "Show", al_hide: "Hide", al_enable: "Enable auto-fill",
      al_autosubmit: "Auto-click Sign in after filling", al_delay: "Auto-login delay (ms)",
      al_clear: "Clear account", al_cancel: "Cancel", al_save: "Save",
      al_cleared: "Cleared", al_saved: "Saved",
      al_confirm_clear: "Clear the saved username and password?", al_nav: "Auto-login Settings",
      al_note: "After logging in, change it from “Auto-login Settings” in the left menu.<br>The password is stored in plain text in your userscript manager's local storage. Do not use on shared devices.<br>Fallback entry: append <b>{0}</b> to the URL",
      qnav: "Quiz", qtitle: "Quiz Helper", sub_qz: "Assessment",
      pick_column: "— Select assessment —",
      getting_items: "Loading assessments…",
      selected_assessment: "Selected: {0}",
      checking_attempt: "Checking attempts…",
      no_attempt_start: "No in-progress attempt. Press Start.",
      start_attempt: "Start attempt", creating_attempt: "Creating attempt…",
      attempt_created: "Attempt created: {0}", attempt_failed: "Attempt creation failed",
      attempt_resumed: "Resumed in-progress attempt",
      no_attempt: "No attempt",
      attempt_limit_checking: "Checking attempt limit…",
      attempts_used: "Attempts: {0}/{1}",
      attempt_confirm_title: "Confirm",
      attempt_limit_reached: "Attempt limit reached ({0})",
      attempt_confirm_msg: "Start attempt {0}/{1}?",
      attempt_limit_unknown: "Attempt limit unknown. Continue?",
      attempt_confirm_unlimited: "Unlimited attempts. Continue?",
      loading_questions: "Loading questions…", load_failed: "Failed to load questions",
      questions_loaded: "{0} questions loaded",
      images_found: "{0} images",
      copy_ai: "Copy questions", ask_ai: "Ask AI", copied: "Copied",
      attach_materials: "Attach materials", attach_materials_count: "Attach materials ({0})",
      attach_title: "Additional materials", attach_desc: "Tap a ready file name to share that file.",
      attach_loading: "Loading PDFs for this course…", attach_none: "No shareable PDFs found",
      attach_back: "Back", attach_confirm: "Add selected", attach_pick_one: "Select at least one material",
      attach_preparing: "Preparing {0}/{1}: {2}", attach_ready: "Prepared {0} materials",
      attach_failed: "Could not prepare materials: {0}", attach_not_pdf: "Not a valid PDF", attach_share_unsupported: "This browser cannot share files. Opening the AI app only.",
      attach_shared: "Opened the share sheet", attach_share_cancelled: "Sharing cancelled",
      attach_save_files: "Choose Save to Files in the share sheet",
      open_ai_after_save: "Open ChatGPT", attach_saved_next: "Saved. Tap again to open ChatGPT",
      ai_target_missing: "Enter an AI app or web address first",
      select_quiz_first: "Select an assessment first",
      no_answers: "No answers",
      no_questions: "No questions",
      parse_ans: "Parse", parsed_count: "Parsed: {0}/{1}", clear_input: "Clear input",
      submit_ans: "Submit", confirm_submit: "Submit {0} answers?",
      confirm_unanswered: "Unanswered: {0}",
      submit_done: "Submitted: {0} ok, {1} failed",
      submit_verify_failed: "Could not verify saved answers ({0}/{1} verified). Check them in the browser.",
      clear_ans: "Clear all answers", confirm_clear: "Clear all answers?",
      clear_done: "Cleared: {0} ok, {1} failed",
      browser_submit: "Open in browser", browser_opened: "Opened in browser",
      submit_manual: "The server rejected the request. Opened the attempt in a browser — please submit there manually.",
      order_warning: "⚠ Question order matches LMS. Match AI answer numbers.",
      display_multi_select: "(multi-select)",
      display_matching_options: "Options:",
      display_tf_true: "True",
      display_tf_false: "False",
      ai_intro: "Answer the following questions. Reply in format [number] answer, one per line.\n",
      ai_intro_no_matching: "Answer the following questions. Reply in format [number] answer, one per line.\nExample: [1] C\n",
      ai_matching_important: "IMPORTANT: matching questions format:\n",
      ai_matching_format1: "  [Q]-[sub] [letter]\n",
      ai_matching_example: "  Example: [1]-1 A, [1]-2 B, [1]-3 C\n",
      ai_matching_warning: "  Do NOT use [1] A format.\n",
      ai_other_format: "Other questions:\n  Choice: [n] C or [n] A, E (multi)\n  True/False: [n] True or [n] False\n  Fill-in: [n]-1 ans1 | ans2\n",
      ai_other_example: "  Example: [2] C  [3] True  [4] A, E  [5]-1 Tokyo | Osaka\n",
      ai_multi_format: "For multi-select, list all correct letters separated by commas.\n",
      ai_fimb_format: "Fill in each blank.\n",
      ai_images_note: "[Q1-1.png] markers are images; check them separately.\n",
      preview_matching: "Q{0}: {1}",
      preview_fimb: "Q{0}: {1}",
      preview_truefalse: "Q{0}: {1}",
      preview_choice: "Q{0}: {1}",
      preview_over_limit: "⚠ Q{0}: {1} selected (limit {2})",
      preview_fimb_incomplete: "⚠ Q{0}: blank {1} unanswered",
      preview_matching_incomplete: "⚠ Q{0}: sub {1} unanswered",
      preview_unanswered: "⚠ Unanswered: {0}",
      question_group: "Questions", answer_input_group: "Paste AI answer",
      preview_group: "Parsed result", hint_text: "Paste AI answer here",
      ai_url_label: "AI URL",
      f_term: "Term", f_course: "Course", f_column: "Assessment",
      dl_sec_course: "Choose a course", dl_desc: "Picking a course scans its materials automatically. Lecture videos 🎬 open in a new tab.", dl_sec_files: "Files", dl_empty: "Pick a course to list its files here",
      qz_sec_pick: "Choose an assessment", qz_preview_empty: "Paste the AI answer above to see the parsed result here",
      al_sec_account: "Account", al_sec_behavior: "Behavior",
    },
    zh: {
      nav: "批量下载", title: "批量下载", sub_dl: "课程资料",
      theme: "主题", theme_light: "主题：浅色", theme_dark: "主题：深色",
      lang: "语言", close: "关闭",
      pick: "选择学期和课程", loading: "加载课程中…",
      load_fail: "加载课程失败：{0}（确认已登录）",
      count: "共 {0} 门课", other: "其他",
      pick_course: "— 选择课程 —", scan: "扫描", select_all: "全选", download: "下载选中",
      scanning: "扫描中…", found: "找到 {0} 个文件", plus_videos: "（另有 {0} 个讲义视频，见🎬）",
      no_sel: "没有选中任何文件", downloading: "下载中 {0}/{1}：{2}",
      done: "完成：成功 {0}，失败 {1}", done_err: "完成：成功 {0}，失败 {1}（{2}）",
      vlink_title: "在新标签打开视频；页面右下角会出现下载按钮",
      e_http: "HTTP {0}", e_net: "网络错误", e_timeout: "超时", e_empty: "空文件",
      v_btn: "📥 下载视频 (MP4)", v_resolving: "获取直链中…", v_started: "已开始下载 ✓",
      v_fail: "失败：{0}", v_no_mp4: "没有 MP4 流（可能是仅 HLS 或无权限）",
      v_not_play: "不是播放页", v_http: "GetPlayerOptions HTTP {0}",
      zip: "打包成 ZIP", zipping: "正在打包 ZIP…（{0} 个）", zip_save: "💾 保存 ZIP",
      zip_ready: "ZIP 已就绪：成功 {0}，失败 {1}。点「保存 ZIP」", zip_saved: "ZIP 已保存：成功 {0}，失败 {1}",
      e_login: "返回的是登录页（可能没带上 Cookie）", manual: "在新标签打开，手动保存", open_tab: "在新标签打开", copy_link: "复制链接", link_copied: "已复制链接",
      al_title: "自动登录设置", al_sub: "登录", al_user: "用户名（LMS ID）", al_pass: "密码",
      al_show: "显示", al_hide: "隐藏", al_enable: "启用自动填写",
      al_autosubmit: "填写后自动点击サインイン", al_delay: "自动登录延迟（毫秒）",
      al_clear: "清除账号", al_cancel: "取消", al_save: "保存",
      al_cleared: "已清除", al_saved: "已保存",
      al_confirm_clear: "确定清除已保存的用户名和密码？", al_nav: "自动登录设置",
      al_note: "登录后可在左侧菜单「自动登录设置」中修改。<br>密码以明文保存在脚本管理器的本地存储中，请勿在公用设备使用。<br>备用入口：网址末尾加上 <b>{0}</b>",
      qnav: "答题", qtitle: "答题助手", sub_qz: "测验",
      pick_column: "— 选择测验 —",
      getting_items: "加载测验中…",
      selected_assessment: "已选：{0}",
      checking_attempt: "检查作答状态…",
      no_attempt_start: "没有进行中的 attempt，请点击「开始尝试」",
      start_attempt: "开始尝试", creating_attempt: "创建 attempt…",
      attempt_created: "attempt 已创建：{0}", attempt_failed: "创建 attempt 失败",
      attempt_resumed: "继续进行中的 attempt",
      no_attempt: "没有 attempt",
      attempt_limit_checking: "检查作答次数…",
      attempts_used: "作答次数：{0}/{1}",
      attempt_confirm_title: "确认",
      attempt_limit_reached: "已达到作答次数上限（{0}）",
      attempt_confirm_msg: "开始第 {0}/{1} 次作答？",
      attempt_limit_unknown: "作答次数上限未知，继续？",
      attempt_confirm_unlimited: "作答次数无限制，继续？",
      loading_questions: "加载题目中…", load_failed: "加载题目失败",
      questions_loaded: "已加载 {0} 题",
      images_found: "图片 {0} 张",
      copy_ai: "复制题目", ask_ai: "询问 AI", copied: "已复制",
      attach_materials: "附加课件", attach_materials_count: "附加课件（{0}）",
      attach_title: "附加课件", attach_desc: "点击准备完成的文件名，即可分享该文件。",
      attach_loading: "正在读取当前课程的 PDF…", attach_none: "当前课程没有可分享的 PDF",
      attach_back: "返回", attach_confirm: "确认添加", attach_pick_one: "请至少选择一个课件",
      attach_preparing: "正在准备 {0}/{1}：{2}", attach_ready: "已准备 {0} 个课件",
      attach_failed: "课件准备失败：{0}", attach_not_pdf: "不是有效的 PDF 文件", attach_share_unsupported: "当前浏览器不支持分享文件，将只打开 AI 应用。",
      attach_shared: "已打开系统分享菜单", attach_share_cancelled: "已取消分享",
      attach_save_files: "请在分享菜单中选择“存储到文件”",
      open_ai_after_save: "打开 ChatGPT", attach_saved_next: "课件已保存；请再次点击打开 ChatGPT",
      ai_target_missing: "请先填写 AI 应用或网页地址",
      select_quiz_first: "请先选择测验",
      no_answers: "没有答案",
      no_questions: "没有题目",
      parse_ans: "解析", parsed_count: "已解析：{0}/{1}", clear_input: "清空输入",
      submit_ans: "提交", confirm_submit: "提交 {0} 题的答案？",
      confirm_unanswered: "未答：{0}",
      submit_done: "提交完成：成功 {0}，失败 {1}",
      submit_verify_failed: "答案写入后验证失败（已确认 {0}/{1}），请在浏览器中检查。",
      clear_ans: "清空全部答案", confirm_clear: "清空全部答案？",
      clear_done: "清空完成：成功 {0}，失败 {1}",
      browser_submit: "在浏览器打开", browser_opened: "已在浏览器打开",
      submit_manual: "服务器拒绝了请求。已在浏览器打开该 attempt，请在页面里手动提交。",
      order_warning: "⚠ 题目顺序与 LMS 一致，请对照 AI 回答的编号。",
      display_multi_select: "（可多选）",
      display_matching_options: "选项：",
      display_tf_true: "正",
      display_tf_false: "误",
      ai_intro: "请回答以下问题。请按 [编号] 答案 的格式，每行一题作答。\n",
      ai_intro_no_matching: "请回答以下问题。请按 [编号] 答案 的格式，每行一题作答。\n例：[1] C\n",
      ai_matching_important: "【重要】匹配题的作答格式（不要与其他题型混淆）：\n",
      ai_matching_format1: "  [题号]-[小题号] [字母]\n",
      ai_matching_example: "  例：[1]-1 A, [1]-2 B, [1]-3 C\n",
      ai_matching_warning: "  ※ 不要使用 [1] A 这样的格式。\n",
      ai_other_format: "其他题型：\n  选择题：[编号] C 或 [编号] A, E（多选）\n  判断题：[编号] 正 或 [编号] 误\n  填空题：[编号]-1 答案1 | 答案2（多空）\n",
      ai_other_example: "  例：[2] C  [3] 正  [4] A, E  [5]-1 东京 | 大阪\n",
      ai_multi_format: "多选题请用逗号分隔所有正确选项字母。\n",
      ai_fimb_format: "请填写每个空。\n",
      ai_images_note: "题目中的 [Q1-1.png] 为图片标记，请另行查看。\n",
      preview_matching: "第{0}题：{1}",
      preview_fimb: "第{0}题：{1}",
      preview_truefalse: "第{0}题：{1}",
      preview_choice: "第{0}题：{1}",
      preview_over_limit: "⚠ 第{0}题：选了 {1} 项（上限 {2}）",
      preview_fimb_incomplete: "⚠ 第{0}题：空 {1} 未答",
      preview_matching_incomplete: "⚠ 第{0}题：小题 {1} 未答",
      preview_unanswered: "⚠ 未答：{0}",
      question_group: "题目", answer_input_group: "粘贴 AI 回答",
      preview_group: "解析结果", hint_text: "请在此粘贴 AI 的回答",
      ai_url_label: "AI 网址",
      f_term: "学期", f_course: "课程", f_column: "测验",
      dl_sec_course: "选择课程", dl_desc: "选择课程后会自动扫描资料。讲义视频🎬在新标签页打开。", dl_sec_files: "文件", dl_empty: "选择课程后，文件会列在这里",
      qz_sec_pick: "选择测验", qz_preview_empty: "在上方粘贴 AI 的回答后，解析结果会显示在这里",
      al_sec_account: "账号", al_sec_behavior: "行为",
    },
  };
  // 繁體中文是獨立語言選項。既有簡體使用者仍保留 zh，舊設定不會被改寫。
  const TRAD_CHARS = {
    "简":"簡","体":"體","课":"課","程":"程","资":"資","料":"料","题":"題","试":"試","业":"業","页":"頁","签":"籤","载":"載","选":"選","择":"擇","显":"顯","示":"示","账":"帳","号":"號","码":"碼","启":"啟","填":"填","写":"寫","清":"清","览":"覽","网":"網","络":"絡","错":"錯","误":"誤","获":"獲","链":"鏈","接":"接","复":"複","制":"製","开":"開","关":"關","发":"發","现":"現","图":"圖","张":"張","问":"問","答":"答","测":"測","验":"驗","尝":"嘗","续":"續","进":"進","行":"行","达":"達","限":"限","认":"認","确":"確","览":"覽","浏":"瀏","览":"覽","储":"儲","存":"存","个":"個","门":"門","另":"另","义":"義","频":"頻","仅":"僅","权":"權","将":"將","应":"應","该":"該","这":"這","与":"與","为":"為","结":"結","果":"果","对":"對","照":"照","编":"編","号":"號","粘":"貼","贴":"貼","项":"項","条":"條","后":"後","里":"裡","单":"單","击":"擊","归":"歸","档":"檔","历":"歷","录":"錄","读":"讀","取":"取","败":"敗","详":"詳","细":"細","态":"態","总":"總","数":"數","间":"間","时":"時","无":"無","从":"從","属":"屬","称":"稱","类":"類","别":"別","满":"滿","过":"過","滤":"濾","务":"務","动":"動","护":"護","统":"統","拟":"擬","际":"際","标":"標","点":"點","击":"擊","换":"換","独":"獨","立":"立","并":"並","扩":"擴","缩":"縮","顶":"頂","级":"級","边":"邊","导":"導","击":"擊","询":"詢","暂":"暫","栏":"欄","转":"轉","写":"寫","检":"檢","视":"視","创":"創","组":"組","钟":"鐘","毕":"畢","递":"遞","弹":"彈","窗":"窗","笔":"筆","记":"記","处":"處","规":"規","范":"範","顺":"順","序":"序","类":"類","别":"別","输":"輸","入":"入","护":"護","扫":"掃","描":"描","讲":"講","视":"視","则":"則","务":"務","导":"導","汇":"彙","县":"縣","云":"雲","万":"萬","东京":"東京"
  };
  const toTraditional = (value) => String(value).replace(/./g, (ch) => TRAD_CHARS[ch] || ch);
  T.zh_tw = Object.fromEntries(Object.entries(T.zh).map(([key, value]) => [key, toTraditional(value)]));
  const TS_TEXT = {
    ja:{ts_nav:"テスト・課題",ts_title:"テスト・課題",ts_sub:"管理",ts_completed:"完了履歴",ts_archived:"アーカイブ済み",ts_unfinished:"未完了",ts_archive:"アーカイブへ",ts_unarchive:"アーカイブから戻す",ts_refresh:"更新",ts_loading:"選択した学期の全コースを読み込み中…",ts_failed:"このコースのテストを読み込めませんでした",ts_empty:"このコースには対象のテストがありません",ts_name:"名称",ts_due:"提出期限",ts_attempts:"回答回数",ts_points:"点数",ts_type:"種類",ts_detail:"詳細",ts_course:"コース",ts_status:"状態",ts_url:"Blackboard で開く",ts_close:"閉じる",ts_test:"テスト"},
    en:{ts_nav:"Tests / Assignments",ts_title:"Tests / Assignments",ts_sub:"Manager",ts_completed:"Completion History",ts_archived:"Archived",ts_unfinished:"Unfinished",ts_archive:"Move to Archive",ts_unarchive:"Remove from Archive",ts_refresh:"Refresh",ts_loading:"Loading every course in this term…",ts_failed:"Could not load tests for this course",ts_empty:"No matching tests in this course",ts_name:"Name",ts_due:"Due date",ts_attempts:"Attempts",ts_points:"Points",ts_type:"Type",ts_detail:"Details",ts_course:"Course",ts_status:"Status",ts_url:"Open in Blackboard",ts_close:"Close",ts_test:"Test"},
    zh:{ts_nav:"试题/作业",ts_title:"试题/作业",ts_sub:"管理",ts_completed:"完成历史",ts_archived:"已归档",ts_unfinished:"未完成",ts_archive:"移至归档",ts_unarchive:"移出归档",ts_refresh:"刷新",ts_loading:"正在读取所选学期的全部课程…",ts_failed:"此课程试题读取失败",ts_empty:"此课程暂未发现对应试题",ts_name:"名称",ts_due:"截止日期",ts_attempts:"答题次数",ts_points:"点数",ts_type:"类型",ts_detail:"详细信息",ts_course:"课程",ts_status:"状态",ts_url:"在 Blackboard 打开",ts_close:"关闭",ts_test:"试题"},
    zh_tw:{ts_nav:"試題/作業",ts_title:"試題/作業",ts_sub:"管理",ts_completed:"完成歷史",ts_archived:"已封存",ts_unfinished:"未完成",ts_archive:"移至封存",ts_unarchive:"移出封存",ts_refresh:"重新整理",ts_loading:"正在讀取所選學期的全部課程…",ts_failed:"此課程試題讀取失敗",ts_empty:"此課程暫未發現對應試題",ts_name:"名稱",ts_due:"截止日期",ts_attempts:"作答次數",ts_points:"分數",ts_type:"類型",ts_detail:"詳細資訊",ts_course:"課程",ts_status:"狀態",ts_url:"在 Blackboard 開啟",ts_close:"關閉",ts_test:"試題"}
  };
  for (const [locale, values] of Object.entries(TS_TEXT)) Object.assign(T[locale], values);
  T.ja.ts_manage = "未完了の課題";
  T.en.ts_manage = "Unfinished tasks";
  T.zh.ts_manage = "未完成课题";
  T.zh_tw.ts_manage = "未完成課題";
  T.ja.ts_found = "テスト・課題 {0} 件";
  T.en.ts_found = "{0} tests / assignments";
  T.zh.ts_found = "共找到 {0} 个试题/作业";
  T.zh_tw.ts_found = "共找到 {0} 個試題/作業";
  let lang = "ja";

  // ---------------------------------------------------------------- 工具
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const t = (k, ...a) => {
    let s = (T[lang] && T[lang][k]) != null ? T[lang][k] : (T.ja[k] != null ? T.ja[k] : k);
    a.forEach((v, i) => (s = s.replace("{" + i + "}", v)));
    return s;
  };
  const sanitize = (s) => (s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  lang = store.get(LS_LANG, "ja"); // 默认日语；旧版 zh 继续代表简体中文
  if (!T[lang]) lang = "ja";
  // 语言是全局的：下载面板、答题面板和自动登录设置共用一个 bbdl.lang，任一处切换都广播给所有已打开的界面
  const langHooks = new Set();
  function setLang(l) {
    lang = T[l] ? l : "ja";
    store.set(LS_LANG, lang);
    langHooks.forEach((f) => { try { f(); } catch (e) { console.warn(e); } });
  }

  // ---- 学期识别 ----
  const TERM_RE = /(20\d{2})\s*(?:年度|年)?\s*(前期|後期|后期|通年|集中|春学期|秋学期|春|秋)/;
  const NORMALIZE = { "后期": "後期", "春学期": "前期", "春": "前期", "秋学期": "後期", "秋": "後期" };
  const TERM_ORDER = { "後期": 0, "集中": 1, "前期": 2, "通年": 3 };
  function termOf(name) {
    const m = TERM_RE.exec(name || "");
    if (!m) return ["", (name || "").trim()];
    const season = NORMALIZE[m[2]] || m[2];
    const rest = (name.slice(0, m.index) + name.slice(m.index + m[0].length))
      .replace(/^[\s　\-_・:：/]+|[\s　\-_・:：/]+$/g, "");
    return [m[1] + season, rest || name.trim()];
  }
  function sortKey(t) {
    const m = /^(\d{4})(.*)$/.exec(t);
    return [-parseInt(m[1], 10), TERM_ORDER[m[2]] ?? 9, m[2]];
  }
  function groupCourses(courses) {
    const groups = {};
    for (const c of courses) {
      const [t, short] = termOf(c.name);
      (groups[t] = groups[t] || []).push({ id: c.id, name: c.name, short });
    }
    let terms = Object.keys(groups).filter((t) => t !== "");
    terms.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(kb[2]);
    });
    if ("" in groups) terms.push("");
    for (const t of terms) groups[t].sort((a, b) => a.short.localeCompare(b.short, "ja"));
    return terms.map((t) => [t, groups[t]]);
  }

  // ---------------------------------------------------------------- 数据层
  async function getJSON(url) {
    const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function extractFiles(html) {
    const out = [];
    if (!html) return out;
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const a of doc.querySelectorAll('a[href*="/bbcswebdav/"]')) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      let name = "";
      const bbfile = a.getAttribute("data-bbfile");
      if (bbfile) {
        try {
          const info = JSON.parse(bbfile);
          name = info.fileName || info.linkName || info.displayName || "";
        } catch (e) {}
      }
      if (!name) name = (a.textContent || "").trim();
      if (name && name.includes(".")) out.push({ type: "file", name, url: href.replace(ORIGIN, "") });
    }
    return out;
  }

  // 判断 BLTI 条目是不是 Mediasite 讲义视频。只看 customParams.presentationId 不够：
  // 别的 LTI 工具也可能带同名字段，会误报成「講義ビデオ」。所以三个信号里至少认一个：
  //   1) linkRef / handler 指向 Mediasite 的 Building Block（scsk-BbMediaSiteLink）；
  //   2) 工具地址或 toolId 里出现 mediasite / vlib；
  //   3) presentationId 配合 linkRef 里的 forward.jsp?conType=Presentation。
  // 只认得出明确是 Mediasite 的才算视频，认不出的当普通内容忽略。
  function isMediasiteVideo(blti, item) {
    if (!blti) return false;
    const cp = blti.customParams || {};
    if (!cp.presentationId) return false;
    const linkRef = String((item && item.linkRef) || "");
    const toolRef = String(
      blti.launchUrl || blti.url || blti.toolUrl || blti.tool_id || blti.toolId ||
      blti.providerId || blti.providerUrl || ""
    );
    const hay = `${linkRef} ${toolRef} ${JSON.stringify(blti.customParams || {})}`;
    if (/mediasite|vlib\.ita|BbMediaSiteLink/i.test(hay)) return true;
    // linkRef 明确指向 Mediasite 的旧式 Building Block：forward.jsp?conType=Presentation
    if (/forward\.jsp/i.test(linkRef) && /conType=Presentation/i.test(linkRef)) return true;
    return false;
  }

  // 返回嵌套节点：{type:'folder',name,children} / {type:'file',name,url,folder} / {type:'video',name,launch,folder}
  async function scanTree(cid, contentId, folderPath, log) {
    const nodes = [];
    let data;
    try {
      data = await getJSON(API(`/learn/api/v1/courses/${cid}/contents/${contentId}/children?@view=Summary&limit=1000`));
    } catch (e) {
      return nodes;
    }
    for (const item of data.results || []) {
      const title = item.title || "";
      const detail = item.contentDetail || {};
      const handler = item.contentHandler || "";
      const has = (k) => k in detail || handler === k;

      if (has("resource/x-bb-file")) {
        const file = (detail["resource/x-bb-file"] || {}).file || {};
        if (file.fileName) nodes.push({ type: "file", name: file.fileName, url: (file.permanentUrl || "").replace(ORIGIN, ""), folder: folderPath, modified: item.modified || item.created || "" });
      } else if (has("resource/x-bb-folder")) {
        log(`📁 ${folderPath}${title}`);
        const children = await scanTree(cid, item.id, folderPath + sanitize(title) + " / ", log);
        if (children.length) nodes.push({ type: "folder", name: title, children, modified: item.modified || item.created || "" });
      } else if (has("resource/x-bb-document")) {
        for (const f of extractFiles((item.body || {}).rawText || "")) nodes.push({ ...f, folder: folderPath, modified: item.modified || item.created || "" });
      } else if (has("resource/x-bb-asmt-test-link")) {
        const asmt = (((detail["resource/x-bb-asmt-test-link"] || {}).test || {}).assessment || {});
        for (const f of extractFiles((asmt.instructions || {}).rawText || "")) nodes.push({ ...f, folder: folderPath, modified: item.modified || item.created || "" });
      } else if (has("resource/x-bb-blti-link")) {
        const blti = detail["resource/x-bb-blti-link"] || {};
        if (isMediasiteVideo(blti, item)) {
          nodes.push({ type: "video", name: sanitize(title) + ".mp4", folder: folderPath,
            launch: `/webapps/blackboard/execute/blti/launchLink?course_id=${cid}&content_id=${item.id}` });
        }
      }
    }
    return nodes;
  }

  async function getCourses() {
    const me = await getJSON(API("/learn/api/v1/users/me"));
    const data = await getJSON(
      API(`/learn/api/v1/users/${me.id}/memberships?expand=course.effectiveAvailability,courseRole&includeCount=true&limit=10000`)
    );
    const courses = [];
    for (const m of data.results || []) {
      const c = m.course || {};
      if (c.id && c.name) courses.push({ id: c.id, name: c.name });
    }
    return courses;
  }

  // GM 跨域请求：Tampermonkey/Violentmonkey 有 GM_xmlhttpRequest，Userscripts(Safari) 只有 GM.xmlHttpRequest
  function gmXhr() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") return GM.xmlHttpRequest;
    return null;
  }
  // 各管理器回传的 response 形态不一（Blob / ArrayBuffer / 字节数组），统一成 Blob；跨 realm 时 instanceof 不可靠，按形状判断
  function toBlob(r) {
    if (!r) return null;
    if (typeof r.arrayBuffer === "function" && typeof r.size === "number") return r;
    if (r.byteLength != null) return new Blob([r]);
    if (Array.isArray(r)) return new Blob([new Uint8Array(r)]);
    return null;
  }
  function gmGet(gm, url) {
    return new Promise((resolve, reject) => {
      const ret = gm({
        method: "GET",
        url,
        responseType: "blob",
        anonymous: false, // 带上浏览器的 cookie（Tampermonkey 认；Userscripts 忽略）
        onload: (res) => {
          const blob = toBlob(res.response);
          (res.status >= 200 && res.status < 300 && blob) ? resolve(blob) : reject(new Error(t("e_http", res.status)));
        },
        onerror: () => reject(new Error(t("e_net"))),
        ontimeout: () => reject(new Error(t("e_timeout"))),
      });
      // Userscripts 的 GM.xmlHttpRequest 还会返回 Promise，失败已由回调处理，这里吞掉免得报未处理的 rejection
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    });
  }
  // 没带上登录 Cookie 时服务器会 200 返回登录页 HTML，不能当成文件存下来
  async function checkBlob(blob, name) {
    if (!blob || !blob.size) throw new Error(t("e_empty"));
    if (!/\.html?$/i.test(name || "")) {
      const head = await blob.slice(0, 1024).text().catch(() => "");
      if (/^\s*(<!doctype html|<html)/i.test(head)) throw new Error(t("e_login"));
    }
    return blob;
  }
  // 先走 GM 请求（不受 CORS 限制，能跟随跨域跳转），失败再退回同源 fetch；都失败报第一个错误
  async function fetchBlob(url, name) {
    const errs = [];
    const gm = gmXhr();
    if (gm) {
      try { return await checkBlob(await gmGet(gm, url), name); } catch (e) { errs.push(e); }
    }
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(t("e_http", r.status));
      return await checkBlob(await r.blob(), name);
    } catch (e) { errs.push(e); }
    throw errs[0];
  }

  const absUrl = (u) => (u.startsWith("http") ? u : ORIGIN + u);

  function saveBlob(blob, fname) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // iOS 的下载确认框可能停留较久，晚一点再回收
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }

  async function downloadOne(f) {
    const blob = await fetchBlob(absUrl(f.url), f.name);
    // 只用原文件名，不加文件夹前缀；重名时浏览器会自动在后面加 (1)
    saveBlob(blob, sanitize(f.name));
  }

  // ---- 极简 ZIP 打包（仅 store、不压缩；文件名 UTF-8 标志位，日文名在 Windows/macOS/iOS 都不乱码）----
  const CRC_TABLE = (() => {
    const tb = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tb[n] = c >>> 0;
    }
    return tb;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // entries: [{ path: "文件夹/子文件夹/文件名.pdf", blob }]
  async function buildZip(entries) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const body = [], central = [];
    let offset = 0;
    for (const { path, blob } of entries) {
      const name = enc.encode(path);
      const crc = crc32(new Uint8Array(await blob.arrayBuffer())); // 只为算 CRC，内容本身仍用 blob 拼接，省内存
      const size = blob.size;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      body.push(lh, name, blob);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...body, ...central, end], { type: "application/zip" });
  }
  // ZIP 内结构：<课程名>/<文件名>。不保留 Blackboard 里的内容文件夹（授業資料 等），
  // 同一课程里重名时加 (2)、(3)…
  function zipPath(f, used, dir) {
    const base = sanitize(f.name) || "file";
    let p = (dir ? dir + "/" : "") + base, n = 1;
    while (used.has(p.toLowerCase())) {
      n++;
      const m = /^(.*?)(\.[^.\/]*)?$/.exec(base);
      p = (dir ? dir + "/" : "") + m[1] + ` (${n})` + (m[2] || "");
    }
    used.add(p.toLowerCase());
    return p;
  }
  // ---------------------------------------------------------------- 下载面板
  const DL_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 1a1 1 0 0 1 1 1v6.586l1.293-1.293a1 1 0 1 1 1.414 1.414l-3 3a1 1 0 0 1-1.414 0l-3-3a1 1 0 1 1 1.414-1.414L7 8.586V2a1 1 0 0 1 1-1z"/>' +
    '<path fill="currentColor" d="M2 11a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z"/></svg>';

  const P = `#${PANEL_ID}`;
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    Object.assign(n, attrs);
    if (html != null) n.innerHTML = html;
    return n;
  };

  // ---------------------------------------------------------------- 面板外壳（照 Blackboard Ultra 原生 peek 面板）
  // 三个面板（一括ダウンロード / 問題演習 / 自動ログイン設定）共用同一套外壳和控件样式，只注入一次。
  // 照「プロフィール › 通知設定」面板：白底标题区（小字上标 + 细体大标题）、
  // 关闭钮是伸出面板左缘 30px 的蓝色方块（下面带折角）、页面整体变暗、页脚两颗等宽按钮。
  // 手机/窄屏（≤640px）整屏接管，关闭钮收回到标题区右上角。
  const ARROW = (c) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='${c}' stroke-width='1.6'/%3E%3C/svg%3E")`;
  const SHELL_CSS = `
    .bbtool-shell{
      --bg:#fff; --fg:#262626; --muted:#666; --line:#dcdcdc; --rule:#4a4a4a; --ctl:#767676;
      --acc:#3b4fa8; --acc-deep:#26336f; --link:#3b4fa8; --check:#1d8a3c; --danger:#c8102e;
      --btn:#262626; --btn-fg:#fff; --btn2:#e3e3e3; --btn2-fg:#262626; --ok:#1d7a34;
      --arrow:${ARROW("%23262626")};
      --h:44px; --w:560px; --pad:38px;
      --font:"Noto Sans JP","Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic UI",Meiryo,"Microsoft YaHei",system-ui,sans-serif;
    }
    .bbtool-shell[data-theme="dark"]{
      --bg:#1e1f23; --fg:#ececec; --muted:#a6a6a6; --line:#393a40; --rule:#76777d; --ctl:#8a8b90;
      --link:#a9b8f2; --check:#3fbf63; --danger:#ff6b6b; --ok:#5fd07c;
      --btn:#ececec; --btn-fg:#1e1f23; --btn2:#393a40; --btn2-fg:#ececec;
      --arrow:${ARROW("%23ececec")};
    }
    .bbtool-shell, .bbtool-shell *{box-sizing:border-box!important}
    .bbtool-shell{position:fixed!important; top:0; right:0; bottom:0; left:auto; z-index:2147483000;
      width:min(var(--w), calc(100vw - 40px)); display:none; flex-direction:column;
      background:var(--bg); color:var(--fg); box-shadow:-8px 0 28px rgba(0,0,0,.28);
      font:15px/1.6 var(--font); text-align:left; letter-spacing:.01em; margin:0; transform:none}
    .bbtool-shell.open{display:flex; animation:bbtool-in .22s cubic-bezier(.2,.7,.2,1)}
    @keyframes bbtool-in{from{transform:translateX(32px); opacity:0} to{transform:none; opacity:1}}
    @media (prefers-reduced-motion:reduce){.bbtool-shell.open{animation:none}}
    .bbtool-overlay{position:fixed!important; inset:0; z-index:2147482999; background:rgba(0,0,0,.55); display:none}
    .bbtool-overlay.show{display:block}

    /* 关闭钮：伸出左缘的蓝色方块 + 折角 */
    .bbtool-shell .bbtool-close{position:absolute!important; left:-30px; top:38px; z-index:2;
      width:50px!important; height:50px!important; margin:0!important; padding:0!important; border:0!important; border-radius:0!important;
      background:var(--acc)!important; color:#fff!important; cursor:pointer; display:flex!important; align-items:center; justify-content:center;
      box-shadow:none!important}
    .bbtool-shell .bbtool-close::after{content:""; position:absolute; left:0; top:100%; width:0; height:0;
      border-top:14px solid var(--acc-deep); border-left:30px solid transparent}
    .bbtool-shell .bbtool-close:hover{background:#4b5fba!important}
    .bbtool-shell .bbtool-close svg{width:24px; height:24px; display:block}

    .bbtool-shell .bbtool-header{flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:flex-start; gap:12px 16px;
      padding:28px var(--pad) 22px; border-bottom:1px solid var(--line)}
    .bbtool-shell .bbtool-headtext{flex:1 1 auto; min-width:0}
    .bbtool-shell .bbtool-sub{margin:0; font-size:14px; line-height:1.4; color:var(--fg)}
    .bbtool-shell .bbtool-header h1{margin:6px 0 0!important; padding:0!important; font:300 30px/1.25 var(--font)!important;
      color:var(--fg)!important; letter-spacing:.02em; border:0!important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .bbtool-shell .bbtool-headtools{flex:0 0 auto; display:flex; gap:6px; margin-top:2px}
    .bbtool-shell .bbtool-headtools select{height:30px!important; min-height:30px!important; width:auto!important;
      padding:0 26px 0 8px!important; font-size:12px!important; background-position:right 8px center!important}

    .bbtool-shell .bbtool-body{flex:1 1 auto; min-height:0; overflow:auto; padding:26px var(--pad) 32px; overscroll-behavior:contain}
    .bbtool-shell .bbtool-footer{flex:0 0 auto; display:flex; flex-direction:column; gap:10px;
      padding:12px var(--pad) 18px; border-top:1px solid var(--line); background:var(--bg)}
    .bbtool-shell .bbtool-status{min-height:20px; font-size:13px; line-height:20px; color:var(--muted);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .bbtool-shell .bbtool-actions{display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); gap:10px}
    .bbtool-shell .bbtool-actions .btn{height:46px!important; min-height:46px!important; width:100%}

    /* 分区：粗标题 + 说明 + 细分隔线（同「ストリーム通知」） */
    .bbtool-shell .sec{margin:0 0 24px; padding:0 0 24px; border-bottom:1px solid var(--line)}
    .bbtool-shell .sec:last-child{margin-bottom:0; padding-bottom:0; border-bottom:0}
    .bbtool-shell .sec > h2{margin:0 0 4px!important; padding:0!important; font:700 18px/1.4 var(--font)!important; color:var(--fg)!important; border:0!important}
    .bbtool-shell .desc{margin:0 0 22px; font-size:13px; line-height:1.6; color:var(--muted)}
    .bbtool-shell .sec > h2 + .row{margin-top:22px} /* 给压在边框上的小标签留出位置 */
    .bbtool-shell .row{display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:0 0 18px}
    .bbtool-shell .row:last-child{margin-bottom:0}

    /* 描边输入框 + 压在边框上的小标签（同课程页「学期」「フィルタ」） */
    .bbtool-shell .fld{position:relative; flex:1 1 200px; min-width:0; margin:0}
    .bbtool-shell .fld > span{position:absolute; top:-9px; left:9px; z-index:1; padding:0 4px; background:var(--bg);
      font-size:12px; line-height:16px; color:var(--fg); pointer-events:none; white-space:nowrap}
    .bbtool-shell select, .bbtool-shell input[type=text], .bbtool-shell input[type=password],
    .bbtool-shell input[type=number], .bbtool-shell input[type=url], .bbtool-shell textarea{
      width:100%!important; margin:0!important; font:inherit!important; font-size:14px!important; color:var(--fg)!important;
      background-color:var(--bg)!important; border:1px solid var(--ctl)!important; border-radius:2px!important;
      box-shadow:none!important; outline:none; -webkit-appearance:none; appearance:none}
    .bbtool-shell select, .bbtool-shell input[type=text], .bbtool-shell input[type=password],
    .bbtool-shell input[type=number], .bbtool-shell input[type=url]{height:var(--h)!important; min-height:var(--h)!important;
      padding:0 12px!important; line-height:normal!important}
    .bbtool-shell select{padding-right:34px!important; cursor:pointer;
      background-image:var(--arrow)!important; background-repeat:no-repeat!important; background-position:right 12px center!important}
    .bbtool-shell textarea{min-height:150px; padding:10px 12px!important; font-size:13px!important; line-height:1.65!important; resize:vertical}
    .bbtool-shell select:hover, .bbtool-shell input:hover, .bbtool-shell textarea:hover{border-color:var(--fg)!important}
    .bbtool-shell select:focus-visible, .bbtool-shell input:focus-visible, .bbtool-shell textarea:focus-visible,
    .bbtool-shell .btn:focus-visible, .bbtool-shell .bbtool-close:focus-visible{outline:2px solid var(--acc)!important; outline-offset:2px}
    .bbtool-shell[data-theme="dark"] select:focus-visible, .bbtool-shell[data-theme="dark"] input:focus-visible,
    .bbtool-shell[data-theme="dark"] textarea:focus-visible, .bbtool-shell[data-theme="dark"] .btn:focus-visible{outline-color:var(--link)!important}

    /* 按钮：主按钮深色实心，次按钮浅灰（同原生「保存」「キャンセル」） */
    .bbtool-shell .btn{flex:0 0 auto; display:inline-flex!important; align-items:center; justify-content:center;
      height:var(--h)!important; min-height:var(--h)!important; margin:0!important; padding:0 18px!important;
      font:500 14px/1 var(--font)!important; white-space:nowrap; text-transform:none; letter-spacing:.02em;
      border:1px solid var(--btn)!important; border-radius:2px!important; background:var(--btn)!important; color:var(--btn-fg)!important;
      box-shadow:none!important; cursor:pointer}
    .bbtool-shell .btn:hover{filter:brightness(1.18)}
    .bbtool-shell[data-theme="dark"] .btn:hover{filter:brightness(.9)}
    .bbtool-shell .btn.sec{background:var(--btn2)!important; border-color:var(--btn2)!important; color:var(--btn2-fg)!important}
    .bbtool-shell .btn.line{background:transparent!important; border-color:var(--ctl)!important; color:var(--fg)!important}
    .bbtool-shell .btn.danger{background:transparent!important; border-color:var(--danger)!important; color:var(--danger)!important}
    .bbtool-shell .btn:disabled{opacity:.45; cursor:default; filter:none}

    /* 复选框：原生绿色勾选 */
    .bbtool-shell label{display:inline-flex!important; align-items:center; gap:10px; margin:0!important; padding:0!important;
      cursor:pointer; color:var(--fg)!important; font-weight:500}
    .bbtool-shell input[type=checkbox]{appearance:auto!important; -webkit-appearance:checkbox!important; position:static!important;
      opacity:1!important; visibility:visible!important; clip:auto!important; display:inline-block!important; transform:none!important;
      width:18px!important; height:18px!important; min-width:18px!important; margin:0!important; padding:0!important;
      flex:0 0 auto; accent-color:var(--check); pointer-events:auto!important; cursor:pointer}
    .bbtool-shell a{color:var(--link)!important}
    .bbtool-shell .muted{color:var(--muted)}

    /* 手机/窄屏：照原生手机版（深色顶栏 + 左上角 × + 居中标题；分区标题下灰线；灰底页脚一颗整宽主按钮） */
    @media (max-width:640px){
      .bbtool-shell{--pad:20px; --foot:#f4f4f4; width:100vw; box-shadow:none}
      .bbtool-shell[data-theme="dark"]{--foot:#26272c}
      .bbtool-shell.open{animation-name:bbtool-up}
      .bbtool-shell .bbtool-close{left:6px; right:auto; top:calc(env(safe-area-inset-top) + 6px); width:48px!important; height:48px!important;
        background:transparent!important; color:#fff!important}
      .bbtool-shell .bbtool-close:hover{background:rgba(255,255,255,.12)!important}
      .bbtool-shell .bbtool-close::after{display:none}
      .bbtool-shell .bbtool-close svg{width:26px; height:26px}
      .bbtool-shell .bbtool-close:focus-visible{outline-color:#fff!important; outline-offset:-4px}
      .bbtool-shell .bbtool-header{padding:0; gap:0; border-bottom:1px solid var(--line)}
      .bbtool-shell .bbtool-headtext{flex:1 1 100%; display:flex; align-items:center; justify-content:center;
        min-height:calc(60px + env(safe-area-inset-top)); padding:env(safe-area-inset-top) 64px 0; background:#262626}
      .bbtool-shell .bbtool-sub{display:none}
      .bbtool-shell .bbtool-header h1{margin:0!important; font:700 18px/1.3 var(--font)!important; color:#fff!important; text-align:center}
      .bbtool-shell .bbtool-headtools{flex:1 1 100%; justify-content:flex-end; margin:0; padding:10px var(--pad)}
      .bbtool-shell .bbtool-body{padding:24px var(--pad) 32px}
      .bbtool-shell .sec{border-bottom:0; margin-bottom:12px}
      .bbtool-shell .sec > h2{font-size:20px!important; padding:0 0 18px!important; margin:0 0 20px!important;
        border-bottom:1px solid var(--line)!important}
      .bbtool-shell .sec > h2 + .row{margin-top:30px}
      .bbtool-shell .bbtool-footer{background:var(--foot); padding:16px 32px max(20px, env(safe-area-inset-bottom))}
      .bbtool-shell .bbtool-status:empty{display:none}
      .bbtool-shell .bbtool-actions .m-hide{display:none!important}
      .bbtool-shell .bbtool-actions .btn{height:48px!important; min-height:48px!important}
    }
    @keyframes bbtool-up{from{transform:translateY(24px); opacity:0} to{transform:none; opacity:1}}
    @media (pointer:coarse){
      .bbtool-shell{--h:46px}
      .bbtool-shell select, .bbtool-shell input:not([type=checkbox]):not([type=radio]), .bbtool-shell textarea{font-size:16px!important}
      .bbtool-shell input[type=checkbox]{width:22px!important; height:22px!important; min-width:22px!important}
    }
  `;

  // 一括ダウンロード 专用：文件树（行间细线，文件夹缩进）
  const dlStyle = `
    ${P} .tree-head{display:flex; align-items:center; gap:16px; padding:0 0 12px; border-bottom:1px solid var(--rule)}
    ${P} .tree-head label:last-child{margin-left:auto!important}
    ${P} ul.tree, ${P} ul.tree ul{list-style:none!important; margin:0!important; padding:0!important; text-indent:0!important}
    ${P} ul.tree ul{padding-left:28px!important}
    ${P} ul.tree li{margin:0!important; padding:0!important; border-top:1px solid var(--line)}
    ${P} ul.tree > li:first-child{border-top:0}
    ${P} ul.tree li::before, ${P} ul.tree li::marker{content:none!important}
    ${P} ul.tree .item{display:flex; align-items:center; gap:6px; min-height:44px; padding:6px 0}
    ${P} ul.tree .item > label{flex:1 1 auto; min-width:0; font-weight:400}
    ${P} ul.tree .item > label > span{overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;
      line-clamp:2; white-space:normal; overflow-wrap:anywhere}
    ${P} ul.tree .dir > label{font-weight:700}
    ${P} .bbdl-fold{flex:0 0 22px; width:22px; height:28px; padding:0; border:0; background:transparent; color:var(--muted); font:700 16px/1 var(--font); cursor:pointer}
    ${P} ul.tree .vid{padding-left:28px}
    ${P} .bbdl-open, ${P} .bbdl-manual{flex:0 0 auto; text-decoration:none; padding:4px 6px; font-size:14px}
    ${P} .bbdl-open{opacity:.5; display:inline-flex; color:var(--fg)}
    ${P} .bbdl-open:hover, ${P} .bbdl-open:focus-visible{opacity:1}
    ${P} .bbdl-open svg{width:16px; height:16px; display:block}
    ${P} .bbdl-menu{position:absolute; z-index:10; min-width:140px; padding:4px 0; margin:0; list-style:none;
      background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.2)}
    ${P} .bbdl-menu button{display:block; width:100%; padding:8px 14px; border:0; background:none; color:inherit;
      font:inherit; font-size:14px; text-align:left; cursor:pointer}
    ${P} .bbdl-menu button:hover, ${P} .bbdl-menu button:focus-visible{background:var(--line)}
    ${P} .empty{padding:28px 0; color:var(--muted); font-size:13px; text-align:center}
  `;

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    document.head.appendChild(el("style", { id: "bbtool-style" }, SHELL_CSS + dlStyle + qzStyle + alStyle));
  }

  // 主题是全局的（三个面板共用 bbdl.theme；旧版答题面板的 bbqz.theme 作为初值）。默认浅色，和 LMS 本身一致。
  function curTheme() {
    const v = store.get(LS_THEME, null) ?? store.get(LS_QZ_THEME, "light");
    return v === "dark" ? "dark" : "light";
  }
  function setTheme(m) {
    m = m === "dark" ? "dark" : "light";
    store.set(LS_THEME, m);
    document.querySelectorAll(".bbtool-shell").forEach((p) => { p.dataset.theme = m; });
    document.querySelectorAll(".bbtool-shell .bbtool-theme").forEach((s) => { s.value = m; });
  }

  const CLOSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"/></svg>';

  // footerHtml 里：.bbtool-status 放状态文字，.bbtool-actions 放按钮；带 .bbtool-dismiss 的按钮关闭面板。
  // 标题区右上角统一放 语言 / 主题 两个下拉框，由这里接线，各面板不用再各写一遍。
  function mountShell(panel, { sub, titleId, closeId, bodyHtml, footerHtml, onClose }) {
    ensureStyles();
    panel.className = "bbtool-shell";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", titleId);
    panel.dataset.theme = curTheme();
    panel.innerHTML = `
      <button class="bbtool-close" id="${closeId}" type="button">${CLOSE_SVG}</button>
      <div class="bbtool-header">
        <div class="bbtool-headtext">
          <p class="bbtool-sub" id="${sub.id}"></p>
          <h1 id="${titleId}"></h1>
        </div>
        <div class="bbtool-headtools">
          <select class="bbtool-lang">
            <option value="ja">日本語</option><option value="en">English</option><option value="zh">简体中文</option><option value="zh_tw">繁體中文</option>
          </select>
          <select class="bbtool-theme"><option value="light"></option><option value="dark"></option></select>
        </div>
      </div>
      <div class="bbtool-body">${bodyHtml}</div>
      <div class="bbtool-footer">${footerHtml}</div>`;
    const overlay = el("div", { className: "bbtool-overlay" });
    panel.__overlay = overlay;
    // 一律挂在 <body> 下：挂进 Blackboard 的布局元素里时，祖先的 transform/contain 会让 position:fixed 跟着偏移
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    panel.__close = onClose || (() => setShellOpen(panel, false));
    const doClose = () => panel.__close();
    overlay.addEventListener("click", doClose);
    panel.querySelector(`#${closeId}`).addEventListener("click", doClose);
    panel.querySelectorAll(".bbtool-dismiss").forEach((b) => b.addEventListener("click", doClose));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); doClose(); } });

    const langSel = panel.querySelector(".bbtool-lang");
    const themeSel = panel.querySelector(".bbtool-theme");
    langSel.value = lang;
    langSel.onchange = () => setLang(langSel.value);
    themeSel.value = panel.dataset.theme;
    themeSel.onchange = () => setTheme(themeSel.value);
    const hook = () => {
      langSel.value = lang;
      langSel.title = langSel.ariaLabel = t("lang");
      themeSel.title = themeSel.ariaLabel = t("theme");
      themeSel.options[0].textContent = t("theme_light");
      themeSel.options[1].textContent = t("theme_dark");
      const x = panel.querySelector(`#${closeId}`);
      x.title = x.ariaLabel = t("close");
      panel.querySelectorAll(".bbtool-dismiss[data-k]").forEach((b) => { b.textContent = t(b.dataset.k); });
    };
    hook();
    langHooks.add(hook);
    panel.__langHook = hook;
    return panel;
  }
  // 同一时间只开一个面板；页面一律变暗（和原生 peek 面板一样）
  function setShellOpen(panel, open) {
    if (!panel) return;
    if (open) {
      document.querySelectorAll(".bbtool-shell.open").forEach((p) => { if (p !== panel && p.__close) p.__close(); });
      panel.dataset.theme = curTheme();
    }
    panel.classList.toggle("open", open);
    const ov = panel.__overlay;
    if (ov) ov.classList.toggle("show", open);
    if (open) { const x = panel.querySelector(".bbtool-close"); if (x) try { x.focus({ preventScroll: true }); } catch (e) {} }
  }

  // 文件旁「在新标签打开」的图标：缺了右上角的方框 + 斜向右上的箭头
  const OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M14 4h6v6"/><path d="M20 4 11 13"/></svg>`;
  let dlPanel = null;
  let dlFiles = []; // 只放可下载的文件（file 节点），下标对应树里的 data-i

  function buildDlPanel() {
    if (document.getElementById(PANEL_ID)) return;
    dlPanel = el("div", { id: PANEL_ID });
    mountShell(dlPanel, {
      sub: { id: "bbdl-sub" },
      titleId: "bbdl-title",
      closeId: "bbdl-x",
      bodyHtml: `
        <section class="sec">
          <h2 id="bbdl-h-course"></h2>
          <p class="desc" id="bbdl-d-course"></p>
          <div class="row">
            <label class="fld"><span id="bbdl-f-term"></span><select id="bbdl-term"><option>…</option></select></label>
          </div>
          <div class="row">
            <label class="fld"><span id="bbdl-f-course"></span><select id="bbdl-course"><option value=""></option></select></label>
            <button class="btn line" id="bbdl-scan" type="button"></button>
          </div>
        </section>
        <section class="sec">
          <h2 id="bbdl-h-files"></h2>
          <div class="tree-head">
            <label><input type="checkbox" id="bbdl-all"><span id="bbdl-all-label"></span></label>
            <label><input type="checkbox" id="bbdl-zip"><span id="bbdl-zip-label"></span></label>
          </div>
          <ul class="tree" id="bbdl-list"></ul>
          <p class="empty" id="bbdl-empty"></p>
        </section>`,
      footerHtml: `<div class="bbtool-status" id="bbdl-status" role="status"></div>
        <div class="bbtool-actions">
          <button class="btn sec bbtool-dismiss m-hide" data-k="close" type="button"></button>
          <button class="btn" id="bbdl-go" type="button"></button>
        </div>`,
    });

    const $ = (s) => dlPanel.querySelector(s);
    const status = (txt) => ($("#bbdl-status").textContent = txt);
    const listRoot = $("#bbdl-list");
    let grouped = []; // [[term, [course...]], ...]
    let pendingZip = null; // iOS：打好的 ZIP 等用户点一下再保存（保存需要用户手势）

    // 把静态文案按当前语言刷新
    function fillTermOptions() {
      const termSel = $("#bbdl-term");
      if (termSel.dataset.loaded !== "1") return;
      const cur = termSel.value;
      termSel.innerHTML = grouped
        .map(([tm, cs]) => `<option value="${tm}">${tm ? esc(tm) : t("other")}（${cs.length}）</option>`)
        .join("");
      // 只恢复真实存在的学期；首次加载时 cur 是占位符「…」，不能拿来设值（会把下拉框置空、课程列表跟着变空）
      if (cur && grouped.some(([tm]) => tm === cur)) termSel.value = cur;
    }
    function applyLang() {
      $("#bbdl-sub").textContent = t("sub_dl");
      $("#bbdl-title").textContent = t("title");
      $("#bbdl-h-course").textContent = t("dl_sec_course");
      $("#bbdl-d-course").textContent = t("dl_desc");
      $("#bbdl-f-term").textContent = t("f_term");
      $("#bbdl-f-course").textContent = t("f_course");
      $("#bbdl-h-files").textContent = t("dl_sec_files");
      $("#bbdl-empty").textContent = t("dl_empty");
      $("#bbdl-scan").textContent = t("scan");
      $("#bbdl-all-label").textContent = t("select_all");
      $("#bbdl-zip-label").textContent = t("zip");
      $("#bbdl-go").textContent = pendingZip ? t("zip_save") : t("download");
      const cs = $("#bbdl-course");
      if (cs.options[0]) cs.options[0].textContent = t("pick_course");
      fillTermOptions();
    }

    // 语言/主题下拉框由 mountShell 统一接线；这里只刷新本面板的文案
    langHooks.add(applyLang);

    applyLang();
    status(t("pick"));
    syncEmpty();

    // ZIP 打包：iOS 默认开（连续多个下载在 iOS 上体验很差），桌面默认关；记住用户选择
    const zipCb = $("#bbdl-zip");
    zipCb.checked = store.get(LS_ZIP, IS_IOS ? "1" : "0") === "1";
    zipCb.onchange = () => store.set(LS_ZIP, zipCb.checked ? "1" : "0");

    // 每次扫描拿一个序号。扫描要请求很多次接口，比较慢；途中又点了「スキャン」、换了课程或学期时，
    // 旧扫描晚到的结果直接丢掉。不这样做的话，两次扫描都会把结果追加进同一个列表：文件夹和文件出现两次，
    // dlFiles 也被追加两遍、勾选框的序号错位；换课程时旧课程的文件还会混进新课程的列表。
    let scanSeq = 0;

    async function loadCourses() {
      if ($("#bbdl-term").dataset.loaded === "1") return;
      try {
        status(t("loading"));
        grouped = groupCourses(await getCourses());
        $("#bbdl-term").dataset.loaded = "1";
        fillTermOptions();
        const saved = store.get(LS_TERM, "");
        if (saved && grouped.some(([tm]) => tm === saved)) $("#bbdl-term").value = saved;
        fillCourses();
        status(t("count", grouped.reduce((n, [, cs]) => n + cs.length, 0)));
      } catch (e) {
        status(t("load_fail", e.message));
      }
    }
    function fillCourses() {
      scanSeq++; // 列表要被清空了：进行中的扫描作废
      const term = $("#bbdl-term").value;
      const cs = (grouped.find(([tm]) => tm === term) || [null, []])[1];
      $("#bbdl-course").innerHTML =
        `<option value="">${t("pick_course")}</option>` +
        cs.map((c) => `<option value="${c.id}">${esc(c.short)}</option>`).join("");
      listRoot.innerHTML = "";
      syncEmpty();
      status(t("pick")); // 课程选择被重置了；也盖掉作废扫描留下的「スキャン中…」（加载课程时随后会被课程数覆盖）
    }
    // 树为空时显示提示，有内容时隐藏
    function syncEmpty() { $("#bbdl-empty").hidden = !!listRoot.children.length; }
    $("#bbdl-term").onchange = () => { store.set(LS_TERM, $("#bbdl-term").value); fillCourses(); };

    // 文件树渲染
    function renderNodes(nodes, container) {
      for (const node of nodes) {
        const li = document.createElement("li");
        if (node.type === "folder") {
          li.className = "dir";
          li.innerHTML = `<div class="item"><button class="bbdl-fold" type="button" aria-expanded="false">▸</button><label><input type="checkbox" class="bbdl-dir"><span>📁 ${esc(node.name)}</span></label></div>`;
          const ul = document.createElement("ul");
          ul.hidden = true;
          renderNodes(node.children, ul);
          li.appendChild(ul);
        } else if (node.type === "video") {
          li.innerHTML = `<div class="item vid">🎬 <a href="${ORIGIN + node.launch}" target="_blank" rel="noopener" title="${esc(t("vlink_title"))}">${esc(node.name)}</a></div>`;
        } else {
          const i = dlFiles.length;
          dlFiles.push(node);
          li.innerHTML = `<div class="item"><label><input type="checkbox" class="bbdl-f" data-i="${i}"><span>${esc(node.name)}</span></label>` +
            `<a class="bbdl-open" href="${esc(absUrl(node.url))}" target="_blank" rel="noopener" aria-label="${esc(t("open_tab"))}" title="${esc(t("open_tab"))}">${OPEN_SVG}</a></div>`;
        }
        container.appendChild(li);
      }
    }
    function refreshDirStates() {
      const dirs = [...listRoot.querySelectorAll(".bbdl-dir")].reverse(); // 从深到浅
      for (const d of dirs) {
        const fs = [...d.closest("li").querySelectorAll(".bbdl-f")];
        const c = fs.filter((x) => x.checked).length;
        d.checked = fs.length > 0 && c === fs.length;
        d.indeterminate = c > 0 && c < fs.length;
      }
    }
    listRoot.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb.classList.contains("bbdl-dir")) {
        cb.closest("li").querySelectorAll(".bbdl-f, .bbdl-dir").forEach((x) => { x.checked = cb.checked; x.indeterminate = false; });
      }
      refreshDirStates();
      syncSelectAll();
    });
    listRoot.addEventListener("click", (e) => {
      const button = e.target.closest(".bbdl-fold");
      if (!button) return;
      const ul = button.closest("li").querySelector(":scope > ul");
      ul.hidden = !ul.hidden;
      button.textContent = ul.hidden ? "▸" : "▾";
      button.setAttribute("aria-expanded", String(!ul.hidden));
    });

    // 文件旁的打开图标：右键弹出「复制链接」。菜单挂在面板里（面板是 position:fixed，按面板坐标定位）
    let linkMenu = null;
    function closeLinkMenu() {
      if (!linkMenu) return;
      linkMenu.remove();
      linkMenu = null;
      document.removeEventListener("mousedown", onMenuOutside, true);
      document.removeEventListener("keydown", onMenuKey, true);
      document.removeEventListener("scroll", closeLinkMenu, true);
    }
    function onMenuOutside(e) { if (linkMenu && !linkMenu.contains(e.target)) closeLinkMenu(); }
    function onMenuKey(e) { if (e.key === "Escape") closeLinkMenu(); }
    function copyText(text) {
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        ta.remove();
        return ok;
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        return navigator.clipboard.writeText(text).then(() => true, () => fallback());
      return Promise.resolve(fallback());
    }
    listRoot.addEventListener("contextmenu", (e) => {
      const a = e.target.closest(".bbdl-open");
      if (!a) return;
      e.preventDefault();
      closeLinkMenu();
      const url = a.href;
      linkMenu = el("div", { className: "bbdl-menu" });
      linkMenu.setAttribute("role", "menu");
      const item = el("button", { type: "button", textContent: t("copy_link") });
      item.setAttribute("role", "menuitem");
      item.onclick = () => {
        closeLinkMenu();
        copyText(url).then((ok) => status(ok ? t("link_copied") : "Copy failed"));
      };
      linkMenu.appendChild(item);
      dlPanel.appendChild(linkMenu);
      const box = dlPanel.getBoundingClientRect();
      const x = Math.min(e.clientX - box.left, box.width - linkMenu.offsetWidth - 4);
      const y = Math.min(e.clientY - box.top, box.height - linkMenu.offsetHeight - 4);
      linkMenu.style.left = Math.max(4, x) + "px";
      linkMenu.style.top = Math.max(4, y) + "px";
      document.addEventListener("mousedown", onMenuOutside, true);
      document.addEventListener("keydown", onMenuKey, true);
      document.addEventListener("scroll", closeLinkMenu, true);
      item.focus();
    });

    function syncSelectAll() {
      const fs = [...listRoot.querySelectorAll(".bbdl-f")];
      const c = fs.filter((x) => x.checked).length;
      const all = $("#bbdl-all");
      all.checked = fs.length > 0 && c === fs.length;
      all.indeterminate = c > 0 && c < fs.length;
    }

    function clearPendingZip() {
      pendingZip = null;
      $("#bbdl-go").textContent = t("download");
    }
    async function scan() {
      const cid = $("#bbdl-course").value;
      if (!cid) return status(t("pick"));
      const my = ++scanSeq;
      const current = () => my === scanSeq;
      clearPendingZip();
      listRoot.innerHTML = "";
      dlFiles = [];
      status(t("scanning"));
      const tree = await scanTree(cid, "ROOT", "", (msg) => { if (current()) status(msg); });
      if (!current()) return; // 期间开始了新的扫描，或换了课程 / 学期：这次的结果作废
      listRoot.innerHTML = "";
      dlFiles = [];
      renderNodes(tree, listRoot);
      refreshDirStates();
      syncSelectAll();
      syncEmpty();
      const nv = listRoot.querySelectorAll(".vid").length; // 只数讲义视频，不数每个文件旁的「↗」
      status(t("found", dlFiles.length) + (nv ? t("plus_videos", nv) : ""));
    }
    $("#bbdl-scan").onclick = scan;
    $("#bbdl-course").onchange = scan;
    $("#bbdl-all").onchange = (e) => {
      listRoot.querySelectorAll(".bbdl-f, .bbdl-dir").forEach((c) => { c.checked = e.target.checked; c.indeterminate = false; });
      e.target.indeterminate = false;
    };

    // 下载失败的文件：在树里标 ❌ 并给「↗」原链接，点开后用浏览器自己的会话手动保存（iOS 上 GM 请求可能不带 Cookie）
    function markFailed(i, err) {
      const cb = listRoot.querySelector(`.bbdl-f[data-i="${i}"]`);
      const li = cb && cb.closest(".item");
      if (!li || li.querySelector(".bbdl-manual")) return;
      const a = el("a", { className: "bbdl-manual", href: absUrl(dlFiles[i].url), target: "_blank", rel: "noopener",
        title: t("manual") + (err ? "（" + err + "）" : "") }, "❌↗");
      li.insertBefore(a, li.firstChild);
    }

    $("#bbdl-go").onclick = async () => {
      // 第二次点击：保存已经打好的 ZIP（此时在用户手势里，iOS 才肯下载）
      if (pendingZip) {
        const { blob, name, ok, fail } = pendingZip;
        saveBlob(blob, name);
        clearPendingZip();
        return status(t("zip_saved", ok, fail));
      }
      const idx = [...listRoot.querySelectorAll(".bbdl-f:checked")].map((c) => +c.dataset.i);
      if (!idx.length) return status(t("no_sel"));
      listRoot.querySelectorAll(".bbdl-manual").forEach((a) => a.remove());
      const zip = zipCb.checked;
      $("#bbdl-go").disabled = true;
      let ok = 0, fail = 0, firstErr = "";
      const entries = [], used = new Set();
      const cs = $("#bbdl-course");
      const course = sanitize(cs.options[cs.selectedIndex] ? cs.options[cs.selectedIndex].textContent : "") || "blackboard";
      for (let k = 0; k < idx.length; k++) {
        const f = dlFiles[idx[k]];
        status(t("downloading", k + 1, idx.length, f.name));
        try {
          if (zip) {
            const blob = await fetchBlob(absUrl(f.url), f.name); // 先取到再占用文件名，失败的不占 (2)
            entries.push({ path: zipPath(f, used, course), blob });
          }
          else await downloadOne(f);
          ok++;
        } catch (err) {
          fail++;
          const msg = err.message || String(err);
          if (!firstErr) firstErr = msg;
          markFailed(idx[k], msg);
          console.warn("下载失败", f, err);
        }
        if (!zip) await new Promise((r) => setTimeout(r, 300));
      }
      if (zip && entries.length) {
        try {
          status(t("zipping", entries.length));
          const blob = await buildZip(entries);
          const name = course + ".zip";
          if (IS_IOS) {
            pendingZip = { blob, name, ok, fail };
            $("#bbdl-go").textContent = t("zip_save");
            status(t("zip_ready", ok, fail) + (firstErr ? "（" + firstErr + "）" : ""));
          } else {
            saveBlob(blob, name);
            status(fail ? t("done_err", ok, fail, firstErr) : t("zip_saved", ok, fail));
          }
        } catch (err) {
          status(t("done_err", 0, idx.length, err.message || String(err)));
        }
      } else {
        status(fail ? t("done_err", ok, fail, firstErr) : t("done", ok, fail));
      }
      $("#bbdl-go").disabled = false;
    };

    dlPanel._open = () => { setShellOpen(dlPanel, true); loadCourses(); };
  }

  function toggleDlPanel() {
    buildDlPanel();
    if (dlPanel.classList.contains("open")) setShellOpen(dlPanel, false);
    else dlPanel._open();
  }
  // ---------------------------------------------------------------- 左侧导航入口（批量下载 / 答题 / 自动登录设置）
  // 三个入口都克隆现有导航项（一个 svg + 一个 p），文字更新见下方 langHooks。
  function cloneNavItem(id, innerHtml, label, onClick) {
    const ul = document.getElementById("base_tools");
    if (!ul || document.getElementById(id)) return;
    const sample =
      ul.querySelector('a[data-analytics-id="base.nav.navigation.tools"]') ||
      ul.querySelector('a[data-analytics-id="base.nav.navigation.courses"]') ||
      ul.querySelector("a");
    if (!sample) return;
    const node = sample.cloneNode(true);
    node.id = id;
    node.setAttribute("href", "#");
    node.removeAttribute("data-analytics-id");
    node.removeAttribute("aria-current");
    // 去掉所有「当前选中」样式类（类名带随机后缀，按关键字匹配）
    for (const c of [...node.classList]) if (/active|selected/i.test(c)) node.classList.remove(c);

    const iconBox = node.querySelector(".MuiListItemIcon-root");
    if (iconBox) {
      const old = iconBox.querySelector("svg");
      if (old) {
        // 保留外层容器和原 svg 的尺寸/类名 → 和其它项对齐
        const tpl = document.createElement("div");
        tpl.innerHTML = innerHtml;
        const svg = tpl.firstElementChild;
        for (const attr of ["class", "width", "height", "style"]) {
          const v = old.getAttribute(attr);
          if (v != null) svg.setAttribute(attr, v);
        }
        const r = old.getBoundingClientRect();
        if (r.width && !old.getAttribute("width")) {
          svg.setAttribute("width", Math.round(r.width));
          svg.setAttribute("height", Math.round(r.height));
        }
        old.replaceWith(svg);
      } else {
        iconBox.innerHTML = innerHtml;
      }
    }
    const p = node.querySelector("p");
    if (p) p.textContent = label;
    node.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      // 手机/窄屏上左侧导航是抽屉，先收起，免得挡住面板
      const closeBtn = document.querySelector('[data-analytics-id="baseLayout.close.button"]');
      if (closeBtn) closeBtn.click();
      onClick();
    });
    ul.appendChild(node);
  }

  const QZ_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v4l3 2 .8-1.2-2.3-1.5V5h-1.5z"/></svg>';

  function ensureNavItem() {
    cloneNavItem(NAV_ID, DL_ICON, t("nav"), toggleDlPanel);
  }
  function ensureQuizNavItem() {
    cloneNavItem(QZ_NAV_ID, QZ_ICON, t("qnav"), toggleQuizPanel);
  }
  const TS_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true"><path fill="currentColor" d="M3 1h8l2 2v12H3V1zm2 3v1h6V4H5zm0 3v1h6V7H5zm0 3v1h4v-1H5z"/></svg>';
  function ensureTaskNavItem() {
    cloneNavItem(TS_NAV_ID, TS_ICON, t("ts_nav"), toggleTaskPanel);
  }
  // ---------------------------------------------------------------- 讲义视频页（vlib）
  // 脚本也在 Mediasite 播放页运行：此时已是 vlib 同源，直接调 GetPlayerOptions 拿 MP4 直链，
  // MP4 又和本页同域，<a download> 就能存。授权（AuthTicket / MediasiteAuthTickets cookie）
  // 由浏览器点开视频时的 LTI 流程完成，脚本不碰。
  async function resolveMp4() {
    // 兼容 /Mediasite/Play/<id> 和 /Mediasite/v2021/Play/<id> 等带版本段的播放页
    const m = location.pathname.match(/\/Play\/([0-9a-fA-F]+)/);
    if (!m) throw new Error(t("v_not_play"));
    const pid = m[1];
    const r = await fetch(ORIGIN + "/Mediasite/PlayerService/PlayerService.svc/json/GetPlayerOptions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ getPlayerOptionsRequest: { ResourceId: pid, QueryString: location.search, UseScreenReader: false, UrlReferrer: "" } }),
    });
    if (!r.ok) throw new Error(t("v_http", r.status));
    const d = (await r.json()).d || {};
    const pres = d.Presentation || {};
    const streams = (pres.Streams || []).slice().sort((a, b) => (a.StreamType !== 0) - (b.StreamType !== 0));
    for (const s of streams)
      for (const v of s.VideoUrls || [])
        if ((v.MimeType || "").startsWith("video/mp4") && v.Location)
          return { url: v.Location, title: pres.Title || pid };
    throw new Error(d.PlayerPresentationStatusMessage || t("v_no_mp4"));
  }

  function initMediasitePage() {
    const sanitizeV = (s) => (s || "video").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    const btn = document.createElement("button");
    btn.textContent = t("v_btn");
    btn.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#3b4fa8;color:#fff;border:none;" +
      "border-radius:24px;padding:12px 18px;font:14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    btn.onclick = async () => {
      btn.disabled = true;
      const old = t("v_btn");
      btn.textContent = t("v_resolving");
      try {
        const { url, title } = await resolveMp4();
        const a = document.createElement("a");
        a.href = url;              // 与本页同域（vlib），download 可强制下载并改名
        a.download = sanitizeV(title) + ".mp4";
        document.body.appendChild(a);
        a.click();
        a.remove();
        btn.textContent = t("v_started");
        console.log("[MP4]", url); // 需要时可从控制台复制直链
        setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 4000);
      } catch (e) {
        btn.textContent = t("v_fail", e.message || e);
        setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 5000);
      }
    };
    const add = () => document.body && document.body.appendChild(btn);
    if (document.body) add(); else window.addEventListener("DOMContentLoaded", add);
  }
  // ================================================================ 自动登录模块（lms2017）
  // 登录页自动填用户名/密码并点サインイン，
  // 应用页在左侧导航加「自动登录设置」齿轮项。凭据存在脚本管理器本地存储（GM_* 优先，
  // 退回 localStorage 的 lmsauto_* 键），和下载/答题模块的 bbdl.* / bbqz.* 互不干扰。
  const RETRY_GUARD_MS = 20000;          // 20 秒内又回到登录页则停手，防密码错时死循环
  const SETTINGS_HASH = "#lms-settings"; // 备用入口：网址末尾加它可打开设置
  const NAV_ITEM_ID = "lms-autologin-nav";
  const GEAR_ID = "lms-autologin-gear";

  const authStore = {
    async get(key, def) {
      try {
        if (typeof GM !== "undefined" && GM.getValue) return await GM.getValue(key, def);
        if (typeof GM_getValue === "function") return GM_getValue(key, def);
      } catch (e) { /* fallthrough */ }
      const v = localStorage.getItem("lmsauto_" + key);
      return v === null ? def : JSON.parse(v);
    },
    async set(key, val) {
      try {
        if (typeof GM !== "undefined" && GM.setValue) return await GM.setValue(key, val);
        if (typeof GM_setValue === "function") return GM_setValue(key, val);
      } catch (e) { /* fallthrough */ }
      localStorage.setItem("lmsauto_" + key, JSON.stringify(val));
    },
    async del(key) {
      try {
        if (typeof GM !== "undefined" && GM.deleteValue) return await GM.deleteValue(key);
        if (typeof GM_deleteValue === "function") return GM_deleteValue(key);
      } catch (e) { /* fallthrough */ }
      localStorage.removeItem("lmsauto_" + key);
    },
  };

  // 旧版在 Userscripts(iOS) 上没有 GM.* 授权，凭据落到了页面的 localStorage(lmsauto_*)。
  // 现在有 GM 存储了，就搬过去并从 localStorage 删掉（只有确认 GM 里已有值才删，搬失败就保持原样）。
  async function migrateAuthStore() {
    const gm = (typeof GM !== "undefined" && GM && typeof GM.getValue === "function")
      ? { get: (k) => GM.getValue(k), set: (k, v) => GM.setValue(k, v) }
      : (typeof GM_getValue === "function")
        ? { get: async (k) => GM_getValue(k), set: async (k, v) => GM_setValue(k, v) }
        : null;
    if (!gm) return;
    for (const k of ["user", "pass", "enabled", "autoSubmit", "delay"]) {
      try {
        const raw = localStorage.getItem("lmsauto_" + k);
        if (raw === null) continue;
        if ((await gm.get(k)) === undefined) await gm.set(k, JSON.parse(raw));
        if ((await gm.get(k)) !== undefined) localStorage.removeItem("lmsauto_" + k);
      } catch (e) { return; }
    }
  }
  await migrateAuthStore();

  async function loadAuthCfg() {
    return {
      user: await authStore.get("user", ""),
      pass: await authStore.get("pass", ""),
      enabled: await authStore.get("enabled", true),
      autoSubmit: await authStore.get("autoSubmit", true),
      delay: await authStore.get("delay", 300),
    };
  }
  let authCfg = await loadAuthCfg();

  // 自动登录设置：和另外两个面板同一个外壳（右侧抽屉 / 手机整屏），每次打开现建、关闭即销毁。
  const AL_PANEL_ID = "lms-autologin-panel";
  const alStyle = `
    #${AL_PANEL_ID} .pw{display:flex; gap:10px; align-items:stretch}
    #${AL_PANEL_ID} .pw .fld{flex:1 1 auto}
    #${AL_PANEL_ID} .checks{display:flex; flex-direction:column; margin-top:12px; border-top:1px solid var(--rule)}
    #${AL_PANEL_ID} .checks label{min-height:52px; padding:8px 0; border-bottom:1px solid var(--line)}
    #${AL_PANEL_ID} .checks + .row{margin-top:24px}
    #${AL_PANEL_ID} .msg{margin:0 0 12px; font-size:13px; color:var(--ok)}
    #${AL_PANEL_ID} .msg:empty{display:none}
    @media (max-width:640px){ #${AL_PANEL_ID} .checks{margin-top:-20px; border-top:0} } /* 手机上标题已有下划线，避免双线 */
    #${AL_PANEL_ID} .note{margin:0 0 16px; font-size:12.5px; line-height:1.7; color:var(--muted)}
    #${AL_PANEL_ID} .note b{color:var(--fg)}
  `;

  async function openAuthSettings() {
    if (document.getElementById(AL_PANEL_ID)) return;
    authCfg = await loadAuthCfg();
    const panel = document.createElement("div");
    panel.id = AL_PANEL_ID;
    const close = () => {
      langHooks.delete(langHook);
      if (panel.__langHook) langHooks.delete(panel.__langHook);
      if (panel.__overlay) panel.__overlay.remove();
      panel.remove();
      if (location.hash === SETTINGS_HASH) history.replaceState(null, "", location.pathname + location.search);
    };
    mountShell(panel, {
      sub: { id: "al-sub" },
      titleId: "al-title",
      closeId: "al-x",
      onClose: close, // ×、遮罩、キャンセル、Esc 都走同一个 close，面板彻底销毁，下次能再打开
      bodyHtml: `
        <section class="sec">
          <h2 id="al-h-account"></h2>
          <div class="row">
            <label class="fld"><span id="al-l-user"></span>
              <input type="text" id="user" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          </div>
          <div class="row pw">
            <label class="fld"><span id="al-l-pass"></span><input type="password" id="pass" autocomplete="off"></label>
            <button class="btn line" id="toggle" type="button"></button>
          </div>
        </section>
        <section class="sec">
          <h2 id="al-h-behavior"></h2>
          <div class="checks">
            <label><input type="checkbox" id="enabled"><span id="al-l-enable"></span></label>
            <label><input type="checkbox" id="autoSubmit"><span id="al-l-autosubmit"></span></label>
          </div>
          <div class="row">
            <label class="fld"><span id="al-l-delay"></span><input type="number" id="delay" min="0" step="100" inputmode="numeric"></label>
          </div>
        </section>
        <section class="sec">
          <p class="msg" id="msg" role="status"></p>
          <p class="note" id="al-note"></p>
          <button class="btn danger" id="clear" type="button"></button>
        </section>`,
      footerHtml: `<div class="bbtool-actions">
          <button class="btn sec m-hide" id="cancel" type="button"></button>
          <button class="btn" id="save" type="button"></button>
        </div>`,
    });
    const $ = (id) => panel.querySelector("#" + id);
    // 按当前语言填静态文案（语言/主题下拉框、关闭钮由 mountShell 处理）
    function applyAuthLang() {
      $("al-sub").textContent = t("al_sub");
      $("al-title").textContent = t("al_title");
      $("al-h-account").textContent = t("al_sec_account");
      $("al-h-behavior").textContent = t("al_sec_behavior");
      $("al-l-user").textContent = t("al_user");
      $("al-l-pass").textContent = t("al_pass");
      $("toggle").textContent = $("pass").type === "password" ? t("al_show") : t("al_hide");
      $("al-l-enable").textContent = t("al_enable");
      $("al-l-autosubmit").textContent = t("al_autosubmit");
      $("al-l-delay").textContent = t("al_delay");
      $("clear").textContent = t("al_clear");
      $("cancel").textContent = t("al_cancel");
      $("save").textContent = t("al_save");
      $("al-note").innerHTML = t("al_note", SETTINGS_HASH);
    }
    const langHook = applyAuthLang;
    langHooks.add(langHook);
    applyAuthLang();
    $("user").value = authCfg.user;
    $("pass").value = authCfg.pass;
    $("enabled").checked = authCfg.enabled;
    $("autoSubmit").checked = authCfg.autoSubmit;
    $("delay").value = authCfg.delay;
    setShellOpen(panel, true);
    $("toggle").onclick = () => {
      const show = $("pass").type === "password";
      $("pass").type = show ? "text" : "password";
      $("toggle").textContent = show ? t("al_hide") : t("al_show");
    };
    $("cancel").onclick = close;
    $("clear").onclick = async () => {
      if (!confirm(t("al_confirm_clear"))) return;
      await authStore.del("user"); await authStore.del("pass");
      $("user").value = ""; $("pass").value = ""; $("msg").textContent = t("al_cleared");
    };
    $("save").onclick = async () => {
      await authStore.set("user", $("user").value.trim());
      await authStore.set("pass", $("pass").value);
      await authStore.set("enabled", $("enabled").checked);
      await authStore.set("autoSubmit", $("autoSubmit").checked);
      await authStore.set("delay", Math.max(0, parseInt($("delay").value, 10) || 0));
      authCfg = await loadAuthCfg();
      $("msg").textContent = t("al_saved");
      setTimeout(() => {
        close();
        if (hasLoginForm() && authCfg.user && authCfg.pass) { hideGear(); if (authCfg.enabled) runLogin(true); }
      }, 500);
    };
    // 在输入框里按 Enter 即保存（按钮/下拉框上的 Enter 保持原本行为）
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input[type=text],input[type=password],input[type=number]")) {
        e.preventDefault(); $("save").click();
      }
    });
  }

  function hasLoginForm() {
    return !!document.getElementById("user_id") && !!document.getElementById("entry-login");
  }
  function showGear() {
    if (document.getElementById(GEAR_ID)) return;
    const gear = document.createElement("button");
    gear.id = GEAR_ID; gear.type = "button"; gear.textContent = "⚙️"; gear.title = t("al_nav");
    Object.assign(gear.style, {
      position: "fixed", right: "16px", bottom: "calc(16px + env(safe-area-inset-bottom))",
      width: "44px", height: "44px", borderRadius: "50%", border: "none",
      background: "rgba(0,0,0,.6)", color: "#fff", fontSize: "22px", lineHeight: "44px",
      padding: "0", zIndex: "2147483646", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    gear.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openAuthSettings(); });
    document.body.appendChild(gear);
  }
  function hideGear() { const g = document.getElementById(GEAR_ID); if (g) g.remove(); }

  // 切换语言时刷新页面上常驻的入口：三个导航项文字 + 登录页齿轮的提示
  langHooks.add(() => {
    const dl = document.querySelector(`#${NAV_ID} p`);
    if (dl) dl.textContent = t("nav");
    const qz = document.querySelector(`#${QZ_NAV_ID} p`);
    if (qz) qz.textContent = t("qnav");
    const al = document.querySelector(`#${NAV_ITEM_ID} p`);
    if (al) al.textContent = t("al_nav");
    const gear = document.getElementById(GEAR_ID);
    if (gear) gear.title = t("al_nav");
  });

  const GEAR_SVG_INNER = `
    <g transform="scale(0.6667)" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </g>`;

  function injectAuthNav() {
    const list = document.getElementById("base_tools");
    if (!list || document.getElementById(NAV_ITEM_ID)) return;
    const tpl = list.querySelector('a[data-analytics-id="base.nav.navigation.tools"]')
      || list.querySelector('a[data-analytics-id^="base.nav.navigation."]:last-of-type')
      || list.querySelector("a");
    if (!tpl) return;
    const item = tpl.cloneNode(true);
    item.id = NAV_ITEM_ID;
    item.setAttribute("href", "#");
    item.removeAttribute("data-analytics-id");
    item.removeAttribute("aria-current");
    for (const c of [...item.classList]) if (/active|selected/i.test(c)) item.classList.remove(c);
    const svg = item.querySelector("svg");
    if (svg) { svg.setAttribute("viewBox", "0 0 16 16"); svg.innerHTML = GEAR_SVG_INNER; }
    const text = item.querySelector("p");
    if (text) text.textContent = t("al_nav");
    item.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const closeBtn = document.querySelector('[data-analytics-id="baseLayout.close.button"]');
      if (closeBtn) closeBtn.click();
      openAuthSettings();
    }, true);
    list.appendChild(item);
  }

  function setValue(el, v) {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.blur();
  }

  async function runLogin(manual = false) {
    const userEl = document.getElementById("user_id");
    const passEl = document.getElementById("password");
    const btn = document.getElementById("entry-login");
    if (!userEl || !passEl || !btn) return;
    authCfg = await loadAuthCfg();
    if (!authCfg.user || !authCfg.pass) { showGear(); openAuthSettings(); return; }
    const fields = document.getElementById("loginFormFields");
    if (fields && getComputedStyle(fields).display === "none") {
      const sw = document.querySelector(".button-logindefault");
      if (sw) sw.click();
    }
    setValue(userEl, authCfg.user);
    setValue(passEl, authCfg.pass);
    if (!manual && !authCfg.autoSubmit) return;
    if (!manual) {
      const last = Number(sessionStorage.getItem("lms_autologin_ts") || 0);
      if (Date.now() - last < RETRY_GUARD_MS) {
        console.warn("[LMS自动登录] 刚刚可能登录失败，已停止自动提交");
        showGear();
        return;
      }
    }
    sessionStorage.setItem("lms_autologin_ts", String(Date.now()));
    setTimeout(() => btn.click(), manual ? 0 : authCfg.delay);
  }
  // ================================================================ 答题模块
  // xsrf 从 BbRouter cookie 的 `xsrf:` 段取；写操作走 X-Blackboard-XSRF。
  // BbRouter 是 HttpOnly，浏览器里 document.cookie 读不到，所以要靠
  //   1) 页面自己请求头里出现过的 token（上面 PW 钩子，最权威）
  //   2) GM_cookie / GM.cookie（Tampermonkey 能给 httpOnly cookie）
  //   3) meta / 内联 HTML / storage（备胎）
  let tokenCache = "", tokenSrc = "";
  let chosenVia = "";   // 已验证可用的提交通道："gm"（GM_xmlhttpRequest）或 "page"（页面 fetch）
  let lastProbe = "";   // 各通道返回的状态码，失败时显示用

  function tokenFromXsrfField(str) {
    if (!str) return "";
    const xi = str.indexOf("xsrf:");
    if (xi < 0) return "";
    const rest = str.slice(xi + 5);
    const ci = rest.search(/[,;\s]/);
    return ci >= 0 ? rest.slice(0, ci) : rest;
  }

  function scanPageSources() {
    // 1) 页面自己请求头里出现过的（最权威，含 bridge 回传的）
    if (capturedXsrf) { tokenCache = capturedXsrf; tokenSrc = capturedSrc || "page"; return tokenCache; }
    // 1.5) bridge 写在 documentElement 上的属性（postMessage/事件都没收到时的兜底）
    try {
      const v = document.documentElement && document.documentElement.getAttribute("data-bbqz-xsrf");
      if (v && v.length >= 8 && v.length <= 128) { tokenCache = v; tokenSrc = "bridge-dom"; return tokenCache; }
    } catch (e) {}
    // 2) document.cookie（BbRouter 不是 HttpOnly 时才有效）
    try {
      for (const c of (document.cookie || "").split(";")) {
        const s = c.trim();
        if (!s) continue;
        const eq = s.indexOf("=");
        const name = eq > 0 ? s.slice(0, eq) : s;
        const raw = eq > 0 ? s.slice(eq + 1) : "";
        let val = raw;
        try { val = decodeURIComponent(raw); } catch (e) {}
        const tok = tokenFromXsrfField(val)
          || (/xsrf|csrf/i.test(name) && val.length >= 8 && val.length <= 128 ? val : "");
        if (tok) { tokenCache = tok; tokenSrc = "cookie:" + name; return tokenCache; }
      }
    } catch (e) {}
    // 3) <meta> 标签
    try {
      const metas = document.querySelectorAll('meta[name*="xsrf" i],meta[name*="csrf" i]');
      for (const meta of metas) {
        const v = meta.getAttribute("content");
        if (v && v.length >= 8 && v.length <= 128) {
          tokenCache = v; tokenSrc = "meta:" + (meta.getAttribute("name") || ""); return tokenCache;
        }
      }
    } catch (e) {}
    // 4) 页面 HTML 里内嵌的
    try {
      const html = document.documentElement ? document.documentElement.outerHTML : "";
      const m = html.match(/xsrf["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{8,128})["']/i)
        || html.match(/xsrf[^A-Za-z0-9]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) { tokenCache = m[1]; tokenSrc = "html"; return tokenCache; }
    } catch (e) {}
    // 5) storage
    try {
      for (const st of [localStorage, sessionStorage]) {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          const v = st.getItem(k) || "";
          if (/xsrf|csrf/i.test(k || "") && v.length >= 8 && v.length <= 128) {
            tokenCache = v; tokenSrc = "storage:" + k; return tokenCache;
          }
          const tok = tokenFromXsrfField(v);
          if (tok) { tokenCache = tok; tokenSrc = "storage:" + k; return tokenCache; }
        }
      }
    } catch (e) {}
    return tokenCache;
  }

  async function gmCookieList() {
    try {
      if (typeof GM !== "undefined" && GM && GM.cookie && typeof GM.cookie.list === "function") {
        return await GM.cookie.list({ url: LMS + "/" });
      }
      if (typeof GM_cookie === "function") {
        return await new Promise(res => GM_cookie("list", { url: LMS + "/" }, (c, e) => res(e ? null : c)));
      }
      if (typeof GM_cookie === "object" && GM_cookie && typeof GM_cookie.list === "function") {
        return await new Promise(res => GM_cookie.list({ url: LMS + "/" }, (c, e) => res(e ? null : c)));
      }
    } catch (e) {}
    return null;
  }

  async function gmCookieToken() {
    const list = await gmCookieList();
    if (!Array.isArray(list) || !list.length) return "";
    for (const ck of list) {
      if (!ck) continue;
      const tok = tokenFromXsrfField(ck.value || "");
      if (tok) { tokenCache = tok; tokenSrc = "GM_cookie:" + ck.name + (ck.httpOnly ? "*" : ""); return tokenCache; }
      if (/xsrf|csrf/i.test(ck.name || "") && ck.value && ck.value.length >= 8 && ck.value.length <= 128) {
        tokenCache = ck.value; tokenSrc = "GM_cookie:" + ck.name; return tokenCache;
      }
    }
    return "";
  }

  async function resolveXsrf(force) {
    if (tokenCache && !force) return tokenCache;
    let tok = scanPageSources();
    if (!tok) tok = await gmCookieToken();
    if (tok) return tok;
    if (!tokenCache) console.warn("[bbqz] xsrf 未取到; document.cookie =", document.cookie);
    return tokenCache;
  }

  function diagXsrf() {
    let bridge = "?";
    try {
      bridge = document.getElementById("bbqz-xsrf-bridge") ? "y" : (document.documentElement && document.documentElement.getAttribute("data-bbqz-xsrf") ? "dom" : "n");
    } catch (e) {}
    let pwSame = "?";
    try { pwSame = (PW === window) ? "y" : "n"; } catch (e) {}
    return "token=" + (tokenCache ? tokenSrc + "/" + tokenCache.slice(0, 10) : "<empty>")
      + " via=" + (chosenVia || "-")
      + " probe=" + lastProbe
      + " cookieBbRouter=" + (String(document.cookie).indexOf("BbRouter") >= 0 ? "y" : "n")
      + " bridge=" + bridge + " pw=" + pwSame;
  }

  // 通道 A：GM_xmlhttpRequest（只带 cookie + XSRF 头，不带 Origin）
  function gmReq(method, url, body, token) {
    const gm = gmXhr();
    if (!gm) return pageReq(method, url, body, token);
    const headers = { "Content-Type": "application/json;charset=utf-8", "Accept": "application/json" };
    if (token) headers["X-Blackboard-XSRF"] = token;
    return new Promise((resolve) => {
      const ret = gm({
        method, url, data: body != null ? JSON.stringify(body) : undefined,
        headers, anonymous: false,
        onload: (res) => {
          const text = res.responseText != null ? res.responseText : res.response;
          try {
            // 服务器若在响应头里回了新的 xsrf（比如 cookie 轮换），顺手记下来
            const mm = String(res.responseHeaders || "").match(/(?:^|\r?\n)x-blackboard-xsrf:\s*([^\r\n]+)/i);
            if (mm) noteXsrf(mm[1].trim(), "resp-header");
          } catch (e) {}
          resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            text: async () => text || "",
            json: async () => { try { return JSON.parse(text); } catch (e) { return null; } },
            via: "gm",
          });
        },
        onerror: () => resolve({ ok: false, status: 0, text: async () => "network error", json: async () => null, via: "gm" }),
        ontimeout: () => resolve({ ok: false, status: 0, text: async () => "timeout", json: async () => null, via: "gm" }),
      });
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    });
  }

  // 通道 B：页面自己的 fetch（同源，浏览器自动带 cookie 和正确的 Origin/Referer）
  function pageReq(method, url, body, token) {
    const fail = async (msg) => ({ ok: false, status: 0, text: async () => msg, json: async () => null, via: "page" });
    try {
      if (!PW || typeof PW.fetch !== "function") return fail("no page fetch");
      const headers = { "Content-Type": "application/json;charset=utf-8", "Accept": "application/json" };
      if (token) headers["X-Blackboard-XSRF"] = token;
      return PW.fetch(url, {
        method, headers,
        body: body != null ? JSON.stringify(body) : undefined,
        credentials: "same-origin", mode: "same-origin", cache: "no-store",
      }).then(async r => {
        let txt = "";
        try { txt = await r.text(); } catch (e) {}
        return {
          ok: r.ok, status: r.status,
          text: async () => txt,
          json: async () => { try { return JSON.parse(txt); } catch (e) { return null; } },
          via: "page",
        };
      }).catch(e => fail(String(e)));
    } catch (e) { return fail(String(e)); }
  }

  // 会写数据的请求（POST/PATCH）：先试已验证可用的通道，403/401 就换另一条再试。
  async function apiMutate(method, path, body) {
    const url = LMS + path;
    // Answer writes are same-origin. The page channel carries Blackboard's
    // active cookies/origin most faithfully; GM is only a fallback.
    const order = ["page", "gm"];
    let last = null;
    const probes = [];
    for (const via of order) {
      const token = await resolveXsrf(false);
      const r = via === "gm" ? await gmReq(method, url, body, token) : await pageReq(method, url, body, token);
      probes.push(via + ":" + r.status);
      last = r;
      if (r.ok) { chosenVia = via; lastProbe = probes.join(" "); return r; }
      if (r.status && r.status !== 403 && r.status !== 401) {
        chosenVia = via; lastProbe = probes.join(" "); return r; // 通道没问题，是业务错误
      }
      await resolveXsrf(true);  // 可能是 token 过期/没取到，强制重新取
    }
    lastProbe = probes.join(" ");
    console.error("[bbqz] mutate 失败", method, url, lastProbe, last ? last.status : "-");
    return last;
  }

  async function apiGet(path) {
    const r = await gmReq("GET", LMS + path, null, "");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j == null) throw new Error("bad JSON");
    return j;
  }
  async function apiPost(path, body) {
    return await apiMutate("POST", path, body ?? {});
  }
  async function apiPatch(path, body) {
    return await apiMutate("PATCH", path, body);
  }

  async function getQuizCourses() {
    const me = await apiGet("/learn/api/v1/users/me");
    if (!me || !me.id) throw new Error("not logged in");
    const data = await apiGet(`/learn/api/v1/users/${me.id}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true&limit=10000`);
    const courses = [];
    for (const m of ((data && data.results) || [])) {
      const c = (m && m.course) || {};
      if (c.id && c.name) courses.push({ id: c.id, name: c.name });
    }
    return courses;
  }
  async function getAllColumns(courseId) {
    const data = await apiGet(`/learn/api/v1/courses/${courseId}/gradebook/columns?limit=1000`);
    return (data && data.results) ? data.results : [];
  }
  async function getChildren(courseId, columnId) {
    try {
      const data = await apiGet(`/learn/api/v1/courses/${courseId}/gradebook/columns/${columnId}/children?limit=100`);
      return data ? (data.results || []) : [];
    } catch (e) { return []; }
  }
  async function flattenColumns(columns, courseId, depth = 0) {
    const items = [];
    for (const col of columns) {
      const name = col.columnName || col.effectiveColumnName || col.localizedColumnName || col.name || "";
      const cid = col.id || "";
      const contentId = col.contentId || "";
      if (name && cid) items.push({ name: "  ".repeat(depth) + name, id: cid, contentId, depth });
      if (cid && depth < 3) {
        const children = await getChildren(courseId, cid);
        if (children.length) items.push(...await flattenColumns(children, courseId, depth + 1));
      }
    }
    return items;
  }
  async function getAllAttempts(courseId, columnId) {
    const path = `/learn/api/v1/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(columnId)}/attempts?limit=100`;
    let data;
    try { data = await apiGet(path); }
    catch (gmError) { data = await getJSON(API(path)); }
      const attempts = [];
      if (data && data.lookup) {
        for (const k of Object.keys(data.lookup)) attempts.push(...(data.lookup[k] || []));
      } else if (data && data.results) {
        attempts.push(...data.results);
      }
      return attempts;
  }
  async function getColumn(courseId, columnId) {
    try { return (await apiGet(`/learn/api/v1/courses/${courseId}/gradebook/columns/${columnId}`)) || {}; }
    catch (e) { return {}; }
  }
  async function createAttempt(courseId, columnId) {
    const col = await getColumn(courseId, columnId);
    const contentId = col.contentId || "";
    let lastMsg = "";
    let r = await apiPost(`/learn/api/v1/courses/${courseId}/gradebook/columns/${columnId}/attempts`, {});
    if (r.ok) { try { return await r.json(); } catch (e) { return {}; } }
    try { lastMsg = "HTTP " + r.status + " " + (await r.text() || "").slice(0, 150); } catch (e) { lastMsg = "HTTP " + r.status; }
    if (contentId) {
      r = await apiPost(`/learn/api/v1/courses/${courseId}/contents/${contentId}/children`, { contentHandler: { id: "resource/x-bb-assessment" } });
      if (r.ok) { try { return await r.json(); } catch (e) { return {}; } }
      try { lastMsg = "HTTP " + r.status + " " + (await r.text() || "").slice(0, 150); } catch (e) { lastMsg = "HTTP " + r.status; }
    }
    throw new Error("create attempt failed: " + lastMsg + " | " + diagXsrf());
  }
  async function getAnswers(courseId, attemptId) {
    return await apiGet(`/learn/api/v1/courses/${courseId}/gradebook/attempts/${attemptId}/assessment/answers`);
  }
  async function submitAnswer(courseId, attemptId, answerId, body) {
    return await apiPatch(`/learn/api/v1/courses/${encodeURIComponent(courseId)}/gradebook/attempts/${encodeURIComponent(attemptId)}/assessment/answers/${encodeURIComponent(answerId)}`, body);
  }
  // ---- 题目解析 / AI 文本生成 / 答案解析 / 提交体构造 ----
  const IMAGE_EXTS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };
  function imageExt(name, mime) {
    const m = (name || "").match(/\.([A-Za-z0-9]+)$/);
    const ext = m ? m[1].toLowerCase() : "";
    if (ext && /^[a-z0-9]+$/.test(ext) && ext.length <= 5) return ext;
    return IMAGE_EXTS[mime] || "png";
  }
  function unescapeHtml(s) {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }
  function stripHtml(text) {
    text = unescapeHtml((text || "").replace(/<[^>]*>/g, ""));
    return text.replace(/\xa0/g, " ").trim();
  }
  function htmlToText(html, onImage) {
    html = (html || "").replace(/<a\b([^>]*)>.*?<\/a>/gis, (m, attrs) => {
      const dbm = attrs.match(/data-bbfile="([^"]*)"/i);
      let info = {};
      if (dbm) {
        try { info = JSON.parse(unescapeHtml(dbm[1])); } catch (e) { info = {}; }
      }
      const hrefm = attrs.match(/\bhref\s*=\s*"([^"]*)"/i);
      const href = hrefm ? unescapeHtml(hrefm[1]) : "";
      const mime = String(info.mimeType || "");
      if (href && mime.startsWith("image/")) return onImage(href, String(info.linkName || ""), mime);
      return m;
    });
    html = html.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
      const srcm = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i);
      const src = srcm ? unescapeHtml(srcm[1]) : "";
      if (!src || src.startsWith("data:")) return "";
      const altm = attrs.match(/\balt\s*=\s*"([^"]*)"/i);
      return onImage(src, altm ? unescapeHtml(altm[1]) : "", "");
    });
    return stripHtml(html);
  }
  const TF_TOKENS = { "正": "正", "誤": "誤", "误": "誤", "T": "正", "TRUE": "正", "F": "誤", "FALSE": "誤" };
  function normalizeTf(token) { return TF_TOKENS[String(token).trim().toUpperCase()] || null; }
  function isEitherOr(q) { return (q.api_type || "").toLowerCase() === "eitheror"; }
  function isMultiSelect(q) { return q.type === "multipleanswer" && (q.max_select || 1) > 1; }
  function choiceLetters(ans) { return [...new Set((String(ans).match(/[A-Za-z]/g) || []).map(c => c.toUpperCase()))].sort(); }

  function fimbBlanks(result) {
    let idents = [];
    const given = result.givenAnswers;
    if (given && typeof given === "object") idents = Object.keys(given);
    if (!idents.length) {
      const raw = ((result.question || {}).questionText || {}).rawText || "";
      for (const m of raw.matchAll(/\[([A-Za-z0-9]+-\d+)\]/g)) {
        if (!idents.includes(m[1])) idents.push(m[1]);
      }
    }
    if (idents.length && idents.every(s => /\d+$/.test(s))) {
      idents = idents.slice().sort((a, b) => parseInt(a.match(/(\d+)$/)[1]) - parseInt(b.match(/(\d+)$/)[1]));
    }
    return idents;
  }

  function buildQuestions(answersData) {
    const questions = [];
    for (const q of (answersData.results || [])) {
      if (!q.question) continue;
      const qData = q.question;
      const qType = qData.questionType || "multipleanswer";
      const images = [];
      const onImage = (url, name, mime) => {
        if (url.startsWith("/")) url = LMS + url;
        const file = `Q${questions.length + 1}-${images.length + 1}.${imageExt(name, mime)}`;
        images.push({ url, file, name });
        return ` [${file}] `;
      };
      const textOf = (obj) => htmlToText((obj || {}).rawText || "", onImage);
      const qText = textOf(qData.questionText);
      if (qType === "matching") {
        const prompts = (qData.prompts || []).map(p => textOf(p.promptText));
        const ansList = (qData.answers || []).map(a => textOf(a.answerText));
        questions.push({ id: q.id, question: qText, type: "matching", prompts, options: ansList, api_type: qType, images });
      } else if (qType.toLowerCase() === "eitheror") {
        questions.push({ id: q.id, question: qText, type: "truefalse", options: [], api_type: qType, images });
      } else if (qType.toLowerCase() === "fimb") {
        let blanks = (qData.answers || []).map(a => a.ident).filter(Boolean);
        if (!blanks.length) blanks = fimbBlanks(q);
        questions.push({ id: q.id, question: qText, type: "fimb", options: [], blanks, api_type: qType, images });
      } else {
        const options = (qData.answers || []).map(a => textOf(a.answerText));
        const item = { id: q.id, question: qText, type: qType, options, api_type: qType, images };
        if (qType === "multipleanswer") {
          const limit = qData.answerSelectionLimit;
          if (typeof limit === "number" && limit > 0) item.max_select = limit;
          else if (qData.singleCorrectAnswer === false) item.max_select = options.length;
        }
        questions.push(item);
      }
    }
    return questions;
  }

  function formatQuestion(i, q, tr) {
    let head = `[${i + 1}] ${q.question}`;
    if (isMultiSelect(q)) head += " " + tr("display_multi_select");
    let block = head + "\n";
    if (q.type === "matching") {
      q.prompts.forEach((p, j) => block += `    ${j + 1}. ${p}\n`);
      block += `  ${tr("display_matching_options")}\n`;
      q.options.forEach((opt, j) => block += `    ${String.fromCharCode(65 + j)}. ${opt}\n`);
    } else if (q.type === "truefalse") {
      block += `    ${tr("display_tf_true")}\n`;
      block += `    ${tr("display_tf_false")}\n`;
    } else if (q.type === "fimb") {
      q.blanks.forEach((ident, j) => block += `    ${j + 1}. [${ident}]\n`);
    } else {
      q.options.forEach((opt, j) => block += `    ${String.fromCharCode(65 + j)}. ${opt}\n`);
    }
    return block;
  }
  function formatQuestionsPlain(questions, tr) {
    let display = "";
    questions.forEach((q, i) => { display += formatQuestion(i, q, tr) + "\n"; });
    return display.trim();
  }
  function formatQuestionsDisplay(questions, tr) {
    let display = tr("order_warning") + "\n\n" + tr("questions_loaded", questions.length) + "\n\n";
    questions.forEach((q, i) => { display += formatQuestion(i, q, tr) + "\n"; });
    return display;
  }
  function buildAiText(questions, tr) {
    const instructions =
      "请回答以下 Blackboard 试题。只输出答案，每题一行。\n" +
      "选择题格式：[1] A；多选格式：[2] A,C；判断题用 正 或 誤；\n" +
      "填空题格式：[3]-1 答案；匹配题格式：[4]-1 A。\n\n" +
      "请严格按题号作答，不要改变题目顺序。";
    return instructions + "\n\n" + formatQuestionsPlain(questions, tr);
  }

  // ---- parse ----
  const SPLIT_BEFORE_NUM_RE = /\s*[,，、]\s*(?=\[\d+\])/;
  const CHOICE_SEP = ",，、/／+＋&＆・;；";
  const CHOICE_RE = /\[(\d+)\]\s*([A-Za-z])(?![A-Za-z])/;
  const CHOICE_MULTI_RES = [
    new RegExp(`\\[\\d+\\]\\s*([A-Za-z](?:\\s*[${CHOICE_SEP}]\\s*[A-Za-z])+)\\s*(?:$|[^\\sA-Za-z])`),
    new RegExp(`\\[\\d+\\]\\s*([A-Za-z](?:[\\s${CHOICE_SEP}]+[A-Za-z])+)\\s*$`),
  ];
  const FIMB_RE = /\[(\d+)\](?:-(\d+))?\s*[:：]?\s*(.*)$/;
  const TF_ANSWER_RE = /\[(\d+)\]\s*(正|誤|误|true|false|[tf])(?![A-Za-z])/i;

  function parseFimb(m, q, buf) {
    const n = q.blanks.length;
    const text = (m[3] || "").trim();
    if (!text) return;
    if (m[2] !== undefined && m[2] !== null && m[2] !== "") {
      const k = parseInt(m[2]) - 1;
      if (k >= 0 && k < n) buf[k] = text;
    } else if (n === 1) {
      buf[0] = text;
    } else {
      const sep = /[|｜]/.test(text) ? /[|｜]/ : /[,，]/;
      const parts = text.split(sep).map(p => p.trim());
      if (parts.length === n && parts.every(Boolean)) {
        for (let i = 0; i < n; i++) buf[i] = parts[i];
      }
    }
  }
  function parseChoice(line, q) {
    let letters = null;
    for (const rx of CHOICE_MULTI_RES) {
      const m = line.match(rx);
      if (m) { letters = choiceLetters(m[1]); break; }
    }
    if (letters === null) {
      const m = line.match(CHOICE_RE);
      if (!m) return null;
      letters = [m[2].toUpperCase()];
    }
    if (letters.some(ch => ch.charCodeAt(0) - 65 >= q.options.length)) return null;
    return letters.join(", ");
  }
  function parseAnswers(text, questions) {
    const allAnswers = {};
    const matchingBuf = {};
    const expandedLines = [];
    for (const rawLine of text.trim().split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const lm = line.match(/^\[(\d+)\]/);
      let leadingType = null;
      if (lm) {
        const qi = parseInt(lm[1]) - 1;
        if (qi >= 0 && qi < questions.length) leadingType = questions[qi].type;
      }
      if (leadingType === "fimb") expandedLines.push(line);
      else expandedLines.push(...line.split(SPLIT_BEFORE_NUM_RE).map(s => s.trim()).filter(Boolean));
    }
    for (const line of expandedLines) {
      if (!line) continue;
      // fimb
      let m = line.match(FIMB_RE);
      if (m) {
        const qIdx = parseInt(m[1]) - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "fimb") {
          const q = questions[qIdx];
          if (!(qIdx in matchingBuf)) matchingBuf[qIdx] = new Array(q.blanks.length).fill(null);
          parseFimb(m, q, matchingBuf[qIdx]);
          continue;
        }
      }
      // matching [n]-p
      m = line.match(/^\[(\d+)\]-(\d+)\s+([A-Za-z]|\d+)/);
      if (m) {
        const qNum = parseInt(m[1]), pNum = parseInt(m[2]);
        const ansVal = m[3];
        const qIdx = qNum - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "matching" && pNum >= 1 && pNum <= questions[qIdx].prompts.length) {
          if (!(qIdx in matchingBuf)) matchingBuf[qIdx] = new Array(questions[qIdx].prompts.length).fill(null);
          if (/^\d+$/.test(ansVal)) matchingBuf[qIdx][pNum - 1] = parseInt(ansVal) - 1;
          else matchingBuf[qIdx][pNum - 1] = ansVal.toUpperCase().charCodeAt(0) - 65;
        }
        continue;
      }
      // matching [n] p letter
      m = line.match(/^\[(\d+)\]\s+(\d+)\s+([A-Za-z])/);
      if (m) {
        const qNum = parseInt(m[1]), pNum = parseInt(m[2]);
        const ansVal = m[3].toUpperCase();
        const qIdx = qNum - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "matching" && pNum >= 1 && pNum <= questions[qIdx].prompts.length) {
          if (!(qIdx in matchingBuf)) matchingBuf[qIdx] = new Array(questions[qIdx].prompts.length).fill(null);
          matchingBuf[qIdx][pNum - 1] = ansVal.charCodeAt(0) - 65;
        }
        continue;
      }
      // matching [n] 1 2 3
      m = line.match(/^\[(\d+)\]\s+(\d+(?:\s+\d+)+)/);
      if (m) {
        const qNum = parseInt(m[1]);
        const numsStr = m[2].trim().split(/\s+/);
        const qIdx = qNum - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "matching") {
          const nums = numsStr.map(x => parseInt(x) - 1);
          if (nums.length === questions[qIdx].prompts.length) matchingBuf[qIdx] = nums;
        }
        continue;
      }
      // TF
      const tfm = line.match(TF_ANSWER_RE);
      if (tfm) {
        const qIdx = parseInt(tfm[1]) - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "truefalse") {
          allAnswers[qIdx] = normalizeTf(tfm[2]);
          continue;
        }
        if (["正", "誤", "误"].includes(tfm[2])) continue;
      }
      // choice
      const chm = line.match(CHOICE_RE);
      if (chm) {
        const qIdx = parseInt(chm[1]) - 1;
        if (qIdx >= 0 && qIdx < questions.length && questions[qIdx].type === "multipleanswer") {
          const ans = parseChoice(line, questions[qIdx]);
          if (ans) allAnswers[qIdx] = ans;
        }
        continue;
      }
      const tokens = line.split(/\s+/);
      if (tokens.length && tokens.every(t => /^-?\d+$/.test(t))) {
        try {
          const nums = tokens.map(t => parseInt(t) - 1);
          for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (q.type === "matching" && !(i in matchingBuf)) {
              if (nums.length === q.prompts.length) { matchingBuf[i] = nums; break; }
            }
          }
        } catch (e) {}
      } else if (tokens.every(ch => /^[A-Ha-h]$/.test(ch))) {
        for (const ch of tokens) {
          for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (q.type === "multipleanswer" && !(i in allAnswers)) { allAnswers[i] = ch.toUpperCase(); break; }
          }
        }
      } else if (tokens.some(ch => ["正", "誤", "误"].includes(ch))) {
        for (const ch of tokens) {
          if (/^[A-Ha-h]$/.test(ch)) {
            for (let i = 0; i < questions.length; i++) {
              const q = questions[i];
              if (q.type === "multipleanswer" && !(i in allAnswers)) { allAnswers[i] = ch.toUpperCase(); break; }
            }
          } else if (["正", "誤", "误"].includes(ch)) {
            for (let i = 0; i < questions.length; i++) {
              const q = questions[i];
              if (q.type === "truefalse" && !(i in allAnswers)) { allAnswers[i] = normalizeTf(ch); break; }
            }
          }
        }
      }
    }
    for (const [qIdx, answers] of Object.entries(matchingBuf)) {
      if (answers && answers.every(a => a !== null)) allAnswers[qIdx] = answers;
    }
    return { allAnswers, matchingBuf };
  }

  function buildPreviewHtml(questions, answers, matchingBuf, tr) {
    const lines = [];
    const warningLines = [];
    for (const i of Object.keys(answers).map(Number).sort((a, b) => a - b)) {
      const q = questions[i];
      const ans = answers[i];
      if (q.type === "matching") {
        const pairs = ans.map((v, j) => `${j + 1}→${v + 1}`).join(", ");
        lines.push(esc(tr("preview_matching", i + 1, pairs)));
      } else if (q.type === "fimb") {
        const pairs = ans.map((a, j) => `${j + 1}=${a}`).join(" | ");
        lines.push(esc(tr("preview_fimb", i + 1, pairs)));
      } else if (q.type === "truefalse") {
        lines.push(esc(tr("preview_truefalse", i + 1, ans)));
      } else {
        lines.push(esc(tr("preview_choice", i + 1, ans)));
        const picked = choiceLetters(ans).length;
        const limit = q.max_select;
        if (limit && picked > limit) warningLines.push(tr("preview_over_limit", i + 1, picked, limit));
      }
    }
    for (const [qIdxStr, buf] of Object.entries(matchingBuf)) {
      if (!buf.every(a => a !== null)) {
        const qIdx = parseInt(qIdxStr);
        const missing = buf.map((a, j) => a === null ? j + 1 : null).filter(Boolean);
        const key = questions[qIdx].type === "fimb" ? "preview_fimb_incomplete" : "preview_matching_incomplete";
        warningLines.push(tr(key, qIdx + 1, missing.join(", ")));
      }
    }
    const unansweredList = questions.map((_, i) => i).filter(i => !(i in answers)).map(i => i + 1);
    if (unansweredList.length) warningLines.push(tr("preview_unanswered", unansweredList.join(", ")));
    if (warningLines.length) {
      lines.push("");
      for (const wl of warningLines) lines.push(`<span class="warn">${esc(wl)}</span>`); // 颜色随主题，见 qzStyle
    }
    return "<div>" + lines.join("</div><div>") + "</div>";
  }
  function buildAnswerBody(q, ans) {
    if (q.type === "matching") return { questionType: q.api_type || "matching", givenAnswers: ans };
    if (q.type === "fimb") {
      const blanks = q.blanks;
      if (!Array.isArray(ans) || !blanks || ans.length !== blanks.length) return null;
      const ga = {};
      blanks.forEach((b, i) => { ga[b] = ans[i]; });
      return { questionType: q.api_type, givenAnswers: ga };
    }
    if (q.type === "truefalse") {
      if (ans !== "正" && ans !== "誤") return null;
      if (isEitherOr(q)) return { questionType: q.api_type, givenAnswer: ans === "正" };
      const selected = [false, false];
      selected[ans === "正" ? 0 : 1] = true;
      return { questionType: q.api_type || q.type || "multipleanswer", givenAnswer: selected };
    }
    const letters = choiceLetters(ans);
    if (!letters.length) return null;
    const selected = new Array(q.options.length).fill(false);
    for (const ch of letters) {
      const idx = ch.charCodeAt(0) - 65;
      if (idx >= q.options.length) return null;
      selected[idx] = true;
    }
    return { questionType: q.api_type || q.type || "multipleanswer", givenAnswer: selected };
  }
  function buildClearBody(q) {
    if (q.type === "matching") return { questionType: q.api_type || "matching", givenAnswers: new Array(q.prompts.length).fill(null) };
    if (isEitherOr(q)) return { questionType: q.api_type, givenAnswer: null };
    if (q.type === "fimb") {
      const ga = {};
      (q.blanks || []).forEach(b => { ga[b] = ""; });
      return { questionType: q.api_type, givenAnswers: ga };
    }
    return { questionType: q.api_type || q.type || "multipleanswer", givenAnswer: new Array(q.options.length).fill(false) };
  }
  function unanswered(questions, answers) { return questions.map((_, i) => i).filter(i => !(i in answers)).map(i => i + 1); }

  // 答题面板状态
  let qzPanel = null;
  let qzGrouped = [];
  let qzColumnItems = [];
  let qzCourseId = "";
  let qzColumnId = "";
  let qzContentId = "";
  let qzAttemptId = "";
  let qzQuestions = [];
  let qzAllAnswers = {};
  let qzMatchingBuf = {};
  let qzMaterialSeq = 0;

  // 問題演習 专用：题目框只读、预览区的警告颜色
  const qzStyle = `
    #${QZ_PANEL_ID} #bbqz-qdisplay{min-height:220px; background:transparent!important}
    #${QZ_PANEL_ID} #bbqz-ansinput{min-height:140px}
    #${QZ_PANEL_ID} .attempt{margin:0; font-size:13px; color:var(--muted)}
    #${QZ_PANEL_ID} #bbqz-preview{min-height:72px; padding:12px 0 0; border-top:1px solid var(--rule); font-size:13.5px; line-height:1.7}
    #${QZ_PANEL_ID} #bbqz-preview:empty::before{content:attr(data-empty); color:var(--muted)}
    #${QZ_PANEL_ID} #bbqz-preview .warn{color:var(--danger); font-weight:700}
    #${QZ_PANEL_ID} .qz-ai-actions{flex-wrap:nowrap}
    #${QZ_PANEL_ID} .qz-ai-actions .btn{flex:1 1 0; min-width:0}
    #${QZ_PANEL_ID} .qz-material-modal{position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center;
      padding:20px; background:rgba(0,0,0,.42)}
    #${QZ_PANEL_ID} .qz-material-modal[hidden]{display:none!important}
    #${QZ_PANEL_ID} .qz-material-card{display:flex; flex-direction:column; width:min(560px,100%); max-height:min(680px,88vh);
      padding:20px; border:1px solid var(--line); border-radius:12px; background:var(--bg); color:var(--fg); box-shadow:0 18px 55px rgba(0,0,0,.28)}
    #${QZ_PANEL_ID} .qz-material-card h2{margin:0 0 6px!important; font:700 18px/1.4 var(--font)!important; color:var(--fg)!important}
    #${QZ_PANEL_ID} .qz-material-list{overflow:auto; min-height:180px; max-height:52vh; margin:14px 0; border:1px solid var(--line)}
    #${QZ_PANEL_ID} .qz-material-file{display:flex!important; width:100%; min-height:48px; align-items:center; justify-content:flex-start;
      padding:8px 12px!important; border:0!important; border-top:1px solid var(--line)!important; border-radius:0!important;
      background:transparent!important; color:var(--fg)!important; font:500 14px/1.4 var(--font)!important; text-align:left; white-space:normal; overflow-wrap:anywhere}
    #${QZ_PANEL_ID} .qz-material-file:first-child{border-top:0!important}
    #${QZ_PANEL_ID} .qz-material-file:disabled{opacity:.45}
    #${QZ_PANEL_ID} .qz-material-actions{display:flex; justify-content:flex-end; gap:10px}
    @media(max-width:640px){#${QZ_PANEL_ID} .qz-ai-actions{gap:8px} #${QZ_PANEL_ID} .qz-ai-actions .btn{padding:0 8px!important}
      #${QZ_PANEL_ID} .qz-material-card{max-height:82vh}}
  `;
  function buildQuizPanel() {
    if (document.getElementById(QZ_PANEL_ID)) return;
    qzPanel = document.createElement("div");
    qzPanel.id = QZ_PANEL_ID;
    mountShell(qzPanel, {
      sub: { id: "bbqz-sub" },
      titleId: "bbqz-title",
      closeId: "bbqz-x",
      bodyHtml: `
        <section class="sec">
          <h2 id="bbqz-h-pick"></h2>
          <div class="row">
            <label class="fld"><span id="bbqz-f-term"></span><select id="bbqz-term"><option>…</option></select></label>
          </div>
          <div class="row">
            <label class="fld"><span id="bbqz-f-course"></span><select id="bbqz-course"><option value=""></option></select></label>
          </div>
          <div class="row">
            <label class="fld"><span id="bbqz-f-column"></span><select id="bbqz-column"><option value=""></option></select></label>
            <button class="btn line" id="bbqz-start" type="button"></button>
          </div>
          <p class="attempt" id="bbqz-attemptinfo"></p>
        </section>
        <section class="sec">
          <h2 id="bbqz-qtitle"></h2>
          <p class="desc" id="bbqz-qdesc"></p>
          <div class="row">
            <textarea id="bbqz-qdisplay" readonly placeholder=""></textarea>
          </div>
          <div class="row">
            <label class="fld"><span id="bbqz-f-aiurl"></span><input type="text" id="bbqz-aiurl" placeholder="chatgpt:// 或 https://chatgpt.com/"></label>
          </div>
          <div class="row qz-ai-actions">
            <button class="btn line" id="bbqz-copy" type="button"></button>
            <button class="btn line" id="bbqz-attach" type="button"></button>
            <button class="btn line" id="bbqz-ask-ai" type="button"></button>
          </div>
        </section>
        <section class="sec">
          <h2 id="bbqz-atitle"></h2>
          <div class="row">
            <textarea id="bbqz-ansinput" placeholder=""></textarea>
          </div>
          <div class="row">
            <button class="btn line" id="bbqz-parse" type="button"></button>
            <button class="btn line" id="bbqz-clearinput" type="button"></button>
          </div>
        </section>
        <section class="sec">
          <h2 id="bbqz-ptitle"></h2>
          <div class="row"><div id="bbqz-preview" style="flex:1 1 100%" aria-live="polite"></div></div>
          <div class="row">
            <button class="btn line" id="bbqz-browser" type="button"></button>
            <button class="btn danger" id="bbqz-clearall" type="button"></button>
          </div>
        </section>
        <div class="qz-material-modal" id="bbqz-material-modal" hidden>
          <div class="qz-material-card" role="dialog" aria-modal="true" aria-labelledby="bbqz-material-title">
            <h2 id="bbqz-material-title"></h2>
            <p class="desc" id="bbqz-material-desc"></p>
            <div class="qz-material-list" id="bbqz-material-list"></div>
            <div class="qz-material-actions">
              <button class="btn line" id="bbqz-material-back" type="button"></button>
            </div>
          </div>
        </div>`,
      footerHtml: `<div class="bbtool-status" id="bbqz-status" role="status"></div>
        <div class="bbtool-actions">
          <button class="btn sec bbtool-dismiss m-hide" data-k="close" type="button"></button>
          <button class="btn" id="bbqz-submit" type="button"></button>
        </div>`,
    });

    const $ = (s) => qzPanel.querySelector(s);
    const status = (txt) => { $("#bbqz-status").textContent = txt; };

    function applyLang() {
      $("#bbqz-sub").textContent = t("sub_qz");
      $("#bbqz-title").textContent = t("qtitle");
      $("#bbqz-h-pick").textContent = t("qz_sec_pick");
      $("#bbqz-f-term").textContent = t("f_term");
      $("#bbqz-f-course").textContent = t("f_course");
      $("#bbqz-f-column").textContent = t("f_column");
      $("#bbqz-qdesc").textContent = t("order_warning").replace(/^⚠\s*/, "");
      $("#bbqz-f-aiurl").textContent = t("ai_url_label");
      $("#bbqz-preview").dataset.empty = t("qz_preview_empty");
      $("#bbqz-start").textContent = t("start_attempt");
      $("#bbqz-qtitle").textContent = t("question_group");
      $("#bbqz-atitle").textContent = t("answer_input_group");
      $("#bbqz-ptitle").textContent = t("preview_group");
      $("#bbqz-copy").textContent = t("copy_ai");
      $("#bbqz-attach").textContent = t("attach_materials");
      $("#bbqz-ask-ai").textContent = t("ask_ai");
      $("#bbqz-material-title").textContent = t("attach_title");
      $("#bbqz-material-desc").textContent = t("attach_desc");
      $("#bbqz-material-back").textContent = t("attach_back");
      $("#bbqz-parse").textContent = t("parse_ans");
      $("#bbqz-clearinput").textContent = t("clear_input") || "Clear";
      $("#bbqz-submit").textContent = t("submit_ans");
      $("#bbqz-browser").textContent = t("browser_submit");
      $("#bbqz-clearall").textContent = t("clear_ans");
      $("#bbqz-qdisplay").placeholder = t("select_quiz_first");
      $("#bbqz-ansinput").placeholder = t("hint_text");
      const cs = $("#bbqz-course");
      if (cs.options[0]) cs.options[0].textContent = t("pick_course");
      const col = $("#bbqz-column");
      if (col.options[0]) col.options[0].textContent = t("pick_column");
      fillTermOptions(); // 只刷新文字，不重置已选的课程/评量
    }

    // 语言/主题下拉框由 mountShell 统一接线
    langHooks.add(applyLang);
    applyLang();

    const aiUrlInput = $("#bbqz-aiurl");
    aiUrlInput.value = store.get(LS_QZ_AIURL, "");
    aiUrlInput.onchange = () => store.set(LS_QZ_AIURL, aiUrlInput.value.trim());

    function clearPreparedMaterials() {
      qzMaterialSeq++;
      $("#bbqz-material-list").innerHTML = "";
    }
    function flattenCourseFiles(nodes, out = []) {
      for (const node of nodes || []) {
        if (node.type === "file" && node.name && node.url && /\.pdf$/i.test(node.name.trim())) out.push(node);
        if (node.children) flattenCourseFiles(node.children, out);
      }
      return out;
    }
    async function strictPdfFile(blob, name) {
      // MIME headers from Blackboard are not always reliable, so verify the
      // PDF signature in the actual response body before sharing it.
      const signature = await blob.slice(0, 5).text();
      if (signature !== "%PDF-") throw new Error(t("attach_not_pdf"));
      const safeName = sanitize(name).replace(/\.pdf$/i, "") + ".pdf";
      return new File([blob], safeName, {
        type: "application/pdf",
        lastModified: Date.now(),
      });
    }
    function closeMaterialPicker(clear = true) {
      $("#bbqz-material-modal").hidden = true;
      if (clear) clearPreparedMaterials();
    }

    $("#bbqz-attach").onclick = async () => {
      if (!qzCourseId) {
        return status(t("pick_course"));
      }
      const seq = ++qzMaterialSeq;
      const modal = $("#bbqz-material-modal");
      const list = $("#bbqz-material-list");
      modal.hidden = false;
      list.innerHTML = `<p class="desc" style="padding:12px">${esc(t("attach_loading"))}</p>`;
      try {
        const files = flattenCourseFiles(await scanTree(qzCourseId, "ROOT", "", () => {}))
          .sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")));
        if (seq !== qzMaterialSeq) return;
        list.innerHTML = "";
        for (let index = 0; index < files.length; index++) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "qz-material-file";
          button.disabled = true;
          button.textContent = files[index].name;
          list.appendChild(button);
        }
        list.__files = files;
        if (!files.length) list.innerHTML = `<p class="desc" style="padding:12px">${esc(t("attach_none"))}</p>`;
        for (let index = 0; index < files.length; index++) {
          if (seq !== qzMaterialSeq) return;
          const item = files[index];
          status(t("attach_preparing", index + 1, files.length, item.name));
          try {
            const blob = await fetchBlob(absUrl(item.url), item.name);
            if (seq !== qzMaterialSeq) return;
            const sharedFile = await strictPdfFile(blob, item.name);
            const button = list.children[index];
            button.disabled = false;
            button.onclick = () => {
              // iOS may materialize Web Share's title/text as an extra text
              // document. Pass only the actual file so the share target sees
              // exactly one attachment: the selected course material.
              const shareData = { files: [sharedFile] };
              if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
                navigator.share(shareData).then(
                  () => status(t("attach_shared")),
                  (error) => status(error && error.name === "AbortError" ? t("attach_share_cancelled") : t("attach_failed", error.message || String(error)))
                );
              } else {
                saveBlob(blob, sanitize(item.name));
                status(t("attach_share_unsupported"));
              }
            };
          } catch (error) {
            const button = list.children[index];
            if (button) button.textContent = `⚠ ${item.name}`;
          }
        }
        if (files.length) status(t("attach_ready", files.length));
      } catch (error) {
        list.__files = [];
        list.innerHTML = `<p class="desc" style="padding:12px">${esc(t("attach_failed", error.message || String(error)))}</p>`;
      }
    };
    $("#bbqz-material-back").onclick = () => closeMaterialPicker(true);

    function fillTermOptions() {
      const termSel = $("#bbqz-term");
      if (termSel.dataset.loaded !== "1") return;
      const cur = termSel.value;
      termSel.innerHTML = qzGrouped.map(([tm, cs]) => `<option value="${tm}">${tm ? esc(tm) : t("other")}（${cs.length}）</option>`).join("");
      if (cur && qzGrouped.some(([tm]) => tm === cur)) termSel.value = cur;
    }
    function fillCourses() {
      const term = $("#bbqz-term").value;
      const cs = (qzGrouped.find(([tm]) => tm === term) || [null, []])[1];
      $("#bbqz-course").innerHTML = `<option value="">${t("pick_course")}</option>` + cs.map(c => `<option value="${c.id}">${esc(c.short)}</option>`).join("");
      $("#bbqz-column").innerHTML = `<option value="">${t("pick_column")}</option>`;
      qzColumnItems = [];
    }
    async function loadCourses() {
      if ($("#bbqz-term").dataset.loaded === "1") return;
      try {
        status(t("loading"));
        qzGrouped = groupCourses(await getQuizCourses());
        $("#bbqz-term").dataset.loaded = "1";
        fillTermOptions();
        const saved = store.get("bbqz.term", "");
        if (saved && qzGrouped.some(([tm]) => tm === saved)) $("#bbqz-term").value = saved;
        fillCourses();
        status(t("count", qzGrouped.reduce((n, [, cs]) => n + cs.length, 0)));
      } catch (e) {
        status(t("load_fail", e.message));
      }
    }

    $("#bbqz-term").onchange = () => { store.set("bbqz.term", $("#bbqz-term").value); fillCourses(); };
    $("#bbqz-course").onchange = async () => {
      clearPreparedMaterials();
      const cid = $("#bbqz-course").value;
      if (!cid) { qzColumnItems = []; $("#bbqz-column").innerHTML = `<option value="">${t("pick_column")}</option>`; return; }
      qzCourseId = cid;
      qzColumnId = ""; qzContentId = ""; qzAttemptId = "";
      qzQuestions = []; qzAllAnswers = {}; qzMatchingBuf = {};
      $("#bbqz-qdisplay").value = ""; $("#bbqz-preview").innerHTML = "";
      status(t("getting_items"));
      try {
        const raw = await getAllColumns(cid);
        qzColumnItems = await flattenColumns(raw, cid);
        if (!qzColumnItems.length) {
          for (const col of raw) {
            const name = col.columnName || col.effectiveColumnName || col.name || "";
            if (name) qzColumnItems.push({ name, id: col.id, contentId: col.contentId || "" });
          }
        }
        $("#bbqz-column").innerHTML = `<option value="">${t("pick_column")}</option>` + qzColumnItems.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
        status(t("getting_items") + ` (${qzColumnItems.length})`);
      } catch (e) { status(t("load_fail", e.message)); }
    };

    $("#bbqz-column").onchange = async () => {
      const idx = $("#bbqz-column").selectedIndex - 1;
      if (idx < 0 || idx >= qzColumnItems.length) return;
      const sel = qzColumnItems[idx];
      qzColumnId = sel.id;
      qzContentId = sel.contentId || "";
      qzAttemptId = "";
      qzQuestions = []; qzAllAnswers = {}; qzMatchingBuf = {};
      $("#bbqz-qdisplay").value = ""; $("#bbqz-preview").innerHTML = "";
      status(t("selected_assessment", sel.name));
      status(t("checking_attempt"));
      try {
        const column = await getColumn(qzCourseId, qzColumnId);
        const attempts = await getAllAttempts(qzCourseId, qzColumnId);
        $("#bbqz-attemptinfo").textContent = attemptInfoText(column, attempts);
        const existing = pickAttempt(attempts);
        if (existing) {
          qzAttemptId = existing.id || "";
          status(t("attempt_resumed"));
          await loadQuestions();
        } else {
          status(t("no_attempt_start"));
        }
      } catch (e) { status(t("load_fail", e.message)); }
    };

    function pickAttempt(attempts) {
      const ip = attempts.find(a => a.status === "IN_PROGRESS");
      return ip || (attempts.length ? attempts[0] : null);
    }
    function attemptInfoText(column, attempts) {
      const used = attempts.length;
      let limit = -1;
      if ("multipleAttempts" in column) limit = parseInt(column.multipleAttempts || 0);
      let count;
      if (limit > 0) count = t("attempts_used", used, limit);
      else if (limit === 0) count = t("attempts_used", used, "∞");
      else count = t("attempts_used", used, "?");
      return count;
    }

    async function startAttempt() {
      if (!qzColumnId) { status(t("select_quiz_first")); return; }
      status(t("checking_attempt"));
      try {
        const attempts = await getAllAttempts(qzCourseId, qzColumnId);
        const ip = attempts.find(a => a.status === "IN_PROGRESS");
        if (ip) {
          qzAttemptId = ip.id || "";
          status(t("attempt_resumed"));
          await loadQuestions();
          return;
        }
        // check limit
        const column = await getColumn(qzCourseId, qzColumnId);
        let allowed = 0, used = attempts.length, unknown = true;
        if ("multipleAttempts" in column) {
          const limit = parseInt(column.multipleAttempts || 0);
          if (limit > 0) { allowed = limit; unknown = false; }
          else if (limit === 0) { unknown = false; }
        }
        if (!unknown && allowed > 0) {
          status(t("attempts_used", used, allowed));
          if (used >= allowed) { status(t("attempt_limit_reached", allowed)); return; }
        }
        const msg = unknown ? t("attempt_limit_unknown") : (allowed > 0 ? t("attempt_confirm_msg", used + 1, allowed) : t("attempt_confirm_unlimited"));
        if (!confirm(msg)) return;
        status(t("creating_attempt"));
        const result = await createAttempt(qzCourseId, qzColumnId);
        if (result) {
          qzAttemptId = result.id || "";
          status(t("attempt_created", qzAttemptId));
          await loadQuestions();
        } else {
          status(t("attempt_failed"));
        }
      } catch (e) {
        status(t("attempt_failed") + ": " + e.message);
      }
    }
    $("#bbqz-start").onclick = startAttempt;

    async function loadQuestions() {
      if (!qzAttemptId) { status(t("no_attempt")); return; }
      status(t("loading_questions"));
      try {
        const data = await getAnswers(qzCourseId, qzAttemptId);
        qzQuestions = buildQuestions(data || {});
        qzAllAnswers = {};
        qzMatchingBuf = {};
        $("#bbqz-qdisplay").value = formatQuestionsDisplay(qzQuestions, t);
        $("#bbqz-preview").innerHTML = "";
        status(t("questions_loaded", qzQuestions.length));
        const imgCount = qzQuestions.reduce((n, q) => n + (q.images || []).length, 0);
        if (imgCount) status(t("images_found", imgCount));
      } catch (e) {
        status(t("load_failed") + ": " + e.message);
      }
    }

    // 支持普通网页和 iOS App URL Scheme。自定义 Scheme 不能被补成 https://。
    function normalizeAiTarget(v) {
      v = String(v || "").trim();
      if (!v) return "";
      if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v.replace(/^\/+/, "");
      return v;
    }
    function copySync(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {} // iOS 需要
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      ta.remove();
      return ok;
    }
    function copyQuizQuestions(forAi = false) {
      if (!qzQuestions.length) { status(t("select_quiz_first")); return; }
      const text = forAi
        ? buildAiText(qzQuestions, t)
        : formatQuestionsPlain(qzQuestions, t);
      let copied = copySync(text);
      if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
        try { navigator.clipboard.writeText(text).then(() => status(t("copied")), () => status("Copy failed")); copied = true; } catch (e) {}
      }
      status(copied ? t("copied") : "Copy failed");
      return copied;
    }

    function openAiTarget() {
      const target = normalizeAiTarget(aiUrlInput.value);
      if (!target) { status(t("ai_target_missing")); aiUrlInput.focus(); return false; }
      aiUrlInput.value = target;
      store.set(LS_QZ_AIURL, target);
      let win = null;
      try { win = window.open(target, "_blank", "noopener"); } catch (e) {}
      if (!win) {
        const a = document.createElement("a");
        a.href = target; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      }
      return true;
    }

    $("#bbqz-copy").onclick = () => {
      copyQuizQuestions(false);
    };

    $("#bbqz-ask-ai").onclick = () => {
      if (!qzQuestions.length) { status(t("select_quiz_first")); return; }
      copyQuizQuestions(true);
      openAiTarget();
    };

    $("#bbqz-parse").onclick = () => {
      if (!qzQuestions.length) { status(t("select_quiz_first")); return; }
      const text = $("#bbqz-ansinput").value;
      const res = parseAnswers(text, qzQuestions);
      qzAllAnswers = res.allAnswers;
      qzMatchingBuf = res.matchingBuf;
      $("#bbqz-preview").innerHTML = buildPreviewHtml(qzQuestions, qzAllAnswers, qzMatchingBuf, t);
      status(t("parsed_count", Object.keys(qzAllAnswers).length, qzQuestions.length));
    };

    // auto-parse on input
    let parseTimer = null;
    $("#bbqz-ansinput").addEventListener("input", () => {
      if (!qzQuestions.length) return;
      clearTimeout(parseTimer);
      parseTimer = setTimeout(() => $("#bbqz-parse").click(), 600);
    });

    $("#bbqz-clearinput").onclick = () => { $("#bbqz-ansinput").value = ""; };

    function attemptUrl() {
      const cid = qzContentId || qzColumnId;
      return `${LMS}/ultra/courses/${qzCourseId}/assessment/${cid}/attempt/${qzAttemptId}?courseId=${qzCourseId}`;
    }
    // 两条通道都被服务器拒绝时的兜底：把 attempt 页面开出来，用户在页面里自己点提交
    function offerBrowserFallback() {
      if (!qzAttemptId) return;
      try { status(t("submit_manual")); } catch (e) {}
      try { window.open(attemptUrl(), "_blank"); } catch (e) {}
    }

    $("#bbqz-submit").onclick = async () => {
      if (!qzAllAnswers || !Object.keys(qzAllAnswers).length) { status(t("no_answers")); return; }
      if (!qzAttemptId) { status(t("no_attempt")); return; }
      const unansweredList = unanswered(qzQuestions, qzAllAnswers);
      let msg = t("confirm_submit", Object.keys(qzAllAnswers).length);
      if (unansweredList.length) msg += "\n\n" + t("confirm_unanswered", unansweredList.join(", "));
      if (!confirm(msg)) return;
      status("Submitting…");
      await resolveXsrf(false);
      console.log("[bbqz] submit", diagXsrf(), "attempt=", qzAttemptId, "course=", qzCourseId);
      let success = 0, fail = 0;
      const expectedBodies = new Map();
      for (let i = 0; i < qzQuestions.length; i++) {
        if (!(i in qzAllAnswers)) continue;
        const q = qzQuestions[i];
        const ans = qzAllAnswers[i];
        const body = buildAnswerBody(q, ans);
        if (!body) { fail++; continue; }
        expectedBodies.set(String(q.id), body);
        try {
          let r = await submitAnswer(qzCourseId, qzAttemptId, q.id, body);
          if (!r.ok && (r.status === 403 || r.status === 401)) {
            // token 可能过期或没取到：强制重新解析（含 GM_cookie/页面拦截）后再试一次
            await resolveXsrf(true);
            r = await submitAnswer(qzCourseId, qzAttemptId, q.id, body);
          }
          if (r.ok) success++; else {
            fail++;
            let txt = "";
            try { txt = await r.text(); } catch (e) {}
            console.error("submit fail", r.status, txt, q.id, body);
            const emsg = "HTTP " + r.status + " " + (txt || "").slice(0, 120);
            status(emsg);
            if (success === 0 && fail === 1) { try { alert("提交失败: " + emsg + "\n" + diagXsrf()); } catch (e) {} offerBrowserFallback(); }
          }
        } catch (e) { fail++; console.error("submit err", e); }
        await new Promise(r => setTimeout(r, 300));
      }
      if (success) {
        try {
          const fresh = await getAnswers(qzCourseId, qzAttemptId);
          const saved = new Map(((fresh && fresh.results) || []).map((item) => [String(item.id || ""), item]));
          const sameValue = (actual, expected) => {
            if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => sameValue(actual[i], v));
            if (expected && typeof expected === "object") {
              return actual && typeof actual === "object" && Object.keys(expected).every((key) => sameValue(actual[key], expected[key]));
            }
            return actual === expected;
          };
          const answerMatches = (item, expected) => {
            if (!item || !expected) return false;
            if (Object.prototype.hasOwnProperty.call(expected, "givenAnswer")) return sameValue(item.givenAnswer, expected.givenAnswer);
            if (Object.prototype.hasOwnProperty.call(expected, "givenAnswers")) return sameValue(item.givenAnswers, expected.givenAnswers);
            return false;
          };
          const verified = [...expectedBodies.entries()].filter(([id, expected]) => answerMatches(saved.get(id), expected)).length;
          if (verified < success) {
            status(t("submit_verify_failed", verified, success));
            offerBrowserFallback();
            return;
          }
        } catch (error) {
          status(t("submit_verify_failed", 0, success));
          offerBrowserFallback();
          return;
        }
      }
      status(t("submit_done", success, fail));
    };

    $("#bbqz-clearall").onclick = async () => {
      if (!qzQuestions.length) { status(t("no_questions")); return; }
      if (!qzAttemptId) { status(t("no_attempt")); return; }
      if (!confirm(t("confirm_clear"))) return;
      status("Clearing…");
      await resolveXsrf(false);
      let success = 0, fail = 0;
      for (let i = 0; i < qzQuestions.length; i++) {
        const q = qzQuestions[i];
        const body = buildClearBody(q);
        try {
          let r = await submitAnswer(qzCourseId, qzAttemptId, q.id, body);
          if (!r.ok && (r.status === 403 || r.status === 401)) {
            await resolveXsrf(true);
            r = await submitAnswer(qzCourseId, qzAttemptId, q.id, body);
          }
          if (r.ok) success++; else {
            fail++;
            let txt = "";
            try { txt = await r.text(); } catch (e) {}
            console.error("submit fail", r.status, txt, q.id, body);
            const emsg = "HTTP " + r.status + " " + (txt || "").slice(0, 120);
            status(emsg);
            if (success === 0 && fail === 1) { try { alert("クリア失敗: " + emsg + "\n" + diagXsrf()); } catch (e) {} offerBrowserFallback(); }
          }
        } catch (e) { fail++; console.error("submit err", e); }
        await new Promise(r => setTimeout(r, 300));
      }
      status(t("clear_done", success, fail));
    };

    $("#bbqz-browser").onclick = () => {
      if (!qzAttemptId) { status(t("no_attempt")); return; }
      window.open(attemptUrl(), "_blank");
      status(t("browser_opened"));
    };

    qzPanel._open = () => { setShellOpen(qzPanel, true); loadCourses(); };
  }

  function toggleQuizPanel() {
    buildQuizPanel();
    if (qzPanel.classList.contains("open")) setShellOpen(qzPanel, false);
    else qzPanel._open();
  }
  // ---------------------------------------------------------------- DOM 就绪
  // @run-at document-start 时 body / base_tools 都还没有；SPA 的导航也可能比脚本晚出现。
  // 等到 body 出现且（导航锚点或登录表单）就位，或最多等 30 秒，再跑各模块的初始化。
  function whenReady(cb) {
    const ready = () => document.body && (document.getElementById("base_tools") || onLoginForm());
    if (ready()) { cb(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (ready()) { clearInterval(timer); cb(); }
      else if (tries > 120) { clearInterval(timer); cb(); }
    }, 250);
  }

  // ================================================================ 試題/作業（独立于答题助手）
  let taskPanel = null;
  let taskGrouped = [];
  let taskCourses = [];
  let taskView = "all";
  let taskSeq = 0;
  let taskUserId = "";
  const taskArchive = () => { try { return new Set(JSON.parse(store.get(LS_TS_ARCHIVE, "[]"))); } catch (e) { return new Set(); } };
  const saveTaskArchive = (set) => store.set(LS_TS_ARCHIVE, JSON.stringify([...set]));
  function jstDate(value) {
    if (value == null || value === "") return "—";
    let d;
    if (typeof value === "number") d = new Date(Math.abs(value) >= 1e11 ? value : value * 1000);
    else d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    const p = new Intl.DateTimeFormat("sv-SE", { timeZone:"Asia/Tokyo", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).format(d);
    return p.replace(" ", " ");
  }
  function assessmentItem(item) {
    const detail = item.contentDetail || {};
    const handler = typeof item.contentHandler === "string" ? item.contentHandler : ((item.contentHandler || {}).id || "");
    const hay = `${handler} ${Object.keys(detail).join(" ")}`.toLowerCase();
    return /asmt|assessment|assignment|test|survey/.test(hay);
  }
  async function scanAssessments(courseId, contentId = "ROOT", path = [], seen = new Set()) {
    if (seen.has(String(contentId))) return [];
    seen.add(String(contentId));
    // iOS Userscripts 的 GM 请求不一定携带 Blackboard Cookie；课程内容扫描
    // 必须沿用下载页已验证可用的当前页面同源会话。
    const data = await getJSON(API(`/learn/api/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/children?@view=Summary&limit=1000`));
    const out = [];
    for (const item of data.results || []) {
      const detail = item.contentDetail || {};
      const handlerId = typeof item.contentHandler === "string" ? item.contentHandler : ((item.contentHandler || {}).id || "");
      const keys = `${handlerId} ${Object.keys(detail).join(" ")}`.toLowerCase();
      if (assessmentItem(item)) {
        const generic = item.genericReadOnlyData || {};
        let gradeColumnId = "";
        let pointsPossible = null;
        let attemptsAllowed = null;
        for (const payload of Object.values(detail)) {
          const variants = [payload, payload && payload.test, payload && payload.survey, payload && payload.assignment];
          for (const v of variants) if (v && v.gradingColumn) {
            if (v.gradingColumn.id) gradeColumnId = String(v.gradingColumn.id);
            if (v.gradingColumn.possible != null) pointsPossible = v.gradingColumn.possible;
            if (v.gradingColumn.attemptsAllowed != null) attemptsAllowed = Number(v.gradingColumn.attemptsAllowed);
            if (v.attemptsAllowed != null) attemptsAllowed = Number(v.attemptsAllowed);
          }
        }
        out.push({ id:String(item.id), title:item.title || t("ts_test"), path:[...path], due:jstDate(generic.dueDate || item.dueDate), gradeColumnId,
          url:`${LMS}/ultra/courses/${courseId}/assessment/${item.id}/overview?courseId=${courseId}`, attempts:0, allowed:attemptsAllowed, attemptsKnown:false,
          points:pointsPossible == null ? "—" : `—/${pointsPossible}`, status:"—", completed:false });
      } else if (/x-bb-folder/.test(keys)) {
        out.push(...await scanAssessments(courseId, item.id, [...path, item.title || ""], seen));
      } else if (/x-bb-document/.test(keys)) {
        out.push(...await scanAssessments(courseId, item.id, path, seen).catch(() => []));
      }
    }
    return out;
  }
  function taskNumber(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function applyTaskDisplayGrade(quiz, displayGrade) {
    if (!displayGrade || typeof displayGrade !== "object") return false;
    const scale = String(displayGrade.scaleType || "");
    if (scale === "CompleteIncomplete") {
      const text = String(displayGrade.text || "").trim().toLowerCase();
      const markedComplete = ["complete","completed","完了","完成","已完成","✓","✔"].includes(text);
      quiz.completed = quiz.completed || markedComplete;
      quiz.points = markedComplete ? "✓" : "—";
      return true;
    }
    if (scale === "Text" || scale === "Tabular") { quiz.points = "—"; return true; }
    if (scale !== "Score" && scale !== "Percent") return false;
    let possible = taskNumber(displayGrade.possible);
    if (possible == null) possible = taskNumber(String(quiz.points).replace(/^—\//, ""));
    let earned = taskNumber(displayGrade.score);
    if (scale === "Percent" && earned != null && possible != null) earned = earned * possible / 100;
    if (possible != null) quiz.points = `${earned == null ? "—" : earned}/${possible}`;
    return earned != null;
  }
  function taskAttemptSubmitted(attempt) {
    if (!attempt || typeof attempt !== "object") return false;
    if (attempt.submitted === true || attempt.isSubmitted === true || attempt.dateSubmitted || attempt.submittedDate || attempt.submissionDate) return true;
    const state = String(attempt.status || attempt.attemptStatus || attempt.workflowStatus || attempt.gradingStatus || "")
      .replace(/[\s_-]/g, "").toLowerCase();
    if (!state || /notstarted|inprogress|draft|created|started/.test(state)) return false;
    return /submitted|completed|graded|needsgrading|pendinggrading|pending|awaitinggrading|inreview|review/.test(state);
  }
  async function enrichAssessments(courseId, quizzes) {
    let columns = [];
    const readJson = async (path) => { try { return await apiGet(path); } catch (e) { return await getJSON(API(path)); } };
    if (!taskUserId) {
      try { taskUserId = String((await readJson("/learn/api/v1/users/me")).id || ""); } catch (e) {}
    }
    try { columns = (await readJson(`/learn/api/public/v2/courses/${encodeURIComponent(courseId)}/gradebook/columns?limit=1000`)).results || []; } catch (e) {}
    const byContent = new Map(columns.filter(c => c.contentId).map(c => [String(c.contentId), c]));
    const byId = new Map(columns.filter(c => c.id).map(c => [String(c.id), c]));
    for (const quiz of quizzes) {
      let col = byId.get(quiz.gradeColumnId) || byContent.get(quiz.id) || (quiz.gradeColumnId ? { id:quiz.gradeColumnId, grading:{} } : null);
      if (!col) continue;
      quiz.gradeColumnId = String(col.id || quiz.gradeColumnId);
      try {
        const legacy = await readJson(`/learn/api/v1/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(quiz.gradeColumnId)}`);
        col = { ...legacy, ...col, grading:{ ...(legacy.grading || {}), ...(col.grading || {}) } };
      } catch (e) {}
      const grading = col.grading || {};
      if (Object.prototype.hasOwnProperty.call(grading, "attemptsAllowed")) quiz.allowed = Number(grading.attemptsAllowed);
      else if (Object.prototype.hasOwnProperty.call(col, "multipleAttempts")) quiz.allowed = Number(col.multipleAttempts);
      const possible = col.score && col.score.possible;
      if (possible != null && possible !== "") quiz.points = `—/${possible}`;
      try {
        let attempts = await getAllAttempts(courseId, quiz.gradeColumnId);
        if (taskUserId) attempts = attempts.filter(a => !a.userId || String(a.userId) === taskUserId);
        quiz.attemptsKnown = true;
        quiz.attempts = attempts.length;
        // 已提交但仍等待教师评分，也属于“已完成”。
        const completed = attempts.filter(taskAttemptSubmitted);
        quiz.completed = completed.length > 0;
        quiz.status = quiz.completed ? t("ts_completed") : t("ts_unfinished");
        let finalKnown = false;
        if (taskUserId) try {
          const grade = await readJson(`/learn/api/public/v2/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(quiz.gradeColumnId)}/users/${encodeURIComponent(taskUserId)}`);
          if (grade && grade.exempt === true) { quiz.completed = true; quiz.points = "—"; finalKnown = true; }
          else finalKnown = applyTaskDisplayGrade(quiz, grade && grade.displayGrade);
        } catch (e) {}
        if (!finalKnown) {
          const latest = completed[completed.length - 1] || attempts[attempts.length - 1];
          applyTaskDisplayGrade(quiz, latest && latest.displayGrade);
        }
        quiz.status = quiz.completed ? t("ts_completed") : t("ts_unfinished");
      } catch (e) { quiz.attemptsKnown = false; }
    }
    return quizzes;
  }
  async function loadTaskCourse(course) {
    try {
      const quizzes = await enrichAssessments(course.id, await scanAssessments(course.id));
      return { ...course, quizzes, failed:false };
    } catch (error) { return { ...course, quizzes:[], failed:true, error:String(error.message || error) }; }
  }
  function taskAttemptText(q) {
    if (!q.attemptsKnown) return "⚠";
    if (q.allowed === 0) return `${q.attempts}/∞`;
    if (Number.isFinite(q.allowed) && q.allowed > 0) return `${q.attempts}/${q.allowed}`;
    return `${q.attempts}/?`;
  }
  function taskKey(course, quiz) { return `${course.id}:${quiz.id}`; }
  function showTaskDetail(course, quiz) {
    const modal = taskPanel.querySelector("#bbts-detail");
    modal.hidden = false;
    modal.querySelector(".bbts-detail-body").innerHTML = `
      <h2>${esc(quiz.title)}</h2>
      <dl><dt>${esc(t("ts_course"))}</dt><dd>${esc(course.short || course.name)}</dd><dt>${esc(t("ts_due"))}</dt><dd>${esc(quiz.due)}</dd>
      <dt>${esc(t("ts_attempts"))}</dt><dd>${esc(taskAttemptText(quiz))}</dd><dt>${esc(t("ts_points"))}</dt><dd>${esc(quiz.points)}</dd>
      <dt>${esc(t("ts_status"))}</dt><dd>${esc(quiz.status)}</dd><dt>${esc(t("ts_type"))}</dt><dd>${esc(t("ts_test"))}</dd></dl>
      <a class="btn line" href="${esc(quiz.url)}" target="_blank" rel="noopener">${esc(t("ts_url"))}</a>`;
  }
  function renderTaskCourses() {
    if (!taskPanel) return;
    const root = taskPanel.querySelector("#bbts-list");
    const archived = taskArchive();
    root.innerHTML = "";
    for (const course of taskCourses) {
      const matches = course.quizzes.filter(q => {
        const a = archived.has(taskKey(course, q));
        return taskView === "archived" ? a : taskView === "completed" ? q.completed && !a : taskView === "unfinished" ? !q.completed && !a : !a;
      });
      const box = document.createElement("details");
      box.className = "bbts-course";
      // 未完成或读取失败的课程自动展开；其余课程一律默认收起。
      const hasUnfinished = course.quizzes.some(q => !q.completed && !archived.has(taskKey(course, q)));
      box.open = (taskView === "unfinished" && matches.length > 0) || (taskView === "all" && hasUnfinished) || course.failed;
      box.innerHTML = `<summary>${esc(course.short || course.name)} <span>${matches.length}</span></summary><div class="bbts-items"></div>`;
      const body = box.querySelector(".bbts-items");
      if (course.failed) body.innerHTML = `<p class="bbts-message">${esc(t("ts_failed"))}</p>`;
      else if (!matches.length) body.innerHTML = `<p class="bbts-message">${esc(t("ts_empty"))}</p>`;
      for (const quiz of matches) {
        const row = document.createElement("div");
        const selectable = taskView !== "completed";
        row.className = `bbts-row${selectable ? "" : " bbts-row-readonly"}`;
        row.innerHTML = `${selectable ? `<label><input type="checkbox" data-key="${esc(taskKey(course, quiz))}"></label>` : ""}<button class="bbts-name" type="button">${esc(quiz.title)}</button><span>${esc(quiz.due)}</span><span>${esc(taskAttemptText(quiz))}</span><span>${esc(quiz.points)}</span><span>${esc(t("ts_test"))}</span>`;
        row.querySelector(".bbts-name").onclick = () => showTaskDetail(course, quiz);
        body.appendChild(row);
      }
      root.appendChild(box);
    }
    updateTaskManagerControls();
  }
  function updateTaskManagerControls() {
    if (!taskPanel) return;
    taskPanel.querySelector("#bbts-title").textContent = t(taskView === "archived" ? "ts_archived" : taskView === "completed" ? "ts_completed" : taskView === "unfinished" ? "ts_unfinished" : "ts_title");
    taskPanel.querySelector("#bbts-history").textContent = t(taskView === "completed" ? "ts_unfinished" : "ts_completed");
    taskPanel.querySelector("#bbts-toggle").textContent = t(taskView === "archived" ? "ts_unfinished" : "ts_archived");
    taskPanel.querySelector("#bbts-batch").textContent = t(taskView === "archived" ? "ts_unarchive" : "ts_archive");
    taskPanel.querySelector("#bbts-batch").hidden = taskView === "completed";
    taskPanel.querySelector("#bbts-refresh").textContent = t("ts_refresh");
  }
  async function refreshTaskPanel() {
    const seq = ++taskSeq;
    const term = taskPanel.querySelector("#bbts-manage-term").value;
    const courses = (taskGrouped.find(([tm]) => tm === term) || [null, []])[1];
    updateTaskManagerControls();
    taskPanel.querySelector("#bbts-status").textContent = t("ts_loading");
    taskCourses = [];
    taskPanel.querySelector("#bbts-list").innerHTML = "";
    // 整个学期读取完成后再一次性提交到界面，避免课程逐条跳出和布局抖动。
    const loadedCourses = [];
    for (const course of courses) {
      loadedCourses.push(await loadTaskCourse(course));
      if (seq !== taskSeq) return;
    }
    taskCourses = loadedCourses;
    renderTaskCourses();
    taskPanel.querySelector("#bbts-status").textContent = "";
  }
  function fillTaskMainCourses() {
    const term = taskPanel.querySelector("#bbts-main-term").value;
    const courses = (taskGrouped.find(([tm]) => tm === term) || [null, []])[1];
    taskPanel.querySelector("#bbts-main-course").innerHTML = `<option value="">${esc(t("pick_course"))}</option>` + courses.map(c => `<option value="${esc(c.id)}">${esc(c.short)}</option>`).join("");
    taskPanel.querySelector("#bbts-main-list").innerHTML = `<p class="bbts-message">${esc(t("select_quiz_first"))}</p>`;
  }
  async function scanTaskMainCourse() {
    const courseId = taskPanel.querySelector("#bbts-main-course").value;
    if (!courseId) return;
    const course = taskGrouped.flatMap(([, courses]) => courses).find(c => c.id === courseId);
    const root = taskPanel.querySelector("#bbts-main-list");
    taskPanel.querySelector("#bbts-status").textContent = t("scanning");
    try {
      const quizzes = await scanAssessments(courseId);
      root.innerHTML = "";
      if (!quizzes.length) root.innerHTML = `<p class="bbts-message">${esc(t("ts_empty"))}</p>`;
      for (const quiz of quizzes) {
        const row = document.createElement("div");
        row.className = "bbts-main-row";
        row.innerHTML = `<button type="button" class="bbts-name">${esc(quiz.title)}</button>`;
        row.querySelector("button").onclick = async () => {
          taskPanel.querySelector("#bbts-status").textContent = t("loading");
          await enrichAssessments(courseId, [quiz]);
          showTaskDetail(course, quiz);
          taskPanel.querySelector("#bbts-status").textContent = "";
        };
        root.appendChild(row);
      }
      taskPanel.querySelector("#bbts-status").textContent = t("ts_found", quizzes.length);
    } catch (error) {
      root.innerHTML = `<p class="bbts-message">${esc(t("ts_failed"))}</p>`;
      taskPanel.querySelector("#bbts-status").textContent = t("ts_failed");
    }
  }
  function openTaskManager() {
    taskView = "unfinished";
    taskPanel.querySelector("#bbts-manage-term").value = taskPanel.querySelector("#bbts-main-term").value;
    taskPanel.querySelector("#bbts-main").hidden = true;
    taskPanel.querySelector("#bbts-manage").hidden = false;
    updateTaskManagerControls();
    refreshTaskPanel();
  }
  function closeTaskManager() {
    taskSeq++;
    taskPanel.querySelector("#bbts-manage").hidden = true;
    taskPanel.querySelector("#bbts-main").hidden = false;
    taskPanel.querySelector("#bbts-title").textContent = t("ts_title");
    taskPanel.querySelector("#bbts-status").textContent = "";
  }
  function closeTaskPanelToMain() {
    taskSeq++;
    taskView = "all";
    taskPanel.querySelector("#bbts-manage").hidden = true;
    taskPanel.querySelector("#bbts-main").hidden = false;
    taskPanel.querySelector("#bbts-title").textContent = t("ts_title");
    taskPanel.querySelector("#bbts-status").textContent = "";
    setShellOpen(taskPanel, false);
  }
  function buildTaskPanel() {
    if (taskPanel) return;
    taskPanel = document.createElement("div"); taskPanel.id = TS_PANEL_ID;
    mountShell(taskPanel, { sub:{id:"bbts-sub"}, titleId:"bbts-title", closeId:"bbts-x", bodyHtml:`
      <div id="bbts-main">
        <section class="sec"><h2 id="bbts-main-heading"></h2><div class="row"><label class="fld"><span id="bbts-main-term-label"></span><select id="bbts-main-term"></select></label></div><div class="bbts-main-course-grid"><label class="fld"><span id="bbts-main-course-label"></span><select id="bbts-main-course"></select></label><button class="btn line" id="bbts-main-scan"></button><button class="btn line" id="bbts-open-manage"></button></div></section>
        <section class="sec"><h2 id="bbts-main-results"></h2><div class="bbts-main-head"><span>${t("ts_name")}</span></div><div id="bbts-main-list"></div></section>
      </div>
      <div id="bbts-manage" hidden>
        <section class="sec bbts-controls"><div class="row"><label class="fld"><span id="bbts-term-label"></span><select id="bbts-manage-term"></select></label><button class="btn line" id="bbts-back"></button></div><div class="row bbts-action-row"><button class="btn line" id="bbts-toggle"></button><button class="btn line" id="bbts-batch"></button><button class="btn line" id="bbts-refresh"></button><button class="btn line" id="bbts-history"></button></div></section>
        <div class="bbts-head"><span>${t("ts_name")}</span><span>${t("ts_due")}</span><span>${t("ts_attempts")}</span><span>${t("ts_points")}</span><span>${t("ts_type")}</span></div><div id="bbts-list"></div>
      </div>
      <div class="qz-material-modal" id="bbts-detail" hidden><div class="qz-material-card"><div class="bbts-detail-body"></div><div class="qz-material-actions"><button class="btn line" id="bbts-detail-close">${t("ts_close")}</button></div></div></div>`,
      footerHtml:`<div class="bbtool-status" id="bbts-status"></div><div class="bbtool-actions"><button class="btn sec bbtool-dismiss" data-k="close"></button></div>` });
    if (!document.getElementById("bbts-style")) document.head.appendChild(el("style", {id:"bbts-style"}, `
      .bbts-main-head,.bbts-main-row{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-items:center}.bbts-main-head{padding:10px 14px;border:1px solid var(--line);font-weight:700;color:var(--muted)}.bbts-main-row{min-height:46px;padding:6px 14px;border:1px solid var(--line);border-top:0}
      .bbts-main-course-grid{display:grid;grid-template-columns:minmax(0,1fr) 130px;grid-template-areas:"course scan" ". manage";gap:10px;align-items:end;margin:0 0 18px}.bbts-main-course-grid .fld{grid-area:course;align-self:end}.bbts-main-course-grid #bbts-main-scan{grid-area:scan}.bbts-main-course-grid #bbts-open-manage{grid-area:manage}.bbts-main-course-grid .btn{width:130px}.bbts-action-row{display:flex!important;flex-wrap:nowrap!important;width:100%;gap:6px!important}.bbts-action-row .btn{flex:1 1 0!important;width:0!important;min-width:0!important;padding:0 4px!important;font-size:13px!important}.bbts-action-row #bbts-refresh{flex:.72 1 0!important}.bbts-action-row #bbts-history{flex:1.15 1 0!important}.bbts-action-row #bbts-batch[hidden]{display:none!important}
      #bbts-panel{max-width:1180px}.bbts-head{display:grid;grid-template-columns:minmax(294px,1fr) 145px 100px 90px 75px;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--line);font-weight:700;color:var(--muted)}.bbts-row{display:grid;grid-template-columns:24px minmax(260px,1fr) 145px 100px 90px 75px;align-items:center;gap:10px;min-height:46px;padding:6px 14px;border-top:1px solid var(--line)}.bbts-row-readonly{grid-template-columns:minmax(294px,1fr) 145px 100px 90px 75px}.bbts-course{border:1px solid var(--line);border-top:0}.bbts-course summary{padding:12px 14px;font-weight:700;cursor:pointer}.bbts-course summary span{float:right;color:var(--muted)}.bbts-row>label{display:flex!important;justify-content:center!important;width:24px}.bbts-row>label input{margin:0!important}.bbts-name{min-width:0;padding:0;border:0;background:none;color:var(--fg);font:600 14px/1.4 var(--font);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.bbts-name:hover{text-decoration:underline}.bbts-message{padding:14px 48px;color:var(--muted)}.bbts-detail-body dl{display:grid;grid-template-columns:120px 1fr;gap:10px;margin:18px 0}.bbts-detail-body dt{font-weight:700}.bbts-detail-body dd{margin:0}#bbts-detail{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.42)}#bbts-detail[hidden]{display:none!important}#bbts-detail>.qz-material-card{width:min(560px,100%);padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 18px 55px rgba(0,0,0,.28)}#bbts-detail .qz-material-actions{display:flex;justify-content:flex-end;margin-top:16px}@media(max-width:760px){.bbts-head{display:none}.bbts-row{grid-template-columns:24px minmax(0,1fr)}.bbts-row-readonly{grid-template-columns:minmax(0,1fr)}.bbts-row>span{display:none!important}.bbts-controls .row{flex-wrap:wrap}.bbts-action-row{flex-wrap:nowrap!important}.bbts-main-course-grid{grid-template-columns:minmax(0,1fr) 130px}}`));
    const apply = () => { taskPanel.querySelector("#bbts-sub").textContent=t("ts_sub"); taskPanel.querySelector("#bbts-main-heading").textContent=t("dl_sec_course"); taskPanel.querySelector("#bbts-main-results").textContent=t("ts_title"); taskPanel.querySelector("#bbts-main-term-label").textContent=t("f_term"); taskPanel.querySelector("#bbts-main-course-label").textContent=t("f_course"); taskPanel.querySelector("#bbts-main-scan").textContent=t("scan"); taskPanel.querySelector("#bbts-open-manage").textContent=t("ts_manage"); taskPanel.querySelector("#bbts-term-label").textContent=t("f_term"); taskPanel.querySelector("#bbts-back").textContent=t("close"); taskPanel.querySelector("#bbts-history").textContent=t("ts_completed"); taskPanel.querySelector("#bbts-refresh").textContent=t("ts_refresh"); if(!taskPanel.querySelector("#bbts-manage").hidden) renderTaskCourses(); };
    langHooks.add(apply); apply();
    taskPanel.querySelector("#bbts-back").textContent=t("attach_back");
    langHooks.add(() => { taskPanel.querySelector("#bbts-back").textContent=t("attach_back"); });
    // 管理页内部只切换当前扫描结果；重新请求仅由进入管理页、切换学期或“刷新”触发。
    taskPanel.querySelector("#bbts-history").onclick=()=>{taskView=taskView==="completed"?"unfinished":"completed";renderTaskCourses();};
    taskPanel.querySelector("#bbts-toggle").onclick=()=>{taskView=taskView==="archived"?"unfinished":"archived";renderTaskCourses();};
    taskPanel.querySelector("#bbts-refresh").onclick=refreshTaskPanel;
    taskPanel.querySelector("#bbts-manage-term").onchange=refreshTaskPanel;
    taskPanel.querySelector("#bbts-main-term").onchange=fillTaskMainCourses;
    taskPanel.querySelector("#bbts-main-course").onchange=scanTaskMainCourse;
    taskPanel.querySelector("#bbts-main-scan").onclick=scanTaskMainCourse;
    taskPanel.querySelector("#bbts-open-manage").onclick=openTaskManager;
    taskPanel.querySelector("#bbts-back").onclick=closeTaskManager;
    taskPanel.querySelector("#bbts-batch").onclick=()=>{const set=taskArchive();taskPanel.querySelectorAll("#bbts-list input:checked").forEach(cb=>taskView==="archived"?set.delete(cb.dataset.key):set.add(cb.dataset.key));saveTaskArchive(set);renderTaskCourses();};
    taskPanel.querySelector("#bbts-detail-close").onclick=()=>taskPanel.querySelector("#bbts-detail").hidden=true;
    taskPanel.__close=closeTaskPanelToMain;
    taskPanel._open=async()=>{setShellOpen(taskPanel,true);taskPanel.querySelector("#bbts-main").hidden=false;taskPanel.querySelector("#bbts-manage").hidden=true;taskPanel.querySelector("#bbts-title").textContent=t("ts_title");if(!taskGrouped.length){taskGrouped=groupCourses(await getQuizCourses());const options=taskGrouped.map(([tm])=>`<option value="${esc(tm)}">${esc(tm||t("other"))}</option>`).join("");taskPanel.querySelector("#bbts-main-term").innerHTML=options;taskPanel.querySelector("#bbts-manage-term").innerHTML=options;fillTaskMainCourses();}taskPanel.querySelector("#bbts-status").textContent="";};
  }
  function toggleTaskPanel(){buildTaskPanel();if(taskPanel.classList.contains("open"))taskPanel.__close();else taskPanel._open();}

  // ================================================================ 入口分流
  // @run-at 是 document-start，body / base_tools 还没有，所以 DOM 相关的初始化放到 whenReady 之后。
  if (location.hostname === "vlib.ita.teikyo-u.ac.jp") {
    if (/\/Play\/[0-9a-fA-F]+/.test(location.pathname)) initMediasitePage();
    return;
  }

  // lms2017：登录页认 #user_id + #entry-login，或路径 /webapps/login/
  function onLoginForm() {
    return hasLoginForm() || !!document.getElementById("user_id") || /\/webapps\/login\//.test(location.pathname);
  }

  function boot() {
    if (onLoginForm()) {
      // 登录页：自动登录（各面板的导航此时没有 base_tools，不出现）
      if (location.hash === SETTINGS_HASH) { showGear(); openAuthSettings(); }
      else if (authCfg.enabled) { runLogin(false); }
      else if (!authCfg.user || !authCfg.pass) { showGear(); }
      return;
    }
    // 应用页：試題/作業与答题助手保持为两个独立入口。
    const injectAll = () => { ensureTaskNavItem(); ensureQuizNavItem(); ensureNavItem(); injectAuthNav(); };
    injectAll();
    setInterval(injectAll, 1500);
    if (location.hash === SETTINGS_HASH) openAuthSettings();
  }

  whenReady(boot);
  window.addEventListener("hashchange", () => { if (location.hash === SETTINGS_HASH) openAuthSettings(); });
})();
