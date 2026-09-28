/**
 * video-player.js — Capivara narradora com vídeo de fundo
 * togag — Criador de jogos com IA
 *
 * Módulos:
 *  FSM                — estados da experiência
 *  CanvasRenderer     — animação do estado "gerando"
 *  AudioEngine        — SpeechSynthesis sincronizado com vídeo da capivara
 *  CapivaraEngine     — alterna idle / fala nos vídeos de fundo
 *  ConversationEngine — coleta de requisitos via chat livre
 *  VoiceInput         — MediaRecorder → /api/transcrever
 *  GeneratorEngine    — cria projeto + stream /api/chat
 *  Exporter           — MediaRecorder canvas → WebM download
 *  App                — orquestrador principal
 */

'use strict';

// ====================================================================
// 1. FSM
// ====================================================================
const FSM = (() => {
  const T = {
    IDLE:     ['WELCOME'],
    WELCOME:  ['INTRO'],
    INTRO:    ['CONVERSA'],
    CONVERSA: ['CONVERSA', 'GERANDO'],
    GERANDO:  ['FINAL'],
    FINAL:    ['IDLE'],
  };
  let estado = 'IDLE';
  const listeners = {};

  function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
  function emit(ev, d) { (listeners[ev] || []).forEach(fn => fn(d)); }

  function ir(prox) {
    if (!(T[estado] || []).includes(prox)) {
      console.warn(`[FSM] inválido: ${estado} → ${prox}`); return false;
    }
    const ant = estado; estado = prox;
    emit('mudanca', { de: ant, para: prox });
    const el = document.getElementById('fsm-indicator');
    if (el) el.textContent = `FSM: ${prox}`;
    return true;
  }

  return { ir, on, atual: () => estado };
})();

// ====================================================================
// 2. CapivaraEngine — troca idle ↔ fala nos vídeos de fundo
// ====================================================================
const CapivaraEngine = (() => {
  let vidIdle, vidFala, bgEl;
  let falando = false;

  function init() {
    vidIdle = document.getElementById('vid-idle');
    vidFala = document.getElementById('vid-fala');
    bgEl    = document.getElementById('video-bg');

    if (!vidIdle || !vidFala) {
      console.warn('[Capivara] Vídeos não encontrados no DOM'); return;
    }

    // Garante que o vídeo de fala NÃO está em loop (toca uma vez por frase)
    vidFala.loop = false;

    // Quando o vídeo de fala terminar, volta para idle
    vidFala.addEventListener('ended', () => {
      if (falando) return; // SpeechSynthesis ainda falando — aguarda
      pararFala();
    });
  }

  /** Ativa o vídeo de fala (capivara com boca mexendo) */
  function iniciarFala() {
    if (!vidFala) return;
    falando = true;
    bgEl?.classList.add('falando');
    vidFala.currentTime = 0;
    vidFala.play().catch(() => {});
  }

  /** Volta para idle (capivara esperando) */
  function pararFala() {
    if (!vidFala) return;
    falando = false;
    bgEl?.classList.remove('falando');
    vidFala.pause();
    vidFala.currentTime = 0;
  }

  /** Toca a fala novamente se o vídeo terminou mas o speech ainda está ativo */
  function manterFala() {
    if (!falando || !vidFala) return;
    if (vidFala.ended || vidFala.paused) {
      vidFala.currentTime = 0;
      vidFala.play().catch(() => {});
    }
  }

  return { init, iniciarFala, pararFala, manterFala };
})();

// ====================================================================
// 3. AudioEngine — SpeechSynthesis sincronizado com CapivaraEngine
// ====================================================================
const AudioEngine = (() => {
  let ok = false;
  let loopTimer = null;

  function habilitar() { ok = true; }

  function falar(texto, rate = 1.0) {
    return new Promise(resolve => {
      if (!ok || !texto || !window.speechSynthesis) {
        resolve(); return;
      }
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(texto);
      u.lang = 'pt-BR'; u.rate = rate; u.pitch = 1.05;
      const vozes = window.speechSynthesis.getVoices();
      u.voice = vozes.find(v => v.lang.startsWith('pt-BR'))
             || vozes.find(v => v.lang.startsWith('pt'))
             || vozes.find(v => v.lang.startsWith('en'))
             || null;

      // Sincroniza vídeo: ativa fala da capivara
      CapivaraEngine.iniciarFala();

      // Loop para manter o vídeo de fala se ele for mais curto que a narração
      loopTimer = setInterval(() => CapivaraEngine.manterFala(), 500);

      u.onend = () => {
        clearInterval(loopTimer);
        CapivaraEngine.pararFala();
        resolve();
      };
      u.onerror = () => {
        clearInterval(loopTimer);
        CapivaraEngine.pararFala();
        resolve();
      };

      window.speechSynthesis.speak(u);
    });
  }

  function parar() {
    clearInterval(loopTimer);
    window.speechSynthesis?.cancel();
    CapivaraEngine.pararFala();
  }

  return { habilitar, falar, parar };
})();

// ====================================================================
// 4. CanvasRenderer — apenas para a animação "gerando"
// ====================================================================
const CanvasRenderer = (() => {
  let rafId = null;
  let gerandoSt = null;

  function clamp(mn, v, mx) { return Math.max(mn, Math.min(mx, v)); }

  function iniciarGerando(canvas) {
    pararGerando();
    const ctx = canvas.getContext('2d');
    gerandoSt = { statusTexto: '', particulas: [], aneis: [] };

    gerandoSt.aneis = Array.from({ length: 5 }, (_, i) => ({
      r: 40+i*38, vel: (.3+i*.1)*(i%2?1:-1), op: .55-i*.08,
    }));
    gerandoSt.particulas = Array.from({ length: 45 }, () => ({
      angle: Math.random()*Math.PI*2,
      dist: 35+Math.random()*170,
      speed: .003+Math.random()*.007,
      r: Math.random()*2+.5,
      hue: 240+Math.random()*80,
      alpha: Math.random()*.7+.3,
    }));

    let t = 0;
    function loop() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) { rafId = requestAnimationFrame(loop); return; }

      canvas.width  = r.width  * devicePixelRatio;
      canvas.height = r.height * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

      const W = r.width, H = r.height, cx = W/2, cy = H*.42;

      // Fundo escuro (por cima do vídeo)
      ctx.fillStyle = 'rgba(8,8,16,.88)'; ctx.fillRect(0, 0, W, H);

      // Anéis rotativos
      for (const a of gerandoSt.aneis) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * a.vel);
        ctx.beginPath(); ctx.arc(0, 0, a.r*(1+.04*Math.sin(t*1.2)), 0, Math.PI*2);
        ctx.strokeStyle = `rgba(167,139,250,${a.op*(.7+.3*Math.sin(t*2))})`; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.restore();
      }

      // Partículas orbitando
      for (const p of gerandoSt.particulas) {
        p.angle += p.speed;
        const x = cx + Math.cos(p.angle)*p.dist;
        const y = cy + Math.sin(p.angle)*p.dist*.5;
        ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI*2);
        ctx.fillStyle = `hsla(${p.hue},80%,70%,${p.alpha*(.6+.4*Math.sin(t*3+p.angle))})`; ctx.fill();
      }

      // Ícone
      const sc = 1+.06*Math.sin(t*2.5);
      ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc);
      ctx.font = `${clamp(38, H*.09, 68)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚙️', 0, 0); ctx.restore();

      // Texto
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${clamp(14, W*.028, 24)}px Inter,sans-serif`;
      const g = ctx.createLinearGradient(W*.25, 0, W*.75, 0);
      g.addColorStop(0, '#a78bfa'); g.addColorStop(1, '#06b6d4');
      ctx.fillStyle = g;
      const dots = '.'.repeat(1+Math.floor(t*2)%3);
      ctx.fillText(`Criando seu jogo${dots}`, cx, H*.68);

      if (gerandoSt.statusTexto) {
        ctx.font = `400 ${clamp(11, W*.018, 14)}px Inter,sans-serif`;
        ctx.fillStyle = 'rgba(148,163,184,.8)';
        ctx.fillText(gerandoSt.statusTexto.slice(0, 58), cx, H*.68+clamp(24, H*.05, 36));
      }

      t += 1/60;
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    return gerandoSt;
  }

  function pararGerando() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function setStatus(texto) { if (gerandoSt) gerandoSt.statusTexto = texto; }

  return { iniciarGerando, pararGerando, setStatus };
})();

// ====================================================================
// 5. ConversationEngine
// ====================================================================
const ConversationEngine = (() => {
  const PERGUNTAS = [
    {
      id: 'descricao',
      texto: 'Olá! 👋 Que tipo de jogo você quer criar? Me conta a sua ideia!',
      placeholder: 'Ex: um jogo de plataforma com aliens, estilo retrô...',
      opcional: false,
    },
    {
      id: 'detalhes',
      texto: 'Que ideia incrível! 🎮 Algum detalhe especial? Mecânica, visual, história...',
      placeholder: 'Ex: quero power-ups, chefe final, música épica... (pode pular)',
      opcional: true,
    },
  ];

  let etapa = 0;
  const respostas = {};

  function reset() { etapa = 0; Object.keys(respostas).forEach(k => delete respostas[k]); }
  function perguntaAtual() { return PERGUNTAS[etapa] || null; }
  function registrar(id, texto) { if (texto?.trim()) respostas[id] = texto.trim(); }
  function avancar() { etapa++; }
  function terminou() { return etapa >= PERGUNTAS.length; }
  function promptParaGeracao() {
    let p = respostas.descricao || 'crie um jogo legal';
    if (respostas.detalhes) p += '. Detalhes: ' + respostas.detalhes;
    return p;
  }

  return { reset, perguntaAtual, registrar, avancar, terminou, promptParaGeracao };
})();

// ====================================================================
// 6. VoiceInput
// ====================================================================
const VoiceInput = (() => {
  let recorder = null, chunks = [], gravando = false, stream = null;

  async function iniciar() {
    if (gravando) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(100); gravando = true;
  }

  async function parar() {
    return new Promise((resolve, reject) => {
      if (!recorder || !gravando) return resolve(null);
      recorder.onstop = async () => {
        gravando = false;
        stream?.getTracks().forEach(t => t.stop()); stream = null;
        if (!chunks.length) return resolve(null);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          try {
            const b64 = reader.result.split(',')[1];
            const resp = await fetch('/api/transcrever', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: b64, mimeType: blob.type }),
            });
            if (!resp.ok) throw new Error('Falha');
            const d = await resp.json();
            resolve(d.texto || null);
          } catch { resolve(null); }
        };
        reader.readAsDataURL(blob);
      };
      recorder.onerror = reject;
      recorder.stop();
    });
  }

  return { iniciar, parar, estaGravando: () => gravando };
})();

// ====================================================================
// 7. GeneratorEngine
// ====================================================================
const GeneratorEngine = (() => {
  let projetoId = null;

  async function criarProjeto() {
    const resp = await fetch('/api/projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'phaser2d' }),
    });
    if (!resp.ok) throw new Error(`Erro ao criar projeto: ${resp.status}`);
    projetoId = (await resp.json()).projetoId;
    return projetoId;
  }

  async function* gerarJogo(pedido) {
    if (!projetoId) throw new Error('Projeto não criado');
    const resp = await fetch(`/api/chat/${projetoId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedido }),
    });
    if (!resp.ok) throw new Error(`Erro no chat: ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const linhas = buf.split('\n'); buf = linhas.pop();
      for (const l of linhas) {
        if (!l.trim()) continue;
        try { yield JSON.parse(l); } catch {}
      }
    }
  }

  return { criarProjeto, gerarJogo, getProjetoId: () => projetoId };
})();

// ====================================================================
// 8. Exporter
// ====================================================================
const Exporter = (() => {
  let recorder = null, chunks = [], gravando = false;

  function iniciar(canvas) {
    if (gravando || !canvas) return;
    chunks = [];
    const stream = canvas.captureStream(30);
    const mime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(100); gravando = true;
  }

  async function exportar() {
    if (!recorder || !gravando) return null;
    return new Promise(res => {
      recorder.onstop = () => {
        gravando = false;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `togag-${Date.now()}.webm`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        res(blob);
      };
      recorder.stop();
    });
  }

  return { iniciar, exportar, estaGravando: () => gravando };
})();

// ====================================================================
// 9. App — orquestrador principal
// ====================================================================
const App = (() => {
  const $ = id => document.getElementById(id);

  // ---- Toast ---------------------------------------------------------
  let toastTimer;
  function toast(msg, ms = 2800) {
    const el = $('toast'); if (!el) return;
    el.textContent = msg; el.classList.add('visivel');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visivel'), ms);
  }

  // ---- Progresso -----------------------------------------------------
  function progresso(pct) {
    const f = $('progress-fill'); if (!f) return;
    f.style.width = `${Math.round(pct * 100)}%`;
  }

  // ---- Chat ----------------------------------------------------------
  function adicionarMsgIA(texto) {
    const hist = $('chat-history'); if (!hist) return;
    hist.querySelector('.typing-msg')?.remove();
    const div = document.createElement('div');
    div.className = 'chat-msg ia';
    div.innerHTML = `<div class="msg-avatar">🤖</div><div class="msg-bubble">${escapeHtml(texto)}</div>`;
    hist.appendChild(div); hist.scrollTop = hist.scrollHeight;
  }

  function adicionarMsgUser(texto) {
    const hist = $('chat-history'); if (!hist) return;
    const div = document.createElement('div');
    div.className = 'chat-msg user';
    div.innerHTML = `<div class="msg-avatar">😊</div><div class="msg-bubble">${escapeHtml(texto)}</div>`;
    hist.appendChild(div); hist.scrollTop = hist.scrollHeight;
  }

  function adicionarEvento(texto) {
    const hist = $('chat-history'); if (!hist) return;
    const div = document.createElement('div');
    div.className = 'gen-event'; div.textContent = texto;
    hist.appendChild(div); hist.scrollTop = hist.scrollHeight;
    CanvasRenderer.setStatus(texto);
  }

  function mostrarTyping() {
    const hist = $('chat-history'); if (!hist) return;
    const div = document.createElement('div');
    div.className = 'chat-msg ia typing-msg';
    div.innerHTML = `<div class="msg-avatar">🤖</div>
      <div class="msg-bubble"><div class="typing-indicator">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
      </div></div>`;
    hist.appendChild(div); hist.scrollTop = hist.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  }

  // ---- Input ---------------------------------------------------------
  function habilitarInput(ok, placeholder = '') {
    const inp = $('user-input'), send = $('btn-send'), mic = $('btn-mic'), skip = $('btn-skip');
    if (inp)  { inp.disabled = !ok; if (placeholder) inp.placeholder = placeholder; }
    if (send) send.disabled = !ok;
    if (mic)  mic.disabled  = !ok;
    if (skip) skip.style.display = ok ? '' : 'none';
  }

  function mostrarPainel(show) {
    $('chat-panel')?.classList.toggle('oculto', !show);
  }

  // ---- Fluxo ---------------------------------------------------------
  async function iniciar() {
    FSM.ir('WELCOME');
    AudioEngine.habilitar();
    CapivaraEngine.init();

    const wel = $('welcome-screen');
    wel.classList.add('saindo');
    setTimeout(() => { wel.style.display = 'none'; }, 700);

    FSM.ir('INTRO');
    progresso(0.04);

    // Saudação inicial com vídeo da capivara falando
    await AudioEngine.falar('Bem-vindo ao togag, o criador de jogos com inteligência artificial!');

    await sleep(400);
    iniciarConversa();
  }

  async function iniciarConversa() {
    FSM.ir('CONVERSA');
    ConversationEngine.reset();
    mostrarPainel(true);
    progresso(0.1);

    // Inicia gravação do canvas de geração (usado depois)
    const canvasGen = $('canvas-gen');
    if (canvasGen && !Exporter.estaGravando()) Exporter.iniciar(canvasGen);

    const hist = $('chat-history');
    if (hist) hist.innerHTML = '';

    await fazerProximaPergunta();
  }

  async function fazerProximaPergunta() {
    const p = ConversationEngine.perguntaAtual();
    if (!p) { await iniciarGeracao(); return; }

    habilitarInput(false);
    mostrarTyping();
    await sleep(600);

    adicionarMsgIA(p.texto);

    // Fala sincronizada com o vídeo da capivara
    AudioEngine.falar(p.texto);

    habilitarInput(true, p.placeholder);

    const skip = $('btn-skip');
    if (skip) skip.style.display = p.opcional ? '' : 'none';

    const inp = $('user-input');
    if (inp) { inp.value = ''; inp.focus(); autoResize(inp); }
  }

  async function enviarResposta(texto) {
    texto = texto.trim();
    const p = ConversationEngine.perguntaAtual();
    if (!p) return;

    adicionarMsgUser(texto || '(pulou)');
    if (texto) ConversationEngine.registrar(p.id, texto);

    habilitarInput(false);
    ConversationEngine.avancar();

    if (ConversationEngine.terminou()) {
      await sleep(400);
      await iniciarGeracao();
    } else {
      await sleep(500);
      await fazerProximaPergunta();
    }
  }

  async function iniciarGeracao() {
    FSM.ir('GERANDO');
    progresso(0.2);
    habilitarInput(false);

    // Fala de transição
    adicionarMsgIA('🚀 Perfeito! Vou criar seu jogo agora...');
    await AudioEngine.falar('Perfeito! Deixa eu criar o seu jogo agora!');

    await sleep(600);

    // Esconde input, mostra só histórico
    const inputArea = $('input-area');
    if (inputArea) inputArea.style.display = 'none';
    $('btn-skip')?.style && ($('btn-skip').style.display = 'none');

    // Ativa canvas de geração por cima do vídeo
    const cgDiv = $('canvas-gerando');
    const canvasGen = $('canvas-gen');
    if (cgDiv) cgDiv.classList.add('ativo');
    if (canvasGen) CanvasRenderer.iniciarGerando(canvasGen);

    progresso(0.25);
    const prompt = ConversationEngine.promptParaGeracao();

    try {
      const pid = await GeneratorEngine.criarProjeto();
      progresso(0.3);
      let step = 0;

      for await (const evento of GeneratorEngine.gerarJogo(prompt)) {
        step++;
        progresso(0.3 + Math.min(step / 20, 0.65));

        if (evento.tipo === 'status') {
          adicionarEvento(evento.texto || '');
        } else if (evento.tipo === 'passo') {
          const l = evento.etapa || evento.ferramenta || '';
          if (l) adicionarEvento(l);
        } else if (evento.tipo === 'concluido') {
          await mostrarFinal(pid, evento); return;
        } else if (evento.tipo === 'erro') {
          throw new Error(evento.texto || 'Erro na geração');
        }
      }
      await mostrarFinal(pid, {});

    } catch (e) {
      console.error('[App] Geração falhou:', e);
      adicionarMsgIA(`❌ ${e.message}. Tente novamente.`);
      AudioEngine.falar('Ops, algo deu errado. Tente novamente.');
      toast('❌ ' + e.message, 5000);
      progresso(0);

      CanvasRenderer.pararGerando();
      $('canvas-gerando')?.classList.remove('ativo');

      setTimeout(() => {
        if (inputArea) inputArea.style.display = '';
        FSM.ir('CONVERSA');
        habilitarInput(true, 'Tente descrever seu jogo novamente...');
      }, 3000);
    }
  }

  async function mostrarFinal(projetoId, evento) {
    FSM.ir('FINAL');
    progresso(1);
    CanvasRenderer.pararGerando();
    AudioEngine.parar();
    mostrarPainel(false);

    // Remove canvas de geração
    $('canvas-gerando')?.classList.remove('ativo');

    const final = $('final-screen');
    if (!final) return;

    final.innerHTML = `
      <div class="final-emoji">🎮</div>
      <h1 class="final-title">Seu jogo está pronto!</h1>
      <p class="final-summary">${evento.resumo || 'A IA criou seu jogo com base nas suas ideias.'} Clique em jogar agora para experimentar!</p>
      <div class="final-actions">
        <button class="btn-final primario" id="btn-jogar">▶ Jogar agora</button>
        <button class="btn-final secundario" id="btn-recomecar">↩ Criar outro jogo</button>
      </div>
    `;
    final.classList.add('ativo');

    await AudioEngine.falar('Seu jogo está pronto! Clique em jogar agora para experimentar!');

    $('btn-jogar')?.addEventListener('click', () => { window.location.href = `/jogar?id=${projetoId}`; });
    $('btn-recomecar')?.addEventListener('click', () => { final.classList.remove('ativo'); setTimeout(() => location.reload(), 300); });
  }

  // ---- Voz -----------------------------------------------------------
  async function toggleVoz() {
    const mic = $('btn-mic');
    if (VoiceInput.estaGravando()) {
      mic?.classList.remove('ativo');
      toast('⏳ Transcrevendo...');
      const texto = await VoiceInput.parar();
      if (texto) {
        const inp = $('user-input');
        if (inp) { inp.value = texto; autoResize(inp); inp.focus(); }
        toast('✅ ' + texto.slice(0, 40) + (texto.length > 40 ? '…' : ''));
      } else {
        toast('❌ Não entendi. Tente digitar.');
      }
    } else {
      try {
        await VoiceInput.iniciar();
        mic?.classList.add('ativo');
        toast('🎤 Gravando... clique para parar');
      } catch (e) {
        toast('❌ ' + e.message);
      }
    }
  }

  // ---- Exportar -------------------------------------------------------
  async function exportar() {
    const btn = $('btn-exportar');
    if (!Exporter.estaGravando()) { toast('⏺ Nenhuma gravação ativa.'); return; }
    if (btn) { btn.innerHTML = '<span>⏳...</span>'; btn.disabled = true; }
    try {
      await Exporter.exportar();
      toast('✅ Download iniciado!');
    } catch (e) {
      toast('❌ ' + e.message);
    } finally {
      if (btn) { btn.innerHTML = '<span>⬇ Exportar</span>'; btn.disabled = false; }
    }
  }

  // ---- Utils ---------------------------------------------------------
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

  function criarParticulas() {
    const cont = document.querySelector('.welcome-particles'); if (!cont) return;
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left = `${Math.random()*100}%`;
      p.style.width = p.style.height = `${1+Math.random()*3}px`;
      p.style.animationDuration = `${4+Math.random()*8}s`;
      p.style.animationDelay = `${Math.random()*6}s`;
      p.style.background = `hsl(${240+Math.random()*60},80%,70%)`;
      cont.appendChild(p);
    }
  }

  // ---- Boot ----------------------------------------------------------
  function boot() {
    criarParticulas();

    $('btn-iniciar')?.addEventListener('click', iniciar);

    $('btn-send')?.addEventListener('click', () => {
      const inp = $('user-input');
      const txt = inp?.value?.trim() || '';
      if (!txt) return;
      inp.value = ''; autoResize(inp);
      enviarResposta(txt);
    });

    $('user-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('btn-send')?.click(); }
    });

    $('user-input')?.addEventListener('input', e => autoResize(e.target));
    $('btn-mic')?.addEventListener('click', toggleVoz);
    $('btn-skip')?.addEventListener('click', () => enviarResposta(''));
    $('btn-exportar')?.addEventListener('click', exportar);

    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => {};
  }

  return { boot };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.boot);
} else {
  App.boot();
}
