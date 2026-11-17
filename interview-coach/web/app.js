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
    // 你说完、面试官还没开口的那段时间，「大头」显示思考
    thinking: false,
    thinkingSince: 0,
    duration: 0,
    ending: false,
    sending: false,
    muted: false,
    view: 'setup',
    viewBeforeMethods: 'setup',
    outlines: null,
    cueIndex: 0,
    cueHidden: false,
    // 'interview' 面试官 / 'coach' 教练
    mode: 'interview',
    // 当前教练练习：{ id, brief, question, answer, qid, source, transcript, ended }
    coach: null,
    // true = 从方案页/报告页单独练一题；false = 面试中途叫教练
    coachOnly: false,
    coachReturnView: 'plan',
    interviewStarted: false,
  };

  const ROLE_LABEL = { candidate: '你', interviewer: '面试官', coach: '教练' };
  const assistantRole = () => (state.mode === 'coach' ? 'coach' : 'interviewer');

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
    _micFreq: null,
    playAnalyser: null,
    _playTime: null,
    _playFreq: null,
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

      this._micFreq = new Uint8Array(this.analyser.frequencyBinCount);

      // 播放链路：gain -> analyser -> 扬声器。analyser 用来让「大头」跟着面试官真实的声音动
      this.gain = this.playCtx.createGain();
      this.gain.gain.value = 1;
      this.playAnalyser = this.playCtx.createAnalyser();
      this.playAnalyser.fftSize = 512;
      this.playAnalyser.smoothingTimeConstant = 0.5;
      this._playTime = new Float32Array(this.playAnalyser.fftSize);
      this._playFreq = new Uint8Array(this.playAnalyser.frequencyBinCount);
      this.gain.connect(this.playAnalyser);
      this.playAnalyser.connect(this.playCtx.destination);
    },

    // 面试官 / 教练的声音是否还在扬声器里播（output_audio.done 之后缓冲区里往往还有 1-2 秒）
    isPlaying() {
      return !!this.playCtx && this.sources.size > 0;
    },

    // 播放音量（0-1，按 dB 映射）
    playLevel() {
      if (!this.playAnalyser || !this.isPlaying()) return 0;
      this.playAnalyser.getFloatTimeDomainData(this._playTime);
      let sum = 0;
      for (let i = 0; i < this._playTime.length; i++) sum += this._playTime[i] * this._playTime[i];
      const db = 20 * Math.log10(Math.sqrt(sum / this._playTime.length) + 1e-6);
      return Math.max(0, Math.min(1, (db + 52) / 40));
    },

    // 把人声频段（约 90Hz - 5kHz）压成 out.length 个 0-1 的值，低频在前
    spectrum(which, out) {
      const node = which === 'play' ? this.playAnalyser : this.analyser;
      const buf = which === 'play' ? this._playFreq : this._micFreq;
      if (!node || !buf) return false;
      node.getByteFrequencyData(buf);
      const binHz = node.context.sampleRate / node.fftSize;
      const lo = Math.max(1, Math.round(90 / binHz));
      const hi = Math.min(buf.length - 1, Math.round(5000 / binHz));
      const n = out.length;
      for (let j = 0; j < n; j++) {
        const pos = lo + (hi - lo) * Math.pow(j / (n - 1), 1.6);
        const i0 = Math.floor(pos);
        const f = pos - i0;
        const v = (buf[i0] * (1 - f) + buf[Math.min(hi, i0 + 1)] * f) / 255;
        out[j] = Math.max(0, (v - 0.28) / 0.72);
      }
      return true;
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
      this._micFreq = null;
      this.playAnalyser = null;
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
    if (state.timerId) return; // 切换面试官 / 教练时计时继续
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
            <button class="link-btn coach-btn" data-qidx="${index}">和教练练这题 →</button>
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

  const STEP_STATUS = { ok: '讲到了', weak: '偏弱', missing: '没讲', todo: '待练' };

  // 教练模式下，右上角显示教练的备课单（不显示引导问题，避免剧透）
  function renderCoachCard() {
    const card = $('#cueCard');
    card.classList.remove('hidden');
    card.classList.add('coach');
    $('#cueTitle').textContent = '教练备课单';
    $('#cuePrev').classList.add('hidden');
    $('#cueNext').classList.add('hidden');
    $('#cueIdx').textContent = '';
    $('#cueToggle').textContent = state.cueHidden ? '显示' : '隐藏';
    card.classList.toggle('collapsed', state.cueHidden);
    if (state.cueHidden) {
      $('#cueBody').innerHTML = '';
      return;
    }
    const brief = state.coach && state.coach.brief;
    if (!brief) {
      $('#cueBody').innerHTML = '<div class="muted">教练正在备课…</div>';
      return;
    }
    const steps = (brief.steps || [])
      .map((st) => `<span class="cue-step st-${esc(st.status)}" title="${esc(st.note || '')}">${esc(st.label)}<small>${esc(STEP_STATUS[st.status] || '')}</small></span>`)
      .join('<i>→</i>');
    $('#cueBody').innerHTML = `
      <div class="cue-q">${esc(state.coach.question)}</div>
      <div class="cue-mnemonic">${esc(brief.mnemonic || brief.framework || '')}</div>
      <div class="cue-steps">${steps}</div>
      ${brief.diagnosis ? `<div class="cue-diag"><em>最关键的问题</em>${esc(brief.diagnosis)}</div>` : ''}
      ${brief.strength ? `<div class="cue-good"><em>做对的</em>${esc(brief.strength)}</div>` : ''}
      ${brief.target ? `<div class="cue-target"><em>练完的标准</em>${esc(brief.target)}</div>` : ''}`;
  }

  function renderCue() {
    const card = $('#cueCard');
    if (state.mode === 'coach') {
      renderCoachCard();
      return;
    }
    card.classList.remove('coach');
    $('#cueTitle').textContent = '提词卡';
    $('#cuePrev').classList.remove('hidden');
    $('#cueNext').classList.remove('hidden');
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
    pendingBubble.coach = null;
    localTranscript = [];
    assistantBuf = '';
    state.sessionReady = false;
    stopMicWatch();
    turnCount = 0;
  }

  let turnCount = 0;
  let localTranscript = [];
  let assistantBuf = '';
  const pendingBubble = { candidate: null, interviewer: null, coach: null };

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
      wrap.innerHTML = `<div class="who">${ROLE_LABEL[role] || role}</div><div class="bubble"></div>`;
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
      if (finalText.trim()) {
        const log = state.mode === 'coach' && state.coach ? state.coach.transcript : localTranscript;
        log.push({ role, text: finalText.trim() });
        // 面试中你的每段回答旁边都可以直接叫教练
        if (role === 'candidate' && state.mode === 'interview') {
          const btn = document.createElement('button');
          btn.className = 'bubble-coach';
          btn.dataset.idx = String(localTranscript.length - 1);
          btn.textContent = '这段没答好，找教练';
          node.appendChild(btn);
        }
      }
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

  function connectSocket(params = {}) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ sid: state.sid, mode: state.mode });
    if (params.cid) query.set('cid', params.cid);
    if (params.resume) query.set('resume', params.resume);
    state.lastParams = params;
    const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`);
    state.ws = ws;
    state.sessionReady = false;

    ws.onopen = () => {
      setStatus('建立连接', 'busy');
      setLiveState(state.mode === 'coach' ? '正在连接教练…' : '正在连接面试官…');
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
      if (ws !== state.ws || ws.intentional) return;
      if (!state.ending) showLiveError('连接出错，请检查后端是否在运行。');
    };

    ws.onclose = () => {
      // 切换面试官 / 教练时会主动关掉旧连接，不算出错
      if (ws !== state.ws || ws.intentional) return;
      state.sending = false;
      clearTimeout(state.connectTimer);
      if (!state.ending) {
        showLiveError(state.sessionReady ? '连接已断开，请点「重新连接」。' : '无法连接到后端语音服务，请重试。');
      }
    };
  }

  // 主动结束当前语音连接（切换角色、结束练习时用）
  function closeSocket() {
    const ws = state.ws;
    state.sending = false;
    state.sessionReady = false;
    clearTimeout(state.connectTimer);
    AudioCtl.flush();
    AudioCtl.speaking = false;
    state.thinking = false;
    if (!ws) return;
    ws.intentional = true;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'session.close' })); } catch (_) { /* ignore */ }
    }
    setTimeout(() => {
      try { ws.close(); } catch (_) { /* ignore */ }
    }, 300);
    state.ws = null;
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
        if (state.muted) sendJson({ type: 'input_audio_mute.commit' });
        if (state.mode === 'coach') {
          setStatus('教练练习', 'live');
          setLiveState('教练正在开口…');
          $('#stageTip').textContent = '不用紧张，这里是练习。卡住了可以说「给我提示」或「给我示范」';
        } else {
          state.interviewStarted = true;
          setStatus('面试中', 'live');
          setLiveState('面试官正在开口…');
          $('#stageTip').textContent = '觉得哪段没答好，点「叫教练」或字幕里的「找教练」';
        }
        startTimer();
        startMicWatch();
        break;
      }

      // 开场白由后端直接 TTS 合成，不会产生 text 事件，后端单独发这条用来显示字幕
      case 'local.opening': {
        const role = evt.role === 'coach' ? 'coach' : 'interviewer';
        upsertBubble(role, evt.text || '');
        finalizeBubble(role, evt.text || '');
        break;
      }

      case 'conversation.item.input_audio_transcription.started':
        AudioCtl.flush();
        assistantBuf = '';
        state.thinking = false;
        setLiveState('正在听你说');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        // ASR 返回的是累积文本，直接覆盖
        upsertBubble('candidate', pickText(evt, 'delta', 'text', 'transcript'));
        break;

      case 'conversation.item.input_audio_transcription.completed':
        finalizeBubble('candidate', pickText(evt, 'transcript', 'text'));
        if (!AudioCtl.isPlaying()) {
          state.thinking = true;
          state.thinkingSince = performance.now();
          setLiveState(state.mode === 'coach' ? '教练在想怎么接…' : '面试官在想…');
        }
        break;

      case 'response.output_text.delta':
        // 模型回复的 text delta 是增量片段，需要累积
        assistantBuf += pickText(evt, 'delta', 'text');
        upsertBubble(assistantRole(), assistantBuf);
        break;

      case 'response.output_text.done':
        finalizeBubble(assistantRole(), pickText(evt, 'text') || assistantBuf);
        assistantBuf = '';
        break;

      case 'response.output_audio.started':
        AudioCtl.speaking = true;
        state.thinking = false;
        setLiveState(state.mode === 'coach' ? '教练正在说话' : '面试官正在说话');
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
    setMode('interview');
    state.coachOnly = false;
    state.coach = null;
    state.interviewStarted = false;

    showView('live');
    resetTranscript();
    renderCue();
    updateControls();
    setStatus('准备中', 'busy');
    setLiveState('等待麦克风授权…');
    $('#stageTip').textContent = '浏览器如弹出麦克风授权，请点「允许」';

    if (!(await initAudio())) return;

    state.ending = false;
    connectSocket();
    startOrb();
  }

  async function retryConnection() {
    closeSocket();
    AudioCtl.stopAll();
    AudioCtl.unlock(); // 必须在第一个 await 之前
    $('#btnRetry').classList.add('hidden');

    showView('live');
    renderCue();
    setStatus('准备中', 'busy');
    setLiveState('等待麦克风授权…');

    if (!(await initAudio())) return;

    state.ending = false;
    if (state.mode === 'coach' && state.coach) {
      connectSocket({ cid: state.coach.id });
    } else {
      connectSocket({ resume: state.interviewStarted ? 'next' : '' });
    }
    startOrb();
  }

  /* ============================================================
   * 教练模式
   * ============================================================ */

  function setMode(mode) {
    state.mode = mode;
    $('.stage').classList.toggle('coach', mode === 'coach');
    $('#stageName').textContent = mode === 'coach' ? '教练' : '面试官';
    updateControls();
    renderCue();
  }

  function updateControls() {
    const coach = state.mode === 'coach';
    const ended = !!(state.coach && state.coach.ended);
    const show = (id, on) => $(id).classList.toggle('hidden', !on);
    show('#btnMic', !ended);
    show('#btnCoach', !coach);
    show('#btnEnd', !coach);
    show('#btnBackRetry', coach && !state.coachOnly);
    show('#btnBackNext', coach && !state.coachOnly);
    show('#btnEndCoach', coach && state.coachOnly && !ended);
    show('#btnCoachAgain', coach && state.coachOnly && ended);
    show('#btnCoachReturn', coach && state.coachOnly && ended);
  }

  function addDivider(text) {
    const el = messagesEl();
    const empty = el.querySelector('.empty-hint');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg-divider';
    div.textContent = text;
    el.appendChild(div);
    scrollMessages();
  }

  // 从面试字幕里找出「第 idx 段回答」对应的问题和完整回答
  function answerAt(idx) {
    let qIdx = -1;
    for (let i = idx; i >= 0; i--) {
      if (localTranscript[i].role === 'interviewer') { qIdx = i; break; }
    }
    const parts = [];
    for (let i = qIdx + 1; i < localTranscript.length; i++) {
      if (localTranscript[i].role === 'interviewer') break;
      parts.push(localTranscript[i].text);
    }
    return {
      question: qIdx >= 0 ? localTranscript[qIdx].text : '自我介绍',
      answer: parts.join(' '),
    };
  }

  function lastAnswerIdx() {
    for (let i = localTranscript.length - 1; i >= 0; i--) {
      if (localTranscript[i].role === 'candidate') return i;
    }
    return -1;
  }

  async function createCoach(payload) {
    const res = await fetch(`/api/session/${encodeURIComponent(state.sid)}/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '教练备课失败');
    return data;
  }

  function currentQid() {
    const questions = (state.plan && state.plan.questions) || [];
    const q = questions[state.cueIndex];
    return q && Number.isFinite(Number(q.id)) ? Number(q.id) : null;
  }

  // 面试中途叫教练：idx 不传时取最近一段回答
  async function coachFromInterview(idx) {
    if (state.mode === 'coach' || state.switching) return;
    const at = Number.isInteger(idx) ? idx : lastAnswerIdx();
    if (at < 0) {
      setLiveState('还没有你的回答。先答一题，觉得不好再叫教练');
      return;
    }
    const { question, answer } = answerAt(at);
    state.switching = true;
    closeSocket();
    setMode('coach');
    state.coachOnly = false;
    addDivider(`教练时间 · ${question.length > 24 ? question.slice(0, 24) + '…' : question}`);
    setStatus('教练备课', 'busy');
    setLiveState('教练正在看你刚才的回答…');
    try {
      const data = await createCoach({ question, answer, qid: currentQid(), source: 'interview' });
      state.coach = { id: data.coach_id, brief: data.brief, question, answer, transcript: [], ended: false };
      renderCue();
      if (data.warning) addDivider(data.warning);
      connectSocket({ cid: data.coach_id });
    } catch (err) {
      addDivider(`叫教练失败：${err.message}`);
      setMode('interview');
      connectSocket({ resume: 'retry' });
    } finally {
      state.switching = false;
    }
  }

  // 从教练回到面试：retry 重答这题，next 进入下一题
  function backToInterview(action) {
    if (state.mode !== 'coach' || !state.coach || state.switching) return;
    const coach = state.coach;
    closeSocket();
    summarizeCoach(coach);
    setMode('interview');
    if (action === 'next') moveCue(1);
    addDivider(action === 'next' ? '回到面试 · 下一题' : '回到面试 · 重答这题');
    connectSocket({ cid: coach.id, resume: action });
  }

  // 从方案页 / 报告页单独练一题。必须在点击事件里同步调用（音频解锁）
  async function startCoachPractice({ question, answer = '', qid = null, source = 'plan' }) {
    if (!state.sid || !question) return;
    AudioCtl.unlock();
    state.coachReturnView = state.view;
    state.coachOnly = true;
    state.coach = null;
    state.ending = false;
    if (qid !== null) {
      const idx = ((state.plan && state.plan.questions) || []).findIndex((q) => String(q.id) === String(qid));
      if (idx >= 0) state.cueIndex = idx;
    }
    showView('live');
    resetTranscript();
    setMode('coach');
    addDivider(`教练练习 · ${question.length > 24 ? question.slice(0, 24) + '…' : question}`);
    setStatus('教练备课', 'busy');
    setLiveState('等待麦克风授权…');
    startOrb();

    if (!(await initAudio())) return;
    setLiveState('教练正在备课…');
    try {
      const data = await createCoach({ question, answer, qid, source });
      state.coach = { id: data.coach_id, brief: data.brief, question, answer, qid, source, transcript: [], ended: false };
      renderCue();
      if (data.warning) addDivider(data.warning);
      connectSocket({ cid: data.coach_id });
    } catch (err) {
      showLiveError(`教练备课失败：${err.message}`);
    }
  }

  function endCoachPractice() {
    if (!state.coach) return;
    closeSocket();
    stopTimer();
    stopMicWatch();
    AudioCtl.stopAll();
    state.coach.ended = true;
    setStatus('练习结束', '');
    setLiveState('练习结束');
    updateControls();
    summarizeCoach(state.coach);
  }

  function againCoachPractice() {
    const c = state.coach;
    if (!c) return;
    startCoachPractice({ question: c.question, answer: c.answer, qid: c.qid ?? null, source: c.source || 'plan' });
  }

  function returnFromCoach() {
    state.coach = null;
    state.coachOnly = false;
    setMode('interview');
    setStatus(state.coachReturnView === 'report' ? '已完成' : '方案已生成', '');
    $('#timer').textContent = '00:00';
    showView(state.coachReturnView || 'plan');
  }

  async function summarizeCoach(coach) {
    const card = document.createElement('div');
    card.className = 'coach-summary';
    card.innerHTML = '<div class="cs-title">练习小结</div><div class="hint">正在整理这次练习…</div>';
    messagesEl().appendChild(card);
    scrollMessages();
    try {
      const res = await fetch(
        `/api/session/${encodeURIComponent(state.sid)}/coach/${encodeURIComponent(coach.id)}/summary`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: coach.transcript }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '生成失败');
      coach.summary = data.summary;
      card.innerHTML = data.summary
        ? renderCoachSummary(coach.question, data.summary)
        : `<div class="cs-title">练习小结</div><div class="hint">${esc(data.warning || '没有生成小结')}</div>`;
    } catch (err) {
      card.innerHTML = `<div class="cs-title">练习小结</div><div class="hint">生成失败：${esc(err.message)}</div>`;
    }
    scrollMessages();
  }

  function renderCoachSummary(question, sum) {
    return `
      <div class="cs-title">练习小结</div>
      <div class="cs-q">${esc(question)}</div>
      ${sum.progress ? `<p>${esc(sum.progress)}</p>` : ''}
      ${(sum.takeaways || []).length ? `<h4>记住这几点</h4><ul>${sum.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${sum.improved_answer ? `<h4>练完后的版本</h4><div class="better">${esc(sum.improved_answer)}</div>` : ''}
      ${(sum.still_missing || []).length ? `<h4>课后补充</h4><ul class="ol-need">${sum.still_missing.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}`;
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
    loadCoachHistory();
    setStatus('已完成', '');
  }

  async function fetchCoaching() {
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(state.sid)}/coaching`);
      if (!res.ok) return [];
      return (await res.json()).items || [];
    } catch (_) {
      return [];
    }
  }

  async function loadCoachHistory() {
    const items = (await fetchCoaching()).filter((c) => c.summary || (c.transcript || []).length > 1);
    const box = $('#coachHistory');
    if (!box || !items.length) return;
    box.innerHTML = `<div class="card-title">教练练习记录 · ${items.length} 次</div>${items
      .map((c) =>
        c.summary
          ? `<div class="coach-summary">${renderCoachSummary(c.question, c.summary)}</div>`
          : `<div class="coach-summary"><div class="cs-q">${esc(c.question)}</div><div class="hint">练习了 ${c.transcript.length} 轮，没有生成小结</div></div>`
      )
      .join('')}`;
    box.classList.remove('hidden');
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
              <button class="ghost coach-btn" data-question="${esc(q.question)}" data-answer="${esc(q.answer_summary || '')}">和教练练这题</button>
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

      <div class="card report-card hidden" id="coachHistory" style="margin-bottom:22px"></div>

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
      const coaching = (await fetchCoaching()).filter((c) => c.summary);
      let md = toMarkdown(report);
      if (coaching.length) {
        md += '\n\n## 教练练习记录\n';
        coaching.forEach((c) => {
          const sum = c.summary;
          md += `\n### ${c.question}\n`;
          if (sum.progress) md += `\n${sum.progress}\n`;
          (sum.takeaways || []).forEach((t) => { md += `- ${t}\n`; });
          if (sum.improved_answer) md += `\n> 练完后的版本：${sum.improved_answer}\n`;
        });
      }
      downloadText(md, `面试复盘-${state.sid}.md`);
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
    closeSocket();
    AudioCtl.stopAll();
    stopTimer();
    stopMicWatch();
    clearTimeout(state.connectTimer);
    state.sid = null;
    state.outlines = null;
    state.cueIndex = 0;
    state.coach = null;
    state.coachOnly = false;
    state.interviewStarted = false;
    setMode('interview');
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
   * 面试官布偶：灯芯绒 / 毛毡手偶，铰链嘴跟着真实声音开合
   * 说话：下巴绕嘴角铰链张开，开合幅度来自扬声器实际播放的音量，弹簧带一点回弹
   * 在听：歪头、挑眉、盯着你，你每说一句它点一下头、嘴里「嗯」一下
   * 在想：眼睛往左上瞟、半眯眼、一边眉毛挑起、嘴撇到一边
   * 空闲：呼吸、眨眼、偶尔扫一眼；连接中闭眼打盹
   * ============================================================ */

  const canvas = $('#orb');
  const ctx2d = canvas.getContext('2d');
  const stageEl = $('.stage');
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let orbRunning = false;
  let lastDebugAt = 0;

  const MOODS = ['connect', 'idle', 'listen', 'think', 'talk'];
  const MOOD_LABEL = {
    connect: '连接中',
    idle: '等你开口',
    listen: '在听你说',
    think: '思考中',
    talk: '说话中',
  };

  // 两个布偶：面试官是锈橙色灯芯绒 + 藏青西装领带，教练是青色毛毡 + 补丁 + 芥末黄毛衣
  const PUPPETS = {
    interviewer: {
      head: { kind: 'corduroy', color: '#c4743a' },
      jaw: { kind: 'corduroy', color: '#a95f2c' },
      hair: '#4a2c1c',
      brow: '#3a2216',
      nose: '#7d2f22',
      body: { kind: 'corduroy', color: '#2c3a5e' },
      collar: '#efe8da',
      tie: '#9c2f36',
      patch: null,
    },
    coach: {
      head: { kind: 'felt', color: '#3aa892' },
      jaw: { kind: 'felt', color: '#2f8f7c' },
      hair: '#f0b54a',
      brow: '#1f5a4e',
      nose: '#e2763c',
      body: { kind: 'felt', color: '#d9a640' },
      collar: null,
      tie: null,
      patch: { kind: 'corduroy', color: '#e6c27a' },
    },
  };

  const Face = {
    t: 0,
    last: 0,
    ai: 0,
    you: 0,
    youAvg: 0,
    aiAvg: 0,
    youUntil: 0,
    lastYouBeat: 0,
    lastAiBeat: 0,
    jaw: 0,
    jawV: 0,
    jawKick: 0,
    nod: 0,
    nodV: 0,
    hop: 0,
    hopV: 0,
    hair: 0,
    hairV: 0,
    prevHeadY: 0,
    tilt: 0,
    smile: 0.4,
    mouthW: 0.85,
    mouthShift: 0,
    browL: 0,
    browR: 0,
    lid: 0,
    lookX: 0,
    lookY: 0,
    glanceX: 0,
    glanceY: 0,
    nextGlance: 2,
    nextBlink: 2,
    blinkAt: -1,
    mix: { connect: 1, idle: 0, listen: 0, think: 0, talk: 0 },
    color: [245, 185, 98],
    spec: new Float32Array(24),
    mood: '',
    cssEnergy: -1,
    cssGlow: '',
  };

  function moodTones() {
    const coach = state.mode === 'coach';
    return {
      talk: coach ? [95, 227, 200] : [245, 185, 98],
      listen: coach ? [128, 172, 255] : [95, 227, 200],
      think: [170, 150, 255],
      idle: state.muted ? [120, 126, 140] : (coach ? [120, 200, 190] : [214, 180, 130]),
      connect: [130, 140, 160],
    };
  }

  // 指数平滑：上升快、回落慢
  function follow(cur, target, up, down, dt) {
    const rate = target > cur ? up : down;
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  function rgba(c, a) {
    return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function shade(hex, amt) {
    const c = hexRgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)))));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  /* ---------- 面料贴图（生成一次，缓存） ---------- */

  const textureCache = {};

  function fabric(spec) {
    const key = `${spec.kind}:${spec.color}`;
    if (textureCache[key]) return textureCache[key];
    const tile = document.createElement('canvas');
    const size = spec.kind === 'corduroy' ? 48 : 96;
    tile.width = size;
    tile.height = size;
    const g = tile.getContext('2d');
    g.fillStyle = spec.color;
    g.fillRect(0, 0, size, size);

    if (spec.kind === 'corduroy') {
      // 竖条绒：每条中间亮、两边暗
      const wale = 6;
      for (let x = 0; x < size; x += wale) {
        const grad = g.createLinearGradient(x, 0, x + wale, 0);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
        grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.14)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
        g.fillStyle = grad;
        g.fillRect(x, 0, wale, size);
      }
    }

    // 毛毡纤维：短而乱的细线
    const fibers = spec.kind === 'corduroy' ? 500 : 2600;
    for (let i = 0; i < fibers; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const a = Math.random() * Math.PI * 2;
      const len = 1.5 + Math.random() * (spec.kind === 'corduroy' ? 2.5 : 5);
      g.strokeStyle = Math.random() < 0.5
        ? `rgba(255, 255, 255, ${0.04 + Math.random() * 0.09})`
        : `rgba(0, 0, 0, ${0.05 + Math.random() * 0.12})`;
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }

    const pattern = ctx2d.createPattern(tile, 'repeat');
    textureCache[key] = pattern;
    return pattern;
  }

  // 布料填充：贴图 + 软阴影 + 左上受光
  function fillFabric(path, spec, light, shadow = true) {
    ctx2d.save();
    if (shadow) {
      ctx2d.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx2d.shadowBlur = 22;
      ctx2d.shadowOffsetY = 8;
    }
    ctx2d.fillStyle = fabric(spec);
    ctx2d.fill(path);
    ctx2d.restore();

    ctx2d.save();
    ctx2d.clip(path);
    const grad = ctx2d.createRadialGradient(light[0], light[1], 10, light[0], light[1], light[2]);
    grad.addColorStop(0, 'rgba(255, 240, 220, 0.22)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
    ctx2d.fillStyle = grad;
    ctx2d.fill(path);
    ctx2d.restore();
  }

  // 缝线：浅色虚线
  function stitch(path, color = 'rgba(255, 244, 225, 0.55)') {
    ctx2d.save();
    ctx2d.setLineDash([7, 6]);
    ctx2d.lineWidth = 2;
    ctx2d.lineCap = 'round';
    ctx2d.strokeStyle = color;
    ctx2d.stroke(path);
    ctx2d.restore();
  }

  function fitCanvas() {
    const css = canvas.clientWidth;
    if (!css) return;
    const size = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  function startOrb() {
    if (orbRunning) return;
    orbRunning = true;
    Face.last = 0;
    requestAnimationFrame(drawOrb);
  }

  // 任何一次点击都尝试恢复被浏览器挂起的音频（Safari / 切后台后常见）
  document.addEventListener('click', () => {
    if (AudioCtl.suspended()) AudioCtl.resume();
  });

  function updateMicDebug(m, now) {
    const bar = $('#micBar');
    if (bar) bar.style.width = `${Math.round(m.ratio * 100)}%`;

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
  }

  function setMood(mood) {
    const label = mood === 'idle' && state.muted ? '你已静音' : MOOD_LABEL[mood];
    if (Face.mood === label) return;
    Face.mood = label;
    stageEl.dataset.mood = mood;
    $('#stageMood').textContent = label || '';
  }

  /* ---------- 每帧：读信号 -> 驱动表情 -> 画 ---------- */

  function drawOrb(nowMs) {
    if ($('#view-live').classList.contains('hidden')) {
      orbRunning = false;
      return;
    }
    requestAnimationFrame(drawOrb);

    const dt = Face.last ? Math.min(0.05, (nowMs - Face.last) / 1000) : 1 / 60;
    Face.last = nowMs;
    Face.t += dt;
    const t = Face.t;

    fitCanvas();
    const m = AudioCtl.meter();
    updateMicDebug(m, performance.now());

    // 1. 现在谁在说
    const playing = AudioCtl.isPlaying();
    const aiRaw = AudioCtl.playLevel();
    // 底噪大约在 -50 dB 以下（ratio < 0.2），-38 dB 以上才算你在说话
    const youRaw = state.muted || playing ? 0 : Math.max(0, (m.ratio - 0.3) / 0.7);
    if (youRaw > 0.12) Face.youUntil = t + 0.45;

    if (playing) state.thinking = false;
    if (state.thinking && performance.now() - state.thinkingSince > 15000) state.thinking = false;

    let mood = 'idle';
    if (!state.sessionReady) mood = 'connect';
    else if (playing) mood = 'talk';
    else if (t < Face.youUntil) mood = 'listen';
    else if (state.thinking) mood = 'think';
    setMood(mood);

    Face.ai = follow(Face.ai, aiRaw, 30, 7, dt);
    Face.you = follow(Face.you, youRaw, 24, 5, dt);
    MOODS.forEach((key) => {
      Face.mix[key] = follow(Face.mix[key], key === mood ? 1 : 0, 6, 4, dt);
    });
    const mix = Face.mix;

    const tones = moodTones();
    let total = 0;
    const color = [0, 0, 0];
    MOODS.forEach((key) => {
      total += mix[key];
      for (let c = 0; c < 3; c++) color[c] += tones[key][c] * mix[key];
    });
    for (let c = 0; c < 3; c++) Face.color[c] = color[c] / (total || 1);
    const tone = Face.color;

    // 2. 嘴：铰链 + 弹簧。音量过门限才张嘴，像操偶师手腕一下一下地开合
    let jawTarget = 0;
    let bright = 0.5;
    if (playing) {
      jawTarget = Math.max(0, Math.min(1, (aiRaw - 0.14) / 0.55));
      if (AudioCtl.spectrum('play', Face.spec)) {
        let lo = 0;
        let hi = 0;
        for (let j = 0; j < 24; j++) (j < 8 ? (lo += Face.spec[j]) : (hi += Face.spec[j]));
        bright = hi / (lo * 2 + hi + 1e-3);
      }
    }
    Face.aiAvg = follow(Face.aiAvg, aiRaw, 5, 5, dt);
    if (playing && aiRaw > 0.3 && aiRaw > Face.aiAvg * 1.25 + 0.06 && t - Face.lastAiBeat > 0.16) {
      Face.lastAiBeat = t;
      Face.hopV -= 0.9 * aiRaw; // 重音时整个头往上一顶
    }
    Face.jawKick = follow(Face.jawKick, 0, 0, 7, dt);
    jawTarget = Math.max(jawTarget, Face.jawKick, mix.think * (0.06 + Math.sin(t * 2.2) * 0.03));
    Face.jawV += ((jawTarget - Face.jaw) * 420 - Face.jawV * 24) * dt;
    Face.jaw = Math.max(-0.04, Math.min(1.15, Face.jaw + Face.jawV * dt));

    // 3. 听你说：点头 + 「嗯」
    Face.youAvg = follow(Face.youAvg, youRaw, 5, 5, dt);
    if (mood === 'listen' && youRaw > 0.25 && youRaw > Face.youAvg * 1.3 + 0.06 && t - Face.lastYouBeat > 0.6) {
      Face.lastYouBeat = t;
      Face.nodV += 1.1 + youRaw * 0.5;
      if (Math.random() < 0.5) Face.jawKick = 0.16;
    }
    Face.nodV += (-90 * Face.nod - 11 * Face.nodV) * dt;
    Face.nod += Face.nodV * dt;
    Face.hopV += (-160 * Face.hop - 14 * Face.hopV) * dt;
    Face.hop += Face.hopV * dt;

    // 4. 表情目标
    const rate = 7;
    Face.tilt = follow(Face.tilt, mix.listen * 0.08 - mix.think * 0.1 + mix.talk * Math.sin(t * 1.9) * 0.035 + Math.sin(t * 0.7) * 0.012, rate, rate, dt);
    Face.smile = follow(Face.smile, mix.listen * 0.75 + mix.idle * 0.45 + mix.talk * 0.35 - mix.think * 0.25 + mix.connect * 0.2, rate, rate, dt);
    Face.mouthW = follow(Face.mouthW, mix.talk * (0.8 + bright * 0.45) + mix.listen * 0.82 + mix.idle * 0.85 + mix.think * 0.55 + mix.connect * 0.75, 10, 10, dt);
    Face.mouthShift = follow(Face.mouthShift, mix.think * -26, rate, rate, dt);
    Face.browL = follow(Face.browL, mix.listen * 1 + mix.think * 1.1 + mix.talk * (0.25 + Face.jaw * 0.5) - mix.connect * 0.3, 9, 9, dt);
    Face.browR = follow(Face.browR, mix.listen * 1 - mix.think * 0.6 + mix.talk * (0.25 + Face.jaw * 0.5) - mix.connect * 0.3, 9, 9, dt);

    // 眨眼：每 2-5 秒一次，在听的时候眨得少
    if (t > Face.nextBlink) {
      Face.blinkAt = t;
      Face.nextBlink = t + (mood === 'listen' ? 3.5 : 2) + Math.random() * 3;
    }
    const bp = (t - Face.blinkAt) / 0.17;
    const blink = bp >= 0 && bp <= 1 ? Math.sin(bp * Math.PI) : 0;
    const lidBase = mix.connect * 1 + mix.think * 0.38 + mix.idle * 0.08 - mix.listen * 0.05;
    Face.lid = Math.max(0, Math.min(1, Math.max(lidBase, blink)));

    // 视线：在听时盯着你，想事时往左上瞟，其他时候偶尔扫一眼
    if (t > Face.nextGlance) {
      Face.nextGlance = t + 1.4 + Math.random() * 2.6;
      const far = Math.random() < 0.3;
      Face.glanceX = far ? (Math.random() - 0.5) * 1.4 : (Math.random() - 0.5) * 0.4;
      Face.glanceY = far ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 0.2;
    }
    const gx = (mix.idle + mix.talk * 0.5) * Face.glanceX - mix.think * 0.75;
    const gy = (mix.idle + mix.talk * 0.5) * Face.glanceY - mix.think * 0.8 + mix.listen * 0.1;
    Face.lookX = follow(Face.lookX, gx, 22, 22, dt);
    Face.lookY = follow(Face.lookY, gy, 22, 22, dt);

    // 5. 画
    const w = canvas.width;
    const s = w / 720;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, w, w);

    // 舞台追光
    const energy = Math.max(Face.ai, Face.you * 0.8);
    const aura = ctx2d.createRadialGradient(w / 2, w * 0.42, w * 0.05, w / 2, w * 0.42, w * 0.55);
    aura.addColorStop(0, rgba(tone, 0.2 + energy * 0.25));
    aura.addColorStop(0.5, rgba(tone, 0.06 + energy * 0.08));
    aura.addColorStop(1, rgba(tone, 0));
    ctx2d.fillStyle = aura;
    ctx2d.fillRect(0, 0, w, w);

    const breathe = Math.sin(t * 1.6) * 4 * (1 - mix.connect * 0.5);
    const headY = 392 + breathe + Face.nod * 70 + Face.hop * 60 - Face.jaw * 8 + mix.connect * 10;
    const vel = (headY - Face.prevHeadY) / Math.max(dt, 1e-3);
    Face.prevHeadY = headY;
    Face.hairV += (-120 * Face.hair - 7 * Face.hairV - (reduceMotion ? 0 : vel * 0.012)) * dt;
    Face.hair += Face.hairV * dt;

    ctx2d.setTransform(s, 0, 0, s, 0, 0);
    drawPuppet(PUPPETS[state.mode === 'coach' ? 'coach' : 'interviewer'], headY, t);

    // 底部渐隐，袖子像是从舞台下伸上来的
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.globalCompositeOperation = 'destination-out';
    const fade = ctx2d.createLinearGradient(0, w * 0.8, 0, w);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
    ctx2d.fillStyle = fade;
    ctx2d.fillRect(0, w * 0.8, w, w * 0.2);
    ctx2d.globalCompositeOperation = 'source-over';

    // 舞台氛围光跟着一起变
    const e = Math.round(energy * 50) / 50;
    if (e !== Face.cssEnergy) {
      Face.cssEnergy = e;
      stageEl.style.setProperty('--energy', String(e));
    }
    const glow = tone.map((v) => Math.min(255, Math.round(v / 8) * 8)).join(', ');
    if (glow !== Face.cssGlow) {
      Face.cssGlow = glow;
      stageEl.style.setProperty('--glow', glow);
    }
  }

  /* ---------- 布偶本体（720 × 720 的坐标系） ---------- */

  function drawPuppet(P, headY, t) {
    const cx = 360;

    // 身体：从下面伸上来的袖子 / 衣服，不跟着头动
    const body = new Path2D();
    body.moveTo(cx - 150, headY + 70);
    body.bezierCurveTo(cx - 200, headY + 120, cx - 230, headY + 250, cx - 240, 760);
    body.lineTo(cx + 240, 760);
    body.bezierCurveTo(cx + 230, headY + 250, cx + 200, headY + 120, cx + 150, headY + 70);
    body.closePath();
    fillFabric(body, P.body, [cx - 80, headY + 120, 360]);

    if (P.collar) {
      [-1, 1].forEach((side) => {
        const collar = new Path2D();
        collar.moveTo(cx, headY + 120);
        collar.lineTo(cx + side * 110, headY + 84);
        collar.lineTo(cx + side * 70, headY + 190);
        collar.closePath();
        fillFabric(collar, { kind: 'felt', color: P.collar }, [cx + side * 60, headY + 110, 140], false);
        stitch(collar, 'rgba(120, 110, 95, 0.5)');
      });
      const tie = new Path2D();
      tie.moveTo(cx - 18, headY + 120);
      tie.lineTo(cx + 18, headY + 120);
      tie.lineTo(cx + 30, headY + 290);
      tie.lineTo(cx, headY + 320);
      tie.lineTo(cx - 30, headY + 290);
      tie.closePath();
      fillFabric(tie, { kind: 'felt', color: P.tie }, [cx - 10, headY + 160, 200], false);
    } else {
      // 毛衣罗纹领口
      const neck = new Path2D();
      neck.ellipse(cx, headY + 96, 150, 34, 0, 0, Math.PI * 2);
      fillFabric(neck, { kind: 'corduroy', color: shade(P.body.color, -0.15) }, [cx - 40, headY + 80, 200], false);
    }

    ctx2d.save();
    ctx2d.translate(cx, headY);
    ctx2d.rotate(Face.tilt);

    const open = Math.max(0, Face.jaw);
    const lift = open * 34;              // 上半个头往上抬
    const drop = open * 74;              // 下巴往下掉
    const mw = 140 * Face.mouthW;        // 嘴角铰链位置
    const corner = -Face.smile * 16;     // 嘴角上扬
    const shift = Face.mouthShift;

    // 下巴：嘴角是铰链，中间掉得最多
    const jaw = new Path2D();
    jaw.moveTo(-150, -lift * 0.2);
    jaw.bezierCurveTo(-158, 40 + drop * 0.5, -110, 98 + drop, 0, 102 + drop);
    jaw.bezierCurveTo(110, 98 + drop, 158, 40 + drop * 0.5, 150, -lift * 0.2);
    jaw.closePath();
    fillFabric(jaw, P.jaw, [-50, 30 + drop, 220]);

    // 嘴里：下唇曲线以上、被上半个头盖住的部分
    const lowerLip = new Path2D();
    lowerLip.moveTo(-mw + shift, corner);
    lowerLip.quadraticCurveTo(shift, 22 + drop * 2, mw + shift, corner);
    lowerLip.lineTo(mw + shift, -lift - 40);
    lowerLip.lineTo(-mw + shift, -lift - 40);
    lowerLip.closePath();
    ctx2d.save();
    ctx2d.clip(lowerLip);
    const throat = ctx2d.createRadialGradient(shift, 10 + drop * 0.6, 4, shift, 10 + drop * 0.6, mw);
    throat.addColorStop(0, '#12040a');
    throat.addColorStop(0.6, '#3a0d18');
    throat.addColorStop(1, '#5a1724');
    ctx2d.fillStyle = throat;
    ctx2d.fillRect(-mw - 20 + shift, -lift - 40, mw * 2 + 40, drop + lift + 120);
    // 舌头：毛毡粉
    const tongue = new Path2D();
    tongue.ellipse(shift, 16 + drop * 1.15, mw * 0.58, 18 + open * 26, 0, 0, Math.PI * 2);
    fillFabric(tongue, { kind: 'felt', color: '#c95a66' }, [shift - 20, drop, 120], false);
    ctx2d.restore();

    // 上半个头
    const head = new Path2D();
    head.moveTo(-150, -lift * 0.2);
    head.bezierCurveTo(-182, -50 - lift, -192, -178 - lift, -128, -238 - lift);
    head.bezierCurveTo(-82, -278 - lift, 82, -278 - lift, 128, -238 - lift);
    head.bezierCurveTo(192, -178 - lift, 182, -50 - lift, 150, -lift * 0.2);
    // 上唇：中间微微往下包
    head.lineTo(mw + shift, corner - lift);
    head.quadraticCurveTo(shift, 16 - lift, -mw + shift, corner - lift);
    head.closePath();
    fillFabric(head, P.head, [-70, -200 - lift, 340]);

    const lipSeam = new Path2D();
    lipSeam.moveTo(mw + shift - 6, corner - lift - 9);
    lipSeam.quadraticCurveTo(shift, 6 - lift, -mw + shift + 6, corner - lift - 9);
    stitch(lipSeam);
    const headSeam = new Path2D();
    headSeam.moveTo(0, -268 - lift);
    headSeam.quadraticCurveTo(-6, -170 - lift, 0, -130 - lift);
    stitch(headSeam, 'rgba(0, 0, 0, 0.22)');

    if (P.patch) {
      const patch = new Path2D();
      patch.moveTo(96, -150 - lift);
      patch.lineTo(146, -138 - lift);
      patch.lineTo(140, -88 - lift);
      patch.lineTo(92, -98 - lift);
      patch.closePath();
      fillFabric(patch, P.patch, [110, -140 - lift, 80], false);
      stitch(patch, 'rgba(60, 40, 20, 0.6)');
    }

    // 腮红
    [-1, 1].forEach((side) => {
      const blush = ctx2d.createRadialGradient(side * 112, -56 - lift, 2, side * 112, -56 - lift, 34);
      blush.addColorStop(0, 'rgba(255, 120, 120, 0.32)');
      blush.addColorStop(1, 'rgba(255, 120, 120, 0)');
      ctx2d.fillStyle = blush;
      ctx2d.fillRect(side * 112 - 40, -96 - lift, 80, 80);
    });

    // 头发：一排毛毡穗，头一动就晃
    for (let i = 0; i < 9; i++) {
      const x = -84 + i * 21;
      const len = 46 + Math.abs(4 - i) * -4 + (i % 2) * 8;
      const sway = Face.hair * (0.6 + (i % 3) * 0.2) + Math.sin(t * 1.3 + i) * 0.03;
      ctx2d.save();
      ctx2d.translate(x, -262 - lift + Math.abs(4 - i) * 3);
      ctx2d.rotate((i - 4) * 0.13 + sway);
      const tuft = new Path2D();
      tuft.moveTo(-12, 6);
      tuft.quadraticCurveTo(-10, -len * 0.6, 0, -len);
      tuft.quadraticCurveTo(10, -len * 0.6, 12, 6);
      tuft.closePath();
      fillFabric(tuft, { kind: 'felt', color: P.hair }, [-4, -len * 0.7, len], false);
      ctx2d.restore();
    }

    // 鼻子：毛球
    const noseY = -92 - lift;
    const nose = new Path2D();
    nose.ellipse(0, noseY, 36, 30, 0, 0, Math.PI * 2);
    fillFabric(nose, { kind: 'felt', color: P.nose }, [-12, noseY - 12, 44]);
    ctx2d.beginPath();
    ctx2d.arc(-11, noseY - 11, 7, 0, Math.PI * 2);
    ctx2d.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx2d.fill();

    // 眼睛：乒乓球眼 + 毛毡眼皮
    [-1, 1].forEach((side) => {
      const ex = side * 64;
      const ey = -224 - lift;
      const r = 50;
      ctx2d.save();
      ctx2d.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx2d.shadowBlur = 14;
      ctx2d.shadowOffsetY = 5;
      const white = ctx2d.createRadialGradient(ex - 16, ey - 18, 4, ex, ey, r);
      white.addColorStop(0, '#ffffff');
      white.addColorStop(0.7, '#efe9dc');
      white.addColorStop(1, '#bfb6a4');
      ctx2d.fillStyle = white;
      ctx2d.beginPath();
      ctx2d.arc(ex, ey, r, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.restore();

      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(ex, ey, r, 0, Math.PI * 2);
      ctx2d.clip();
      // 两只眼稍微对内，看起来在盯着你
      const px = ex + Face.lookX * 18 - side * 4;
      const py = ey + 6 + Face.lookY * 16;
      ctx2d.fillStyle = '#141014';
      ctx2d.beginPath();
      ctx2d.arc(px, py, 17, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx2d.beginPath();
      ctx2d.arc(px - 6, py - 6, 4.5, 0, Math.PI * 2);
      ctx2d.fill();
      // 眼皮：从上往下盖，下沿是弧线
      const lidY = ey - r + Face.lid * r * 2.05;
      const lid = new Path2D();
      lid.moveTo(ex - r - 4, ey - r - 4);
      lid.lineTo(ex + r + 4, ey - r - 4);
      lid.lineTo(ex + r + 4, lidY);
      lid.quadraticCurveTo(ex, lidY + 14, ex - r - 4, lidY);
      lid.closePath();
      if (Face.lid > 0.01) {
        fillFabric(lid, P.head, [ex - 10, ey - r, r * 2], false);
        const lidEdge = new Path2D();
        lidEdge.moveTo(ex + r, lidY);
        lidEdge.quadraticCurveTo(ex, lidY + 14, ex - r, lidY);
        ctx2d.lineWidth = 3;
        ctx2d.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx2d.stroke(lidEdge);
      }
      ctx2d.restore();

      // 眉毛：毛毡条
      const raise = side < 0 ? Face.browL : Face.browR;
      ctx2d.save();
      ctx2d.translate(ex + side * 4, ey - r - 14 - raise * 14);
      ctx2d.rotate(side * (0.12 - raise * 0.16));
      const brow = new Path2D();
      brow.moveTo(-34, 6);
      brow.quadraticCurveTo(0, -10, 34, 6);
      brow.quadraticCurveTo(0, -2, -34, 6);
      brow.closePath();
      ctx2d.lineWidth = 12;
      ctx2d.lineJoin = 'round';
      ctx2d.strokeStyle = P.brow;
      ctx2d.stroke(brow);
      ctx2d.restore();
    });

    ctx2d.restore();
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
      loadCoachHistory();
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
  $('#btnCoach').addEventListener('click', () => coachFromInterview());
  $('#btnBackRetry').addEventListener('click', () => backToInterview('retry'));
  $('#btnBackNext').addEventListener('click', () => backToInterview('next'));
  $('#btnEndCoach').addEventListener('click', endCoachPractice);
  $('#btnCoachAgain').addEventListener('click', againCoachPractice);
  $('#btnCoachReturn').addEventListener('click', returnFromCoach);
  $('#messages').addEventListener('click', (event) => {
    const btn = event.target.closest('.bubble-coach');
    if (btn) coachFromInterview(Number(btn.dataset.idx));
  });
  $('#questionList').addEventListener('click', (event) => {
    const btn = event.target.closest('.coach-btn');
    if (!btn) return;
    const q = ((state.plan && state.plan.questions) || [])[Number(btn.dataset.qidx)];
    if (q) startCoachPractice({ question: q.question, qid: q.id ?? null, source: 'plan' });
  });
  $('#reportBody').addEventListener('click', (event) => {
    const btn = event.target.closest('.coach-btn');
    if (!btn) return;
    startCoachPractice({ question: btn.dataset.question, answer: btn.dataset.answer || '', source: 'report' });
  });
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
