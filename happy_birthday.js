(() => {
  'use strict';

  // ============ 設定 ============
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const MODES = [
    { id: 'auto', label: '自動モード', desc: '用途に合わせて最適な形で回答', model: 'gemini-flash-latest' },
    { id: 'fast', label: '高速モード', desc: 'すばやく回答', model: 'gemini-flash-lite-latest' },
    { id: 'pro', label: '思考モード', desc: '複雑な問題をじっくり考えて回答', model: 'gemini-pro-latest' },
  ];
  // 混雑・上限エラーのときに順番に試すモデル
  const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
  const RETRYABLE = new Set([429, 500, 503, 504]);

  // ============ ストレージ（失敗しても動くように） ============
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量不足など */ } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };

  // ============ 状態 ============
  let apiKey = store.get('hb_apikey', '');
  let customModel = store.get('hb_custom_model', '');
  let modeId = store.get('hb_mode', 'auto');
  let chats = store.get('hb_chats', []);
  let currentId = null;
  let pendingFiles = [];
  let controller = null;
  let pinnedOnly = false;
  let searchQuery = '';

  if (!Array.isArray(chats)) chats = [];
  // 以前の版で入れていたダミーのチャット（中身なし）を掃除
  if (chats.some(c => String(c.id).startsWith('seed') && !c.messages.length)) {
    chats = chats.filter(c => !(String(c.id).startsWith('seed') && !c.messages.length));
    saveChats();
  }

  // ============ DOM ============
  const $ = (id) => document.getElementById(id);
  const app = $('app'), main = $('main'), threadEl = $('thread'), threadInner = $('threadInner');
  const promptEl = $('prompt'), actionBtn = $('actionBtn'), actionIcon = $('actionIcon');
  const chatListEl = $('chatList'), modelMenu = $('modelMenu'), popMenu = $('popMenu');

  const SPARK_SVG = '<svg class="spark" viewBox="0 0 24 24"><use href="#spark-path" fill="#3186ff"/><use href="#spark-path" fill="url(#g-red)"/><use href="#spark-path" fill="url(#g-yellow)"/><use href="#spark-path" fill="url(#g-green)"/></svg>';

  function saveChats() {
    // 画像データは重いので保存時は外す
    const slim = chats.map(c => ({
      ...c,
      messages: c.messages.map(m => ({ role: m.role, text: m.text, files: (m.files || []).map(f => ({ name: f.name, mime: f.mime })) })),
    }));
    store.set('hb_chats', slim);
  }
  const curChat = () => chats.find(c => c.id === currentId) || null;
  const curMode = () => MODES.find(m => m.id === modeId) || MODES[0];
  const curModel = () => (customModel || '').trim() || curMode().model;

  // ============ トースト ============
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ============ サイドバー ============
  function renderChatList() {
    chatListEl.innerHTML = '';
    let list = [...chats].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    if (pinnedOnly) list = list.filter(c => c.pinned);
    if (searchQuery) list = list.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()));
    if (!list.length) {
      if (pinnedOnly || searchQuery) chatListEl.innerHTML = '<div class="chat-empty">該当するチャットがありません</div>';
      return;
    }
    list.forEach(c => {
      const el = document.createElement('div');
      el.className = 'chat-item' + (c.id === currentId ? ' active' : '');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = '<span class="title"></span>' +
        (c.pinned ? '<span class="ms pin">keep</span>' : '') +
        '<button class="more" title="その他"><span class="ms">more_vert</span></button>';
      el.querySelector('.title').textContent = c.title;
      el.onclick = (e) => {
        if (e.target.closest('.more')) return;
        openChat(c.id);
      };
      el.onkeydown = (e) => { if (e.key === 'Enter') openChat(c.id); };
      el.querySelector('.more').onclick = (e) => {
        e.stopPropagation();
        el.classList.add('menu-open');
        showChatMenu(c, e.currentTarget, () => el.classList.remove('menu-open'));
      };
      chatListEl.appendChild(el);
    });
  }

  function updateNavActive() {
    $('newChatBtn').classList.toggle('active', !currentId);
  }

  // ============ メニュー共通 ============
  let menuCleanup = null;
  function openMenu(menuEl, anchor, items, opts = {}) {
    closeMenus();
    menuEl.innerHTML = '';
    items.forEach(it => {
      if (it.head) {
        const h = document.createElement('div');
        h.className = 'menu-head'; h.textContent = it.head;
        menuEl.appendChild(h); return;
      }
      const b = document.createElement('button');
      b.className = 'menu-item ' + (it.cls || '');
      b.innerHTML = it.html || `<span class="ms">${it.icon}</span><span></span>`;
      if (!it.html) b.lastChild.textContent = it.label;
      b.onclick = () => { closeMenus(); it.action(); };
      menuEl.appendChild(b);
    });
    menuEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    let left = opts.alignRight ? r.right - mw : r.left;
    let top = opts.above ? r.top - mh - 8 : r.bottom + 6;
    if (top + mh > innerHeight - 8) top = r.top - mh - 6;
    if (top < 8) top = 8;
    left = Math.max(8, Math.min(left, innerWidth - mw - 8));
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
    menuCleanup = opts.onClose || null;
  }
  function closeMenus() {
    modelMenu.hidden = true; popMenu.hidden = true;
    if (menuCleanup) { const f = menuCleanup; menuCleanup = null; f(); }
  }
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('#modelBtn') && !e.target.closest('.more') && !e.target.closest('#chatMenuBtn')) closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  function showChatMenu(c, anchor, onClose) {
    openMenu(popMenu, anchor, [
      { icon: 'keep', label: c.pinned ? '固定を解除' : '固定', action: () => { c.pinned = !c.pinned; saveChats(); renderChatList(); } },
      { icon: 'edit', label: '名前を変更', action: () => renameChat(c) },
      { icon: 'delete', label: '削除', cls: 'danger', action: () => deleteChat(c) },
    ], { onClose });
  }
  function renameChat(c) {
    const t = prompt('新しい名前', c.title);
    if (t && t.trim()) { c.title = t.trim(); saveChats(); renderChatList(); }
  }
  function deleteChat(c) {
    if (!confirm(`「${c.title}」を削除しますか？`)) return;
    chats = chats.filter(x => x.id !== c.id);
    saveChats();
    if (currentId === c.id) newChat(); else renderChatList();
  }

  // ============ モデル選択 ============
  function renderModelLabel() {
    $('modelMode').textContent = customModel ? customModel : curMode().label;
  }
  $('modelBtn').onclick = (e) => {
    if (!modelMenu.hidden) { closeMenus(); return; }
    const items = [{ head: 'モードを選択' }];
    MODES.forEach(m => items.push({
      cls: 'model-item',
      html: `<span><span class="mlabel"></span><span class="sub"></span></span>${m.id === modeId && !customModel ? '<span class="ms check-ic">check_circle</span>' : ''}`,
      action: () => { modeId = m.id; customModel = ''; store.set('hb_mode', modeId); store.del('hb_custom_model'); renderModelLabel(); },
    }));
    openMenu(modelMenu, e.currentTarget, items, { above: main.classList.contains('is-chat'), alignRight: true });
    // テキストは textContent で入れる
    const btns = modelMenu.querySelectorAll('.model-item');
    MODES.forEach((m, i) => {
      btns[i].querySelector('.mlabel').textContent = m.label;
      btns[i].querySelector('.sub').textContent = `${m.desc}（${m.model}）`;
    });
  };

  // ============ 画面切り替え ============
  function setView(home) {
    main.classList.toggle('is-home', home);
    main.classList.toggle('is-chat', !home);
  }

  function newChat() {
    abortStream();
    currentId = null;
    threadInner.innerHTML = '';
    setView(true);
    renderChatList();
    updateNavActive();
    document.title = 'Gemini';
    closeMobile();
    promptEl.focus();
  }

  function openChat(id) {
    abortStream();
    const c = chats.find(x => x.id === id);
    if (!c) return;
    currentId = id;
    threadInner.innerHTML = '';
    if (!c.messages.length) {
      setView(true);
    } else {
      setView(false);
      c.messages.forEach((m, i) => {
        if (m.role === 'user') appendUser(m);
        else appendModel(m.text, i);
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }
    document.title = c.title + ' - Gemini';
    renderChatList();
    updateNavActive();
    closeMobile();
  }

  // ============ メッセージ描画 ============
  function md(text) {
    if (window.marked && window.DOMPurify) {
      return DOMPurify.sanitize(marked.parse(text, { breaks: false, gfm: true }), { ADD_ATTR: ['target'] });
    }
    const d = document.createElement('div'); d.textContent = text;
    return d.innerHTML.replace(/\n/g, '<br>');
  }

  function appendUser(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-user';
    if (m.files && m.files.length) {
      const imgs = document.createElement('div');
      imgs.className = 'user-imgs';
      m.files.forEach(f => {
        if (f.data && f.mime.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = `data:${f.mime};base64,${f.data}`;
          imgs.appendChild(img);
        } else {
          const s = document.createElement('div');
          s.className = 'file';
          s.innerHTML = '<span class="ms">description</span><span></span>';
          s.lastChild.textContent = f.name || 'ファイル';
          imgs.appendChild(s);
        }
      });
      wrap.appendChild(imgs);
    }
    if (m.text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = m.text;
      wrap.appendChild(b);
    }
    threadInner.appendChild(wrap);
    return wrap;
  }

  function appendModel(text, index) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-model';
    wrap.innerHTML = '<div class="content"></div>' +
      '<div class="msg-actions">' +
      '<button class="icon-btn" data-act="up" title="良い回答"><span class="ms">thumb_up</span></button>' +
      '<button class="icon-btn" data-act="down" title="悪い回答"><span class="ms">thumb_down</span></button>' +
      '<button class="icon-btn" data-act="redo" title="再生成"><span class="ms">refresh</span></button>' +
      '<button class="icon-btn" data-act="copy" title="コピー"><span class="ms">content_copy</span></button>' +
      '<button class="icon-btn" data-act="more" title="その他"><span class="ms">more_horiz</span></button>' +
      '</div>';
    if (text != null) wrap.querySelector('.content').innerHTML = md(text);
    wrap.dataset.index = index;
    bindActions(wrap);
    threadInner.appendChild(wrap);
    return wrap;
  }

  function bindActions(wrap) {
    wrap.querySelectorAll('.msg-actions .icon-btn').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        const c = curChat();
        const idx = +wrap.dataset.index;
        const text = c && c.messages[idx] ? c.messages[idx].text : wrap.querySelector('.content').innerText;
        if (act === 'up' || act === 'down') {
          const other = wrap.querySelector(`[data-act="${act === 'up' ? 'down' : 'up'}"] .ms`);
          other.classList.remove('fill');
          const on = btn.querySelector('.ms').classList.toggle('fill');
          if (on) toast('フィードバックをありがとうございます');
        } else if (act === 'copy') {
          copyText(text);
        } else if (act === 'redo') {
          regenerate(idx);
        } else if (act === 'more') {
          openMenu(popMenu, btn, [
            { icon: 'content_copy', label: 'Markdown でコピー', action: () => copyText(text) },
            { icon: 'volume_up', label: '読み上げ', action: () => speak(wrap.querySelector('.content').innerText) },
          ]);
        }
      };
    });
  }

  function copyText(t) {
    const done = () => toast('クリップボードにコピーしました');
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
    else fallbackCopy(t, done);
  }
  function fallbackCopy(t, done) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('コピーできませんでした'); }
    ta.remove();
  }
  function speak(t) {
    if (!('speechSynthesis' in window)) return toast('このブラウザは読み上げに非対応です');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'ja-JP';
    speechSynthesis.speak(u);
  }

  // ============ 送信 ============
  function updateActionBtn() {
    actionBtn.classList.remove('send', 'stop', 'listening');
    if (controller) {
      actionIcon.textContent = 'stop'; actionBtn.classList.add('stop'); actionBtn.title = '停止';
    } else if (recognizing) {
      actionIcon.textContent = 'mic'; actionBtn.classList.add('listening'); actionBtn.title = '音声入力を停止';
    } else if (promptEl.value.trim() || pendingFiles.length) {
      actionIcon.textContent = 'send'; actionBtn.classList.add('send'); actionBtn.title = '送信';
    } else {
      actionIcon.textContent = 'mic'; actionBtn.title = 'マイク';
    }
  }

  function autosize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, 220) + 'px';
  }
  promptEl.addEventListener('input', () => { autosize(); updateActionBtn(); });
  promptEl.addEventListener('keydown', (e) => {
    // 日本語変換中の Enter は送信しない
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

  actionBtn.onclick = () => {
    if (controller) return abortStream();
    if (recognizing) return stopListening();
    if (promptEl.value.trim() || pendingFiles.length) return send();
    startListening();
  };

  function send() {
    if (controller) return;
    const text = promptEl.value.trim();
    if (!text && !pendingFiles.length) return;
    if (!apiKey) { showKeyModal(); return; }

    let c = curChat();
    if (!c) {
      c = { id: 'c' + Date.now(), title: (text || '画像について').slice(0, 24), pinned: false, messages: [], updated: Date.now(), fresh: true };
      chats.unshift(c);
      currentId = c.id;
    }
    const msg = { role: 'user', text, files: pendingFiles.slice() };
    c.messages.push(msg);
    c.updated = Date.now();
    pendingFiles = [];
    renderAttachments();
    promptEl.value = '';
    autosize();

    if (main.classList.contains('is-home')) { threadInner.innerHTML = ''; setView(false); }
    if (!threadInner.children.length && c.messages.length > 1) {
      // 空表示から既存チャットに戻ってきたとき
      c.messages.slice(0, -1).forEach((m, i) => m.role === 'user' ? appendUser(m) : appendModel(m.text, i));
    }
    const userEl = appendUser(msg);
    saveChats();
    renderChatList();
    updateNavActive();
    document.title = c.title + ' - Gemini';
    generate(c, userEl);
  }

  function regenerate(idx) {
    if (controller) return;
    const c = curChat();
    if (!c) return;
    // 指定した回答以降を捨てて、直前のユーザー発言から作り直す
    c.messages = c.messages.slice(0, idx);
    const nodes = [...threadInner.children];
    nodes.slice(idx).forEach(n => n.remove());
    saveChats();
    generate(c, threadInner.lastElementChild);
  }

  async function generate(c, anchorEl) {
    const index = c.messages.length;
    const wrap = appendModel(null, index);
    wrap.classList.add('streaming');
    const content = wrap.querySelector('.content');
    content.innerHTML = `<div class="thinking">${SPARK_SVG}<span>${curMode().id === 'pro' && !customModel ? '思考中…' : '考え中…'}</span></div>`;
    if (anchorEl) threadEl.scrollTop = anchorEl.offsetTop - 16;

    controller = new AbortController();
    updateActionBtn();

    const contents = c.messages.map(m => {
      const parts = [];
      (m.files || []).forEach(f => { if (f.data) parts.push({ inline_data: { mime_type: f.mime, data: f.data } }); });
      if (m.text) parts.push({ text: m.text });
      if (!parts.length) parts.push({ text: '（添付ファイル）' });
      return { role: m.role === 'user' ? 'user' : 'model', parts };
    });

    let full = '';
    let rafPending = false;
    const paint = () => {
      rafPending = false;
      content.innerHTML = md(full);
      content.lastElementChild && content.lastElementChild.classList.add('cursor-dot');
      const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 160;
      if (nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
    };

    const setStatus = (msg) => {
      if (full) return;
      content.innerHTML = `<div class="thinking">${SPARK_SVG}<span></span></div>`;
      content.querySelector('.thinking span').textContent = msg;
    };

    // 1回分のストリーミング。途中で文字が出た後のエラーはそのまま投げる
    const streamOnce = async (model) => {
      const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents }),
        signal: controller.signal,
      });
      if (!res.ok) throw await apiError(res, model);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let data;
          try { data = JSON.parse(json); } catch { continue; }
          if (data.error) {
            const e = new Error(data.error.message || 'エラーが発生しました');
            e.status = data.error.code;
            e.retryable = RETRYABLE.has(data.error.code);
            throw e;
          }
          const cand = data.candidates && data.candidates[0];
          const parts = cand && cand.content && cand.content.parts || [];
          parts.forEach(p => { if (p.text && !p.thought) full += p.text; });
          if (data.promptFeedback && data.promptFeedback.blockReason && !full) {
            full = 'このリクエストにはお答えできません。（' + data.promptFeedback.blockReason + '）';
          }
          if (!rafPending && full) { rafPending = true; requestAnimationFrame(paint); }
        }
      }
    };

    // 混雑時は少し待って再試行 → それでもダメなら別モデルへ
    const first = curModel();
    const models = [first, ...FALLBACK_MODELS.filter(m => m !== first)];
    const plan = [];
    models.forEach((m, i) => { plan.push({ model: m, wait: 0 }); if (i === 0) plan.push({ model: m, wait: 1500 }); });

    let usedModel = first;
    let errLink = null;
    try {
      let lastErr;
      for (const step of plan) {
        if (step.model !== first) setStatus(`混雑中のため ${step.model} で再試行しています…`);
        else if (step.wait) setStatus('混雑しているので再試行しています…');
        if (step.wait) await sleep(step.wait, controller.signal);
        try {
          usedModel = step.model;
          await streamOnce(step.model);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // 中断・文字が出た後・再試行しても意味がないエラーはここで終わり
          if (err.name === 'AbortError' || full || !(err.retryable || (err.status === 404 && step.model !== first))) throw err;
        }
      }
      if (lastErr) throw lastErr;
      if (!full) full = '（回答がありませんでした）';
      if (usedModel !== first) toast(`混雑していたため ${usedModel} で回答しました`);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!full) full = '回答を停止しました。';
      } else {
        content.classList.add('error');
        let m = err.message || String(err);
        if (err.retryable) m = 'どのモデルも混雑していて回答できませんでした。少し時間をおいて再試行してください。\n\n' + m;
        full = (full ? full + '\n\n' : '') + '⚠️ ' + m;
        errLink = err.keyProblem ? 'key' : 'retry';
      }
    }

    controller = null;
    content.innerHTML = md(full);
    if (errLink) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = errLink === 'key' ? 'API キーを入力し直す' : 'もう一度試す';
      a.onclick = (e) => {
        e.preventDefault();
        if (errLink === 'key') return showKeyModal(true);
        if (controller) return;
        wrap.remove();
        generate(c, threadInner.lastElementChild);
      };
      const para = document.createElement('p');
      para.appendChild(a);
      content.appendChild(para);
    }
    wrap.classList.remove('streaming');
    if (!content.classList.contains('error')) {
      c.messages.push({ role: 'model', text: full });
      c.updated = Date.now();
      saveChats();
      if (c.fresh) { delete c.fresh; makeTitle(c); }
    } else {
      // エラーは履歴に残さない（次の送信で再挑戦できるように）
      wrap.querySelector('.msg-actions').style.display = 'none';
    }
    updateActionBtn();
  }

  async function apiError(res, model) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { }
    const e = new Error(msg);
    e.status = res.status;
    e.retryable = RETRYABLE.has(res.status);
    if (res.status === 400 && /api key/i.test(msg)) e.keyProblem = true;
    if (res.status === 401 || res.status === 403) e.keyProblem = true;
    if (res.status === 404) e.message = `モデル「${model}」が見つかりませんでした。設定（歯車）の詳細設定でモデル ID を指定してください。\n\n${msg}`;
    return e;
  }

  function sleep(ms, signal) {
    return new Promise((ok, ng) => {
      const t = setTimeout(ok, ms);
      signal && signal.addEventListener('abort', () => { clearTimeout(t); ng(new DOMException('aborted', 'AbortError')); }, { once: true });
    });
  }

  function abortStream() { if (controller) controller.abort(); }

  async function makeTitle(c) {
    const first = c.messages[0];
    try {
      const res = await fetch(`${API_BASE}/models/${encodeURIComponent(curModel())}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `次の質問に、会話一覧に表示する短いタイトルを付けてください。質問と同じ言語で、20文字以内、記号や引用符なし、タイトルのみを出力。\n\n質問: ${first.text || '画像について'}` }] }],
        }),
      });
      if (!res.ok) return;
      const j = await res.json();
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [];
      const t = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim().replace(/^["「『]|["」』]$/g, '').split('\n')[0];
      if (t) {
        c.title = t.slice(0, 40);
        saveChats();
        renderChatList();
        if (c.id === currentId) document.title = c.title + ' - Gemini';
      }
    } catch { /* タイトルは失敗しても気にしない */ }
  }

  // ============ 添付 ============
  $('addBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async (e) => {
    for (const f of e.target.files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} は大きすぎます（15MB まで）`); continue; }
      const data = await new Promise((ok, ng) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1]);
        r.onerror = ng;
        r.readAsDataURL(f);
      });
      pendingFiles.push({ name: f.name, mime: f.type || 'application/octet-stream', data });
    }
    e.target.value = '';
    renderAttachments();
    updateActionBtn();
    promptEl.focus();
  };
  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'att';
      if (f.mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = `data:${f.mime};base64,${f.data}`;
        d.appendChild(img);
      } else {
        d.textContent = f.name.slice(0, 10);
      }
      const x = document.createElement('button');
      x.innerHTML = '<span class="ms">close</span>';
      x.onclick = () => { pendingFiles.splice(i, 1); renderAttachments(); updateActionBtn(); };
      d.appendChild(x);
      box.appendChild(d);
    });
  }

  // ============ 音声入力 ============
  let recognizing = false, recog = null;
  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('このブラウザは音声入力に対応していません');
    recog = new SR();
    recog.lang = 'ja-JP';
    recog.interimResults = true;
    const base = promptEl.value;
    recog.onresult = (ev) => {
      let t = '';
      for (const r of ev.results) t += r[0].transcript;
      promptEl.value = base + t;
      autosize();
    };
    recog.onend = () => { recognizing = false; updateActionBtn(); };
    recog.onerror = () => { recognizing = false; updateActionBtn(); };
    recog.start();
    recognizing = true;
    updateActionBtn();
  }
  function stopListening() { if (recog) recog.stop(); }

  // ============ API キー モーダル ============
  const keyModal = $('keyModal'), keyInput = $('keyInput'), keyErr = $('keyErr');
  function showKeyModal(cancellable) {
    keyInput.value = apiKey || '';
    $('customModel').value = customModel || '';
    $('rememberKey').checked = !!store.get('hb_apikey', '');
    $('keyCancel').hidden = !cancellable;
    keyErr.textContent = '';
    keyModal.hidden = false;
    setTimeout(() => keyInput.focus(), 50);
  }
  $('eyeBtn').onclick = () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    $('eyeBtn').querySelector('.ms').textContent = show ? 'visibility_off' : 'visibility';
  };
  $('keyCancel').onclick = () => { keyModal.hidden = true; };
  $('keyForm').onsubmit = async (e) => {
    e.preventDefault();
    const k = keyInput.value.trim();
    if (!k) { keyErr.textContent = 'API キーを入力してください。'; return; }
    const btn = $('keySubmit');
    btn.disabled = true; btn.textContent = '確認中…';
    keyErr.textContent = '';
    try {
      const res = await fetch(`${API_BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': k } });
      if (!res.ok) {
        let m = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j.error && j.error.message) m = j.error.message; } catch { }
        throw new Error(m);
      }
      apiKey = k;
      customModel = $('customModel').value.trim();
      if (customModel) store.set('hb_custom_model', customModel); else store.del('hb_custom_model');
      if ($('rememberKey').checked) store.set('hb_apikey', k); else store.del('hb_apikey');
      renderModelLabel();
      keyModal.hidden = true;
      promptEl.focus();
    } catch (err) {
      keyErr.textContent = 'キーを確認できませんでした：' + (err.message || err);
    } finally {
      btn.disabled = false; btn.textContent = '開始';
    }
  };

  // ============ その他のボタン ============
  $('newChatBtn').onclick = newChat;
  $('brandLink').onclick = (e) => { e.preventDefault(); newChat(); };
  document.querySelectorAll('[data-soon]').forEach(b => {
    b.onclick = () => toast(`「${b.dataset.soon}」はこの擬似 Gemini では使えません`);
  });
  $('upgradeBtn').onclick = () => toast('擬似 Gemini なのでアップグレードはありません');
  $('downloadBtn').onclick = () => toast('アプリはありません。ブラウザで我慢してください');
  $('tempChatBtn').onclick = () => toast('一時チャットは未対応です');
  $('settingsBtn').onclick = () => showKeyModal(true);
  $('userBtn').onclick = (e) => openMenu(popMenu, e.currentTarget, [
    { icon: 'key', label: 'API キーを変更', action: () => showKeyModal(true) },
    { icon: 'delete_sweep', label: 'すべてのチャットを削除', cls: 'danger', action: () => {
      if (!confirm('すべてのチャットを削除しますか？')) return;
      chats = []; saveChats(); newChat();
    } },
    { icon: 'logout', label: 'キーを消して終了', action: () => { store.del('hb_apikey'); apiKey = ''; showKeyModal(false); } },
  ], { above: true });
  $('chatMenuBtn').onclick = (e) => {
    const c = curChat();
    if (!c) return;
    showChatMenu(c, e.currentTarget);
    // 右上メニューは右寄せ
    const r = e.currentTarget.getBoundingClientRect();
    popMenu.style.left = Math.max(8, r.right - popMenu.offsetWidth) + 'px';
  };

  $('collapseBtn').onclick = () => {
    if (innerWidth <= 900) { closeMobile(); return; }
    app.classList.toggle('collapsed');
    store.set('hb_collapsed', app.classList.contains('collapsed'));
  };
  $('menuBtn').onclick = () => app.classList.add('mobile-open');
  $('scrim').onclick = closeMobile;
  function closeMobile() { app.classList.remove('mobile-open'); }

  $('searchBtn').onclick = () => {
    const box = $('sbSearch');
    box.hidden = !box.hidden;
    if (!box.hidden) $('searchInput').focus();
    else { searchQuery = ''; $('searchInput').value = ''; renderChatList(); }
  };
  $('searchInput').oninput = (e) => { searchQuery = e.target.value; renderChatList(); };
  $('filterBtn').onclick = () => {
    pinnedOnly = !pinnedOnly;
    $('filterBtn').querySelector('.ms').classList.toggle('fill', pinnedOnly);
    toast(pinnedOnly ? '固定したチャットのみ表示' : 'すべてのチャットを表示');
    renderChatList();
  };

  // ============ 起動 ============
  if (store.get('hb_collapsed', false) && innerWidth > 900) app.classList.add('collapsed');
  renderChatList();
  renderModelLabel();
  updateNavActive();
  updateActionBtn();
  if (apiKey) keyModal.hidden = true; else showKeyModal(false);
})();
