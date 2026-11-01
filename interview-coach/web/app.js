(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const TYPE_LABEL = {
    self_intro: '自我介绍',
    resume: '经历深挖',
    case: '案例',
    scenario: '场景题',
    behavior: '行为面',
  };

  const state = {
    sid: null,
    plan: null,
    ws: null,
    startedAt: 0,
    timerId: null,
    connectTimer: null,
    micWatch: null,
    sessionReady: false,
    duration: 0,
    ending: false,
    sending: false,
    muted: false,
    view: 'setup',
    viewBeforeMethods: 'setup',
    outlines: null,
    cueIndex: 0,
    cueHidden: false,
  };

  /* ============================================================
   * 音频：采集 -> 16k PCM，播放 <- 24k PCM
   * ============================================================ */

  const AudioCtl = {
    micCtx: null,
    playCtx: null,
    stream: null,
    source: null,
    node: null,
    analyser: null,
    _analyserBuf: null,
    gain: null,
    sources: new Set(),
    nextTime: 0,
    level: 0,
    speaking: false,
    muted: false,
    onFrame: null,
    meterPeak: 0,

    /**
     * 必须在点击事件里「同步」调用（任何 await 之前）。
     * Chrome / Safari 的自动播放策略要求 AudioContext 在用户手势内创建并 resume，
     * 原来的写法是等 getUserMedia 授权弹窗结束后才 new AudioContext，此时手势已失效，
     * Safari 下 context 会一直停在 suspended，worklet 和分析器都拿不到任何数据。
     */
    unlock() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!this.micCtx || this.micCtx.state === 'closed') this.micCtx = new Ctx();
      if (!this.playCtx || this.playCtx.state === 'closed') this.playCtx = new Ctx();
      this.micCtx.resume().catch(() => {});
      this.playCtx.resume().catch(() => {});
    },

    async init(onFrame) {
      this.onFrame = onFrame;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('当前页面无法使用麦克风'), { name: 'InsecureError' });
      }

      this.unlock();

      this.stream = await requestMic({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      await this.micCtx.audioWorklet.addModule('/static/audio-worklet.js');

      const source = this.micCtx.createMediaStreamSource(this.stream);
      this.source = source;
      this.node = new AudioWorkletNode(this.micCtx, 'mic-processor');
      source.connect(this.node);

      // 旁路分析：直接看麦克风原始信号，用来区分「采不到」还是「编码坏了」
      this.analyser = this.micCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this._analyserBuf = new Float32Array(this.analyser.fftSize);

      // 必须有一条通向 destination 的链路，worklet 才会被持续驱动；音量为 0 避免自听
      const silent = this.micCtx.createGain();
      silent.gain.value = 0;
      this.node.connect(silent).connect(this.micCtx.destination);

      this.node.port.onmessage = (event) => {
        const data = event.data || {};
        this.level = data.level || 0;
        if (data.pcm && this.onFrame) this.onFrame(data.pcm);
      };

      this.gain = this.playCtx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.playCtx.destination);
    },

    // resume 在没有用户手势时可能永远不 resolve，这里加超时，避免整个流程卡死在「等待麦克风授权」
    async resume() {
      const tryResume = (ctx) => {
        if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return Promise.resolve();
        return Promise.race([
          ctx.resume().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      };
      await Promise.all([tryResume(this.micCtx), tryResume(this.playCtx)]);
    },

    suspended() {
      return [this.micCtx, this.playCtx].some((ctx) => ctx && ctx.state === 'suspended');
    },

    // 带峰值保持的音量（0-1，按 dB 映射）。原来直接用瞬时峰值 × 160，
    // 正常说话音量只占 1-5%，4px 高的条几乎看不出来动
    meter() {
      const raw = this.rawPeak();
      this.meterPeak = Math.max(raw, this.meterPeak * 0.92);
      const db = 20 * Math.log10(this.meterPeak + 1e-6);
      return { raw, peak: this.meterPeak, db, ratio: Math.max(0, Math.min(1, (db + 60) / 54)) };
    },

    setMuted(value) {
      this.muted = value;
      if (this.node) this.node.port.postMessage({ type: 'mute', value });
    },

    play(bytes) {
      if (!this.playCtx || !bytes || bytes.byteLength < 2) return;
      const count = Math.floor(bytes.byteLength / 2);
      const samples = new Float32Array(count);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count; i++) {
        samples[i] = view.getInt16(i * 2, true) / 32768;
      }

      const buffer = this.playCtx.createBuffer(1, count, 24000);
      buffer.copyToChannel(samples, 0);

      const source = this.playCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);

      const now = this.playCtx.currentTime;
      if (this.nextTime < now + 0.04) this.nextTime = now + 0.08;
      source.start(this.nextTime);
      this.nextTime += buffer.duration;

      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    },

    flush() {
      this.sources.forEach((source) => {
        try { source.stop(); } catch (_) { /* ignore */ }
      });
      this.sources.clear();
      this.nextTime = 0;
    },

    stopMic() {
      if (this.source) {
        try { this.source.disconnect(); } catch (_) { /* ignore */ }
      }
      if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
      if (this.node) {
        try { this.node.disconnect(); } catch (_) { /* ignore */ }
      }
      this.stream = null;
      this.source = null;
      this.node = null;
    },

    // 切换输入设备：Chrome 有时默认选中了不出声的设备（虚拟声卡/耳机麦）
    async switchInput(deviceId) {
      const stream = await requestMic({
        audio: {
          deviceId: { exact: deviceId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (this.source) {
        try { this.source.disconnect(); } catch (_) { /* ignore */ }
      }
      if (this.stream) this.stream.getTracks().forEach((track) => track.stop());

      this.stream = stream;
      if (!this.micCtx || !this.node) return stream;

      this.source = this.micCtx.createMediaStreamSource(stream);
      this.source.connect(this.node);
      if (this.analyser) this.source.connect(this.analyser);
      await this.resume();
      return stream;
    },

    deviceLabel() {
      const track = this.stream && this.stream.getAudioTracks()[0];
      return (track && track.label) || '未知设备';
    },

    // 麦克风原始信号峰值（不经过 worklet 重采样）
    rawPeak() {
      if (!this.analyser || !this._analyserBuf) return 0;
      this.analyser.getFloatTimeDomainData(this._analyserBuf);
      let peak = 0;
      for (let i = 0; i < this._analyserBuf.length; i++) {
        const v = Math.abs(this._analyserBuf[i]);
        if (v > peak) peak = v;
      }
      return peak;
    },

    stopAll() {
      this.flush();
      this.stopMic();
      [this.micCtx, this.playCtx].forEach((ctx) => {
        if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
      });
      this.micCtx = null;
      this.playCtx = null;
      this.analyser = null;
      this._analyserBuf = null;
      this.level = 0;
      this.meterPeak = 0;
    },
  };

  /* ============================================================
   * 视图与状态
   * ============================================================ */

  function showView(name) {
    state.view = name;
    ['setup', 'plan', 'live', 'report', 'methods'].forEach((view) => {
      $(`#view-${view}`).classList.toggle('hidden', view !== name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setStatus(text, kind) {
    const pill = $('#statusPill');
    pill.className = `pill${kind ? ' ' + kind : ''}`;
    pill.querySelector('span').textContent = text;
  }

  function setLiveState(text) {
    $('#liveState').textContent = text;
  }

  function formatTime(seconds) {
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  async function requestMic(constraints, timeoutMs = 12000) {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        if (status.state === 'denied') {
          throw Object.assign(new Error('麦克风权限已被拒绝'), { name: 'NotAllowedError' });
        }
      } catch (err) {
        if (err && err.name === 'NotAllowedError') throw err;
      }
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('等待麦克风授权超时'), { name: 'TimeoutError' }));
      }, timeoutMs);
    });
    return Promise.race([navigator.mediaDevices.getUserMedia(constraints), timeout]).finally(
      () => clearTimeout(timer)
    );
  }

  function micErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝。点地址栏左侧的图标，把麦克风改为「允许」，再点开始。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有检测到麦克风设备，请接入麦克风后重试。';
    }
    if (name === 'NotReadableError') {
      return '麦克风被其他应用占用，请关闭占用麦克风的应用后重试。';
    }
    if (name === 'TimeoutError') {
      return '等待麦克风授权超时。请查看浏览器是否有弹出的授权提示，允许后再试。';
    }
    if (name === 'InsecureError') {
      return '当前地址无法使用麦克风。请用 http://127.0.0.1:8000 打开（局域网 IP 需要 HTTPS）。';
    }
    return (err && err.message) || '麦克风初始化失败';
  }

  function startTimer() {
    state.startedAt = Date.now();
    state.timerId = setInterval(() => {
      state.duration = Math.floor((Date.now() - state.startedAt) / 1000);
      $('#timer').textContent = formatTime(state.duration);
    }, 500);
  }

  // 上送一直是静音时给出明确提示，避免用户以为「说了没反应」
  function startMicWatch() {
    clearInterval(state.micWatch);
    const begin = Date.now();
    let peak = 0;
    state.micWatch = setInterval(() => {
      peak = Math.max(peak, AudioCtl.rawPeak(), AudioCtl.level);
      if (peak > 0.01) {
        clearInterval(state.micWatch);
        state.micWatch = null;
        return;
      }
      if (Date.now() - begin > 8000 && !state.muted) {
        clearInterval(state.micWatch);
        state.micWatch = null;
        setLiveState('没有检测到麦克风声音');
        $('#stageTip').textContent =
          '音量条一直是 0：试试右下角下拉切换麦克风设备，或检查系统「声音 → 输入」选的是哪个麦克风';
      }
    }, 400);
  }

  function stopMicWatch() {
    if (state.micWatch) clearInterval(state.micWatch);
    state.micWatch = null;
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  /* ============================================================
   * 步骤 1：设置
   * ============================================================ */

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const voice = $('#voiceStatus');
      const brain = $('#brainStatus');

      voice.textContent = data.voice_ready ? '已就绪' : '未配置 Key';
      voice.className = data.voice_ready ? 'ok' : 'bad';
      brain.textContent = data.brain_ready ? data.brain_model : '未配置 Key';
      brain.className = data.brain_ready ? 'ok' : 'bad';

      if (!data.voice_ready || !data.brain_ready) {
        $('#envNotice').insertAdjacentHTML(
          'beforeend',
          `<p class="tip" style="margin-top:12px;color:#e4c28c">${
            data.voice_ready
              ? '缺少 BRAIN_API_KEY，仍可语音面试，但不会有个性化方案和深度报告。'
              : '缺少 VOLC_API_KEY，暂时无法开始语音面试。请先在 .env 中配置。'
          }</p>`
        );
      }
    } catch (err) {
      console.warn('health check failed', err);
    }
  }

  async function preparePlan() {
    const btn = $('#btnPrepare');
    const errorBox = $('#setupError');
    errorBox.textContent = '';

    const payload = {
      role: $('#role').value.trim() || '大模型内容安全运营',
      level: $('#level').value,
      company: $('#company').value.trim(),
      jd: $('#jd').value.trim(),
      resume: $('#resume').value.trim(),
      materials: $('#materials').value.trim(),
    };

    if (!payload.jd && !payload.resume && !payload.materials) {
      errorBox.textContent = '至少提供 JD、简历或工作素材其中一项，否则问题会很泛。';
      return;
    }

    btn.disabled = true;
    btn.querySelector('span').textContent = '正在读材料、设计问题…';

    try {
      const res = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '生成失败');

      state.sid = data.session_id;
      state.plan = data.plan;
      renderPlan(data);
      showView('plan');
      setStatus('方案已生成', '');
    } catch (err) {
      errorBox.textContent = `生成失败：${err.message}`;
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = '生成面试方案';
    }
  }

  function renderPlan(data) {
    const plan = data.plan || {};
    const profile = plan.candidate_profile || {};

    const roleName = $('#role').value.trim() || '大模型内容安全运营';
    const companyName = $('#company').value.trim();
    $('#planTitle').textContent = companyName ? `${roleName} · ${companyName}` : roleName;

    $('#planSummary').textContent = profile.summary || '暂无画像信息。';

    const tags = [];
    (profile.strengths || []).forEach((s) => tags.push(`<span class="tag good">${esc(s)}</span>`));
    (plan.focus_areas || []).forEach((s) => tags.push(`<span class="tag focus">${esc(s)}</span>`));
    (profile.risks || []).forEach((s) => tags.push(`<span class="tag risk">疑点 · ${esc(s)}</span>`));
    $('#planTags').innerHTML = tags.join('') || '<span class="tag">暂无</span>';

    $('#focusTags').innerHTML = (plan.focus_areas || [])
      .map((s) => `<span class="tag focus">${esc(s)}</span>`)
      .join('') || '<span class="tag">暂无</span>';

    const questions = plan.questions || [];
    $('#questionCount').textContent = `${questions.length} 题`;
    $('#questionList').innerHTML = questions
      .map(
        (q, index) => `
        <li>
          <div class="q-index">${String(q.id || index + 1).padStart(2, '0')}</div>
          <div>
            <div class="q-text"><span class="q-type">${esc(TYPE_LABEL[q.type] || '问题')}</span>${esc(q.question)}</div>
            ${q.intent ? `<div class="q-meta">考察：${esc(q.intent)}</div>` : ''}
            <div class="outline-slot" data-qid="${esc(q.id ?? index + 1)}"><div class="outline-loading">正在整理答题框架…</div></div>
          </div>
        </li>`
      )
      .join('');

    state.outlines = null;
    loadOutlines(false);

    const warning = $('#prepWarning');
    if (data.warning) {
      warning.textContent = data.warning;
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }

    if (!data.voice_ready) {
      $('#btnStart').disabled = true;
      $('#btnStart').textContent = '缺少语音 Key';
    } else {
      $('#btnStart').disabled = false;
      $('#btnStart').textContent = '开始语音面试';
    }
  }

  async function uploadResume(file) {
    const form = new FormData();
    form.append('file', file);
    $('#fileName').textContent = '解析中…';
    try {
      const res = await fetch('/api/extract', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '解析失败');
      $('#resume').value = data.text;
      $('#fileName').textContent = `${file.name} · ${data.text.length} 字`;
    } catch (err) {
      $('#fileName').textContent = `解析失败：${err.message}`;
    }
  }

  /* ============================================================
   * 答题框架（每道题：结构 + 你的素材 + 口诀）
   * ============================================================ */

  async function loadOutlines(refresh) {
    if (!state.sid) return;
    const sid = state.sid;
    const status = $('#outlineStatus');
    const warning = $('#outlineWarning');
    $('#btnRegenOutlines').disabled = true;
    $('#btnDownloadCards').disabled = true;
    status.textContent = '生成中，约 20-40 秒…';
    warning.classList.add('hidden');
    if (refresh) {
      document.querySelectorAll('.outline-slot').forEach((slot) => {
        slot.innerHTML = '<div class="outline-loading">正在重新整理答题框架…</div>';
      });
    }

    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sid)}/outlines${refresh ? '?refresh=true' : ''}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '生成失败');
      if (state.sid !== sid) return; // 用户已经换了一场
      state.outlines = data.items || [];
      renderOutlines();
      status.textContent = '';
      if (data.warning) {
        warning.textContent = data.warning;
        warning.classList.remove('hidden');
      }
    } catch (err) {
      if (state.sid !== sid) return;
      status.textContent = '';
      warning.textContent = `答题框架生成失败：${err.message}`;
      warning.classList.remove('hidden');
      document.querySelectorAll('.outline-slot').forEach((slot) => { slot.innerHTML = ''; });
    } finally {
      if (state.sid === sid) {
        $('#btnRegenOutlines').disabled = false;
        $('#btnDownloadCards').disabled = !(state.outlines && state.outlines.length);
      }
    }
  }

  function outlineFor(qid) {
    return (state.outlines || []).find((o) => String(o.id) === String(qid));
  }

  function renderOutlines() {
    document.querySelectorAll('.outline-slot').forEach((slot, index) => {
      const outline = outlineFor(slot.dataset.qid);
      slot.innerHTML = outline ? renderOutline(outline, index === 0) : '';
    });
    renderCue();
  }

  function renderOutline(o, open) {
    const steps = (o.steps || [])
      .map(
        (step, i) => `
        <li>
          <span class="ol-step-no">${i + 1}</span>
          <div><b>${esc(step.label)}</b>${
            step.points
              ? `<span class="${step.points.startsWith('需要你补充') ? 'ol-need' : ''}">${esc(step.points)}</span>`
              : '<span class="ol-need">填上你自己的经历或数据</span>'
          }</div>
        </li>`
      )
      .join('');
    const chips = (list, cls) => (list || []).map((k) => `<span class="tag ${cls}">${esc(k)}</span>`).join('');

    return `
      <details class="outline-card" ${open ? 'open' : ''}>
        <summary>
          <span class="ol-fw">${esc(o.framework || '答题框架')}</span>
          ${o.mnemonic ? `<span class="ol-mnemonic">${esc(o.mnemonic)}</span>` : ''}
          ${o.why ? `<span class="ol-why">${esc(o.why)}</span>` : ''}
        </summary>
        <div class="ol-body">
          ${o.material ? `<div class="ol-line"><em>用哪段素材</em>${esc(o.material)}</div>` : ''}
          ${o.opening_line ? `<div class="ol-line"><em>第一句</em>「${esc(o.opening_line)}」</div>` : ''}
          <ol class="ol-steps">${steps}</ol>
          ${(o.keywords || []).length ? `<div class="ol-line"><em>关键词</em><span class="tag-row">${chips(o.keywords, 'focus')}</span></div>` : ''}
          ${(o.numbers || []).length ? `<div class="ol-line"><em>数字锚点</em><span class="tag-row">${chips(o.numbers, 'good')}</span></div>` : ''}
          ${o.short_version ? `<div class="ol-line"><em>30 秒版</em>${esc(o.short_version)}</div>` : ''}
          ${(o.gaps || []).length ? `<div class="ol-gaps"><em>需要你补充</em><ul>${o.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </details>`;
  }

  function cardsMarkdown() {
    const questions = (state.plan && state.plan.questions) || [];
    const lines = [`# 答题卡 · ${$('#planTitle').textContent}`, ''];
    questions.forEach((q, index) => {
      const o = outlineFor(q.id ?? index + 1);
      lines.push(`## ${index + 1}. ${q.question}`, '');
      if (!o) { lines.push('（未生成）', ''); return; }
      lines.push(`- 框架：${o.framework}${o.mnemonic ? `（口诀：${o.mnemonic}）` : ''}`);
      if (o.material) lines.push(`- 素材：${o.material}`);
      if (o.opening_line) lines.push(`- 第一句：${o.opening_line}`);
      if ((o.numbers || []).length) lines.push(`- 数字锚点：${o.numbers.join(' / ')}`);
      if ((o.keywords || []).length) lines.push(`- 关键词：${o.keywords.join(' / ')}`);
      lines.push('');
      (o.steps || []).forEach((s, i) => lines.push(`${i + 1}. **${s.label}**：${s.points || '（待补充）'}`));
      if (o.short_version) lines.push('', `> 30 秒版：${o.short_version}`);
      if ((o.gaps || []).length) {
        lines.push('', '需要补充：');
        o.gaps.forEach((g) => lines.push(`- [ ] ${g}`));
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------------- 面试中的提词卡 ---------------- */

  function renderCue() {
    const card = $('#cueCard');
    const questions = (state.plan && state.plan.questions) || [];
    if (!questions.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    state.cueIndex = Math.max(0, Math.min(questions.length - 1, state.cueIndex));
    const q = questions[state.cueIndex];
    const o = outlineFor(q.id ?? state.cueIndex + 1);

    $('#cueIdx').textContent = `${state.cueIndex + 1} / ${questions.length}`;
    $('#cueToggle').textContent = state.cueHidden ? '显示' : '隐藏';
    card.classList.toggle('collapsed', state.cueHidden);

    if (state.cueHidden) {
      $('#cueBody').innerHTML = '';
      return;
    }
    const steps = o ? (o.steps || []).map((s) => `<span class="cue-step">${esc(s.label)}</span>`).join('<i>→</i>') : '';
    $('#cueBody').innerHTML = `
      <div class="cue-q">${esc(q.question)}</div>
      ${o ? `
        <div class="cue-mnemonic">${esc(o.mnemonic || o.framework)}</div>
        <div class="cue-steps">${steps}</div>
        ${(o.keywords || []).length ? `<div class="cue-keys">${o.keywords.map(esc).join(' · ')}</div>` : ''}
        ${(o.numbers || []).length ? `<div class="cue-nums">${o.numbers.map(esc).join(' · ')}</div>` : ''}
      ` : '<div class="muted">答题框架还没生成好</div>'}`;
  }

  function moveCue(delta) {
    state.cueIndex += delta;
    renderCue();
  }

  /* ---------------- 方法论编辑 ---------------- */

  async function openMethods() {
    if (state.view === 'live') return; // 面试中不切走，避免打断语音
    if (state.view !== 'methods') state.viewBeforeMethods = state.view;
    showView('methods');
    await loadMethods();
  }

  async function loadMethods() {
    $('#methodsError').textContent = '';
    $('#methodsStatus').textContent = '读取中…';
    try {
      const res = await fetch('/api/methods');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '读取失败');
      $('#methodsText').value = data.text || '';
      renderMethodsPreview(data.frameworks || []);
      $('#methodsStatus').textContent = '';
    } catch (err) {
      $('#methodsStatus').textContent = '';
      $('#methodsError').textContent = `读取失败：${err.message}`;
    }
  }

  async function saveMethods() {
    const btn = $('#btnSaveMethods');
    btn.disabled = true;
    $('#methodsError').textContent = '';
    $('#methodsStatus').textContent = '保存中…';
    try {
      const res = await fetch('/api/methods', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: $('#methodsText').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '保存失败');
      renderMethodsPreview(data.frameworks || []);
      $('#methodsStatus').textContent = state.sid
        ? '已保存。回到方案页点「重新生成」即可按新方法论整理答题框架。'
        : '已保存。';
    } catch (err) {
      $('#methodsStatus').textContent = '';
      $('#methodsError').textContent = `保存失败：${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderMethodsPreview(frameworks) {
    $('#methodsPreview').innerHTML =
      frameworks
        .map(
          (fw) => `
        <div class="fw-item">
          <div class="fw-head"><b>${esc(fw.name)}</b>${fw.mnemonic ? `<span class="ol-mnemonic">${esc(fw.mnemonic)}</span>` : ''}</div>
          <div class="cue-steps">${fw.steps.map((s) => `<span class="cue-step">${esc(s)}</span>`).join('<i>→</i>')}</div>
          <div class="q-meta">适用：${fw.types.map((t) => esc(TYPE_LABEL[t] || t)).join('、') || '未指定（作为兜底）'}${fw.duration ? ` · ${esc(fw.duration)}` : ''}</div>
        </div>`
        )
        .join('') || '<p class="hint">还没有识别出框架。</p>';
  }

  /* ============================================================
   * 步骤 2：实时语音面试
   * ============================================================ */

  function resetTranscript() {
    $('#messages').innerHTML = '<div class="empty-hint">对话开始后，字幕会出现在这里。</div>';
    $('#liveCaption').textContent = '';
    $('#liveCaption').classList.remove('show');
    $('#turnCount').textContent = '0 轮';
    $('#btnRetry').classList.add('hidden');
    pendingBubble.candidate = null;
    pendingBubble.interviewer = null;
    localTranscript = [];
    assistantBuf = '';
    state.sessionReady = false;
    stopMicWatch();
    turnCount = 0;
  }

  let turnCount = 0;
  let localTranscript = [];
  let assistantBuf = '';
  const pendingBubble = { candidate: null, interviewer: null };

  function messagesEl() {
    return $('#messages');
  }

  function scrollMessages() {
    const el = messagesEl();
    el.scrollTop = el.scrollHeight;
  }

  function upsertBubble(role, text) {
    const el = messagesEl();
    const empty = el.querySelector('.empty-hint');
    if (empty) empty.remove();

    let wrap = pendingBubble[role];
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = `msg ${role} pending`;
      wrap.innerHTML = `<div class="who">${role === 'candidate' ? '你' : '面试官'}</div><div class="bubble"></div>`;
      el.appendChild(wrap);
      pendingBubble[role] = wrap;
    }
    wrap.querySelector('.bubble').textContent = text;
    scrollMessages();
    showCaption(role, text);
  }

  function finalizeBubble(role, text) {
    const wrap = pendingBubble[role];
    if (!wrap) {
      if (!text) return;
      upsertBubble(role, text);
    }
    const node = pendingBubble[role];
    if (node) {
      const finalText = text || node.querySelector('.bubble').textContent;
      if (text) node.querySelector('.bubble').textContent = text;
      node.classList.remove('pending');
      pendingBubble[role] = null;
      if (finalText.trim()) localTranscript.push({ role, text: finalText.trim() });
      turnCount += 1;
      $('#turnCount').textContent = `${turnCount} 轮`;
    }
    scrollMessages();
  }

  function showCaption(role, text) {
    const caption = $('#liveCaption');
    const short = text.length > 110 ? text.slice(0, 110) + '…' : text;
    caption.textContent = short;
    caption.classList.add('show');
    if (role === 'candidate') {
      setLiveState('正在听你说');
    }
  }

  function showLiveError(message) {
    setStatus('连接失败', '');
    setLiveState(message);
    $('#btnRetry').classList.remove('hidden');
  }

  function connectSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?sid=${encodeURIComponent(state.sid)}`);
    state.ws = ws;
    state.sessionReady = false;

    ws.onopen = () => {
      setStatus('建立连接', 'busy');
      setLiveState('正在连接面试官…');
      clearTimeout(state.connectTimer);
      state.connectTimer = setTimeout(() => {
        if (!state.sessionReady) {
          showLiveError('连接超时。请检查后端日志，或点「重新连接」。');
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      let evt;
      try { evt = JSON.parse(event.data); } catch (_) { return; }
      handleEvent(evt);
    };

    ws.onerror = () => {
      if (!state.ending) showLiveError('连接出错，请检查后端是否在运行。');
    };

    ws.onclose = () => {
      state.sending = false;
      clearTimeout(state.connectTimer);
      if (!state.ending) {
        showLiveError(state.sessionReady ? '连接已断开，请点「重新连接」。' : '无法连接到后端语音服务，请重试。');
      }
    };
  }

  function handleEvent(evt) {
    const type = evt.type || '';

    if (type === 'local.error') {
      showLiveError(evt.message || '发生错误');
      return;
    }

    switch (type) {
      case 'session.created': {
        state.sessionReady = true;
        clearTimeout(state.connectTimer);
        $('#btnRetry').classList.add('hidden');
        state.sending = true;
        setStatus('面试中', 'live');
        setLiveState('面试官正在开口…');
        $('#stageTip').textContent = '请开始你的自我介绍';
        startTimer();
        startMicWatch();
        // 开场白由后端直接合成语音，不会产生 text 事件，这里按方案补一条字幕
        const opening = state.plan && state.plan.opening;
        if (opening) {
          upsertBubble('interviewer', opening);
          finalizeBubble('interviewer', opening);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.started':
        AudioCtl.flush();
        assistantBuf = '';
        setLiveState('正在听你说');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        // ASR 返回的是累积文本，直接覆盖
        upsertBubble('candidate', pickText(evt, 'delta', 'text', 'transcript'));
        break;

      case 'conversation.item.input_audio_transcription.completed':
        finalizeBubble('candidate', pickText(evt, 'transcript', 'text'));
        break;

      case 'response.output_text.delta':
        // 模型回复的 text delta 是增量片段，需要累积
        assistantBuf += pickText(evt, 'delta', 'text');
        upsertBubble('interviewer', assistantBuf);
        break;

      case 'response.output_text.done':
        finalizeBubble('interviewer', pickText(evt, 'text') || assistantBuf);
        assistantBuf = '';
        break;

      case 'response.output_audio.started':
        AudioCtl.speaking = true;
        setLiveState('面试官正在说话');
        break;

      case 'response.output_audio.delta': {
        const b64 = evt.delta || evt.audio;
        if (b64) AudioCtl.play(base64ToBytes(b64));
        break;
      }

      case 'response.output_audio.done':
        AudioCtl.speaking = false;
        setLiveState('轮到你说了');
        break;

      case 'error':
        console.warn('realtime error', evt);
        setLiveState(evt.message || '模型返回错误，请查看控制台');
        break;

      case 'session.closed':
        state.sending = false;
        break;

      default:
        break;
    }
  }

  function pickText(evt, ...keys) {
    for (const key of keys) {
      const value = evt[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function sendJson(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    }
  }

  async function initAudio() {
    try {
      await AudioCtl.init((pcm) => {
        if (!state.sending || state.muted) return;
        sendJson({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcm) });
      });
      await AudioCtl.resume();
      await populateMicSelect();
      return true;
    } catch (err) {
      console.warn('audio init failed', err);
      AudioCtl.stopAll();
      showView('plan');
      const warning = $('#prepWarning');
      warning.textContent = micErrorMessage(err);
      warning.classList.remove('hidden');
      setStatus('未开始', '');
      $('#btnStart').disabled = false;
      return false;
    }
  }

  async function populateMicSelect() {
    const select = $('#micSelect');
    if (!select || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput'
      );
      if (devices.length < 2) {
        select.classList.add('hidden');
        return;
      }
      const track = AudioCtl.stream && AudioCtl.stream.getAudioTracks()[0];
      const current = track && track.getSettings ? track.getSettings().deviceId : '';
      select.innerHTML = devices
        .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `麦克风 ${i + 1}`)}</option>`)
        .join('');
      if (current) select.value = current;
      select.classList.remove('hidden');
    } catch (err) {
      console.warn('enumerateDevices failed', err);
    }
  }

  async function switchMic(deviceId) {
    try {
      const stream = await AudioCtl.switchInput(deviceId);
      const label = (stream.getAudioTracks()[0] || {}).label || '';
      setLiveState(`已切换到 ${label || '新设备'}`);
      startMicWatch();
    } catch (err) {
      setLiveState(micErrorMessage(err));
    }
  }

  async function startInterview() {
    const btn = $('#btnStart');
    if (!state.sid) return;
    btn.disabled = true;
    AudioCtl.unlock(); // 必须在第一个 await 之前
    state.cueIndex = 0;

    showView('live');
    resetTranscript();
    renderCue();
    setStatus('准备中', 'busy');
    setLiveState('等待麦克风授权…');
    $('#stageTip').textContent = '浏览器如弹出麦克风授权，请点「允许」';

    if (!(await initAudio())) return;

    state.ending = false;
    connectSocket();
    startOrb();
  }

  async function retryConnection() {
    if (state.ws) {
      try { state.ws.close(); } catch (_) { /* ignore */ }
      state.ws = null;
    }
    clearTimeout(state.connectTimer);
    AudioCtl.stopAll();
    AudioCtl.unlock(); // 必须在第一个 await 之前
    $('#btnRetry').classList.add('hidden');

    showView('live');
    resetTranscript();
    renderCue();
    setStatus('准备中', 'busy');
    setLiveState('等待麦克风授权…');
    $('#stageTip').textContent = '浏览器如弹出麦克风授权，请点「允许」';

    if (!(await initAudio())) return;

    state.ending = false;
    connectSocket();
    startOrb();
  }

  function toggleMic() {
    state.muted = !state.muted;
    AudioCtl.setMuted(state.muted);
    $('#btnMic').classList.toggle('muted', state.muted);
    $('#micLabel').textContent = state.muted ? '取消静音' : '静音';
    sendJson({ type: state.muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
    if (state.muted) setLiveState('麦克风已静音');
  }

  async function endInterview() {
    if (state.ending) return;
    state.ending = true;
    state.sending = false;
    state.sessionReady = false;
    clearTimeout(state.connectTimer);

    stopTimer();
    stopMicWatch();
    setStatus('生成报告中', 'busy');
    setLiveState('面试结束');
    AudioCtl.flush();
    AudioCtl.stopMic();

    sendJson({ type: 'input_audio_mute.commit' });
    sendJson({ type: 'session.close' });
    setTimeout(() => {
      if (state.ws) {
        try { state.ws.close(); } catch (_) { /* ignore */ }
      }
    }, 500);

    showView('report');
    $('#reportBody').classList.add('hidden');
    $('#reportLoading').classList.remove('hidden');

    try {
      const res = await fetch(`/api/session/${state.sid}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_sec: state.duration, transcript: localTranscript }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '生成失败');
      renderReportResult(data);
    } catch (err) {
      renderReportError(err.message);
    }
  }

  /* ============================================================
   * 步骤 3：报告
   * ============================================================ */

  function renderReportResult(data) {
    $('#reportLoading').classList.add('hidden');
    const body = $('#reportBody');
    body.classList.remove('hidden');

    if (data.warning) {
      body.innerHTML = `
        <div class="notice">${esc(data.warning)}</div>
        <div class="card report-card">
          <div class="card-title">本次对话记录</div>
          ${renderTranscript(data.transcript || [])}
        </div>
        <div class="report-actions">
          <button class="ghost" id="btnAgain">再来一场</button>
        </div>`;
      bindAgain();
      return;
    }

    body.innerHTML = renderReport(data.report || {});
    bindAgain();
    setStatus('已完成', '');
  }

  function renderReport(report) {
    const overall = report.overall || {};
    const dims = report.dimensions || [];
    const questions = report.questions || [];
    const gaps = report.top_gaps || [];
    const nextSteps = report.next_steps || [];
    const followups = report.likely_followups || [];

    const score = Number(overall.score) || 0;

    const dimsHtml = dims
      .map((dim) => {
        const has = dim.score !== null && dim.score !== undefined && dim.score !== '';
        const value = has ? Math.max(0, Math.min(10, Number(dim.score) || 0)) : 0;
        const level = value >= 8 ? 'high' : value >= 6 ? 'mid' : 'low';
        return `
          <div class="dim">
            <div class="dim-head"><span>${esc(dim.name || dim.key)}</span><b>${has ? value.toFixed(1) + ' / 10' : '未评估'}</b></div>
            <div class="bar"><i class="${level}" style="width:${has ? value * 10 : 0}%"></i></div>
            ${dim.comment ? `<div class="dim-comment">${esc(dim.comment)}</div>` : ''}
          </div>`;
      })
      .join('');

    const questionsHtml = questions
      .map((q, index) => {
        const value = Math.max(0, Math.min(10, Number(q.score) || 0));
        const level = value >= 8 ? 'high' : value >= 6 ? '' : 'low';
        return `
          <details class="qcard" ${index === 0 ? 'open' : ''}>
            <summary>
              <div class="qscore ${level}">${value.toFixed(0)}</div>
              <div class="qtitle">${esc(q.question)}<em>${esc(q.answer_summary || '')}</em></div>
            </summary>
            <div class="qbody">
              ${q.what_went_well ? `<h4>做对了什么</h4><p>${esc(q.what_went_well)}</p>` : ''}
              ${q.what_to_improve ? `<h4>问题在哪</h4><p>${esc(q.what_to_improve)}</p>` : ''}
              ${q.framework || q.structure_check ? `<h4>结构对照${q.framework ? ` · ${esc(q.framework)}` : ''}</h4><p>${esc(q.structure_check || '')}</p>` : ''}
              ${q.better_answer ? `<h4>可以这样说${q.framework ? '（按这个结构）' : ''}</h4><div class="better">${esc(q.better_answer)}</div>` : ''}
            </div>
          </details>`;
      })
      .join('');

    const gapsHtml = gaps
      .map(
        (gap) => `
        <div class="gap-item">
          <div class="g-issue">${esc(gap.issue)}</div>
          <div class="g-why">${esc(gap.why_it_matters)}</div>
          <div class="g-fix">→ ${esc(gap.fix)}</div>
        </div>`
      )
      .join('');

    return `
      <div class="card report-hero">
        <div class="score-block">
          <div class="score-num">${score}<small>/100</small></div>
          <div class="score-label">综合评分</div>
          <div class="verdict-badge">${esc(overall.level || '待评估')}</div>
        </div>
        <div>
          <h2>${esc(overall.verdict || '')}</h2>
          <p>${esc(overall.summary || '')}</p>
        </div>
      </div>

      <div class="report-grid">
        <div class="card report-card">
          <div class="card-title">维度评分</div>
          ${dimsHtml || '<p class="hint">暂无维度数据</p>'}
        </div>
        <div class="card report-card">
          <div class="card-title">最致命的问题</div>
          ${gapsHtml || '<p class="hint">暂无</p>'}
        </div>
      </div>

      <div class="card report-card" style="margin-bottom:22px">
        <div class="card-title">逐题复盘 · 点开看改写示范</div>
        ${questionsHtml || '<p class="hint">暂无逐题数据</p>'}
      </div>

      <div class="report-grid">
        <div class="card report-card">
          <div class="card-title">下一步练习</div>
          <ul class="list-plain">${nextSteps.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>暂无</li>'}</ul>
        </div>
        <div class="card report-card">
          <div class="card-title">下一轮可能被追问</div>
          <ul class="list-plain">${followups.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>暂无</li>'}</ul>
        </div>
      </div>

      <div class="report-actions">
        <button class="ghost" id="btnDownload">下载 Markdown</button>
        <button class="primary" id="btnAgain">再来一场</button>
      </div>`;
  }

  function renderTranscript(items) {
    return `<div class="messages" style="height:auto;max-height:420px;padding:0">
      ${items
        .map(
          (item) => `
        <div class="msg ${item.role}">
          <div class="who">${item.role === 'candidate' ? '你' : '面试官'}</div>
          <div class="bubble">${esc(item.text)}</div>
        </div>`
        )
        .join('')}
    </div>`;
  }

  function renderReportError(message) {
    $('#reportLoading').classList.add('hidden');
    const body = $('#reportBody');
    body.classList.remove('hidden');
    body.innerHTML = `
      <div class="notice">生成报告失败：${esc(message)}</div>
      <div class="report-actions">
        <button class="ghost" id="btnAgain">回到开始</button>
      </div>`;
    bindAgain();
  }

  function bindAgain() {
    const again = $('#btnAgain');
    if (again) again.onclick = resetToSetup;
    const download = $('#btnDownload');
    if (download) download.onclick = downloadMarkdown;
  }

  async function downloadMarkdown() {
    try {
      const res = await fetch(`/api/session/${state.sid}`);
      const session = await res.json();
      const report = session.report || {};
      downloadText(toMarkdown(report), `面试复盘-${state.sid}.md`);
    } catch (err) {
      console.warn(err);
    }
  }

  function toMarkdown(report) {
    const lines = [];
    const overall = report.overall || {};
    lines.push('# 面试复盘报告', '');
    lines.push(`- 综合评分：${overall.score ?? '-'} / 100`);
    lines.push(`- 结论：${overall.level || '-'}`, '');
    if (overall.summary) lines.push(overall.summary, '');

    lines.push('## 维度评分', '');
    (report.dimensions || []).forEach((dim) => {
      lines.push(`### ${dim.name || dim.key} · ${dim.score ?? '-'}/10`);
      if (dim.comment) lines.push(dim.comment);
      if (dim.evidence) lines.push(`> 证据：${dim.evidence}`);
      lines.push('');
    });

    lines.push('## 逐题复盘', '');
    (report.questions || []).forEach((q) => {
      lines.push(`### ${q.question}（${q.score}/10）`);
      if (q.answer_summary) lines.push(`- 回答要点：${q.answer_summary}`);
      if (q.what_went_well) lines.push(`- 做对了：${q.what_went_well}`);
      if (q.what_to_improve) lines.push(`- 问题：${q.what_to_improve}`);
      if (q.framework) lines.push(`- 建议结构：${q.framework}`);
      if (q.structure_check) lines.push(`- 结构对照：${q.structure_check}`);
      if (q.better_answer) lines.push(`- 可以这样说：${q.better_answer}`);
      lines.push('');
    });

    lines.push('## 最致命的问题', '');
    (report.top_gaps || []).forEach((gap) => {
      lines.push(`### ${gap.issue}`, gap.why_it_matters || '', `→ ${gap.fix || ''}`, '');
    });

    lines.push('## 下一步练习', '');
    (report.next_steps || []).forEach((s) => lines.push(`- ${s}`));

    lines.push('', '## 下一轮可能被追问', '');
    (report.likely_followups || []).forEach((s) => lines.push(`- ${s}`));

    return lines.join('\n');
  }

  function resetToSetup() {
    if (state.ws) {
      try { state.ws.close(); } catch (_) { /* ignore */ }
      state.ws = null;
    }
    AudioCtl.stopAll();
    stopTimer();
    stopMicWatch();
    clearTimeout(state.connectTimer);
    state.sid = null;
    state.outlines = null;
    state.cueIndex = 0;
    state.ending = false;
    state.sessionReady = false;
    state.duration = 0;
    state.sending = false;
    state.muted = false;
    $('#timer').textContent = '00:00';
    $('#liveCaption').textContent = '';
    $('#liveCaption').classList.remove('show');
    $('#reportBody').innerHTML = '';
    $('#btnMic').classList.remove('muted');
    $('#micLabel').textContent = '静音';
    setStatus('未开始', '');
    showView('setup');
  }

  /* ============================================================
   * 声波球
   * ============================================================ */

  const canvas = $('#orb');
  const ctx2d = canvas.getContext('2d');
  let phase = 0;
  let orbRunning = false;
  let lastDebugAt = 0;

  function startOrb() {
    if (orbRunning) return;
    orbRunning = true;
    requestAnimationFrame(drawOrb);
  }

  // 任何一次点击都尝试恢复被浏览器挂起的音频（Safari / 切后台后常见）
  document.addEventListener('click', () => {
    if (AudioCtl.suspended()) AudioCtl.resume();
  });

  function drawOrb() {
    if ($('#view-live').classList.contains('hidden')) {
      orbRunning = false;
      return;
    }

    const w = canvas.width;
    const cx = w / 2;
    const m = AudioCtl.meter();
    // 你说话时用麦克风音量驱动声波球，面试官说话时保持原来的效果
    const level = Math.min(1, Math.max(AudioCtl.level * 7, m.ratio * 0.8) + (AudioCtl.speaking ? 0.16 : 0));
    const speaking = AudioCtl.speaking;

    const bar = $('#micBar');
    if (bar) bar.style.width = `${Math.round(m.ratio * 100)}%`;

    const now = performance.now();
    const dbg = $('#micDebug');
    if (dbg && now - lastDebugAt > 250) {
      lastDebugAt = now;
      const ctxState = AudioCtl.micCtx ? AudioCtl.micCtx.state : '无';
      const selectShown = !$('#micSelect').classList.contains('hidden');
      dbg.textContent = `${m.db.toFixed(0)} dB · ${ctxState}${selectShown ? '' : ` · ${AudioCtl.deviceLabel()}`}`;
      dbg.title = `worklet ${AudioCtl.level.toFixed(3)} / 原始峰值 ${m.peak.toFixed(3)}`;
      if (AudioCtl.suspended()) {
        setLiveState('浏览器暂停了音频，点一下页面任意位置恢复');
      }
    }

    ctx2d.clearRect(0, 0, w, w);
    phase += 0.02;

    // 外圈呼吸
    for (let ring = 3; ring >= 1; ring--) {
      const radius = w * 0.17 + ring * 26 + Math.sin(phase * 1.1 - ring * 0.7) * 7 + level * 26 * (4 - ring) / 3;
      ctx2d.beginPath();
      ctx2d.arc(cx, cx, radius, 0, Math.PI * 2);
      ctx2d.strokeStyle = `rgba(245, 185, 98, ${0.05 + ring * 0.035})`;
      ctx2d.lineWidth = 1.1;
      ctx2d.stroke();
    }

    // 核心光晕
    const halo = ctx2d.createRadialGradient(cx, cx, w * 0.01, cx, cx, w * 0.3);
    const alpha = speaking ? 0.34 : 0.2;
    halo.addColorStop(0, `rgba(255, 214, 156, ${alpha + level * 0.18})`);
    halo.addColorStop(0.55, `rgba(245, 168, 60, ${alpha * 0.42})`);
    halo.addColorStop(1, 'rgba(245, 168, 60, 0)');
    ctx2d.fillStyle = halo;
    ctx2d.beginPath();
    ctx2d.arc(cx, cx, w * 0.3, 0, Math.PI * 2);
    ctx2d.fill();

    // 径向声波条
    const bars = 84;
    const baseRadius = w * 0.155;
    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2 + phase * 0.12;
      const wave = Math.sin(phase * 2.4 + i * 0.55) * 0.5 + 0.5;
      const len = 6 + wave * 8 + level * 74 * (0.45 + wave * 0.55);
      const x1 = cx + Math.cos(angle) * baseRadius;
      const y1 = cx + Math.sin(angle) * baseRadius;
      const x2 = cx + Math.cos(angle) * (baseRadius + len);
      const y2 = cx + Math.sin(angle) * (baseRadius + len);

      ctx2d.beginPath();
      ctx2d.moveTo(x1, y1);
      ctx2d.lineTo(x2, y2);
      ctx2d.strokeStyle = speaking
        ? `rgba(245, 185, 98, ${0.28 + wave * 0.4})`
        : `rgba(95, 227, 200, ${0.18 + wave * 0.32})`;
      ctx2d.lineWidth = 2;
      ctx2d.lineCap = 'round';
      ctx2d.stroke();
    }

    // 中心点
    ctx2d.beginPath();
    ctx2d.arc(cx, cx, w * 0.045 + level * 10, 0, Math.PI * 2);
    ctx2d.fillStyle = 'rgba(255, 236, 205, 0.95)';
    ctx2d.fill();

    requestAnimationFrame(drawOrb);
  }

  /* ============================================================
   * 绑定
   * ============================================================ */

  async function bootFromUrl() {
    const sid = new URLSearchParams(location.search).get('session');
    if (!sid) return;
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const session = await res.json();
      if (!session.report) return;

      state.sid = session.id;
      state.duration = session.duration_sec || 0;
      $('#timer').textContent = formatTime(state.duration);
      $('#reportLoading').classList.add('hidden');
      const body = $('#reportBody');
      body.classList.remove('hidden');
      body.innerHTML = renderReport(session.report);
      bindAgain();
      showView('report');
      setStatus('已完成', '');
    } catch (err) {
      console.warn('load session failed', err);
    }
  }

  $('#btnPrepare').addEventListener('click', preparePlan);
  $('#btnStart').addEventListener('click', startInterview);
  $('#btnEnd').addEventListener('click', endInterview);
  $('#btnMic').addEventListener('click', toggleMic);
  $('#btnRetry').addEventListener('click', retryConnection);
  $('#micSelect').addEventListener('change', (event) => switchMic(event.target.value));
  $('#btnBackSetup').addEventListener('click', () => showView('setup'));
  $('#btnOpenMethods').addEventListener('click', openMethods);
  $('#btnCloseMethods').addEventListener('click', () => showView(state.viewBeforeMethods || 'setup'));
  $('#btnSaveMethods').addEventListener('click', saveMethods);
  $('#btnReloadMethods').addEventListener('click', loadMethods);
  $('#btnRegenOutlines').addEventListener('click', () => loadOutlines(true));
  $('#btnDownloadCards').addEventListener('click', () => downloadText(cardsMarkdown(), `答题卡-${state.sid}.md`));
  $('#cuePrev').addEventListener('click', () => moveCue(-1));
  $('#cueNext').addEventListener('click', () => moveCue(1));
  $('#cueToggle').addEventListener('click', () => {
    state.cueHidden = !state.cueHidden;
    renderCue();
  });
  document.addEventListener('keydown', (event) => {
    if (state.view !== 'live') return;
    const tag = (event.target && event.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (event.key === 'ArrowLeft') moveCue(-1);
    if (event.key === 'ArrowRight') moveCue(1);
  });
  $('#btnFile').addEventListener('click', () => $('#resumeFile').click());
  $('#resumeFile').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) uploadResume(file);
  });

  window.addEventListener('beforeunload', () => {
    if (state.ws) state.ws.close();
    AudioCtl.stopAll();
  });

  checkHealth();
  bootFromUrl();
})();
