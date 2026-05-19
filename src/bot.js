const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Paths are resolved dynamically per-instance via this.dataDir
// These are kept for backward compat if bot is run standalone
const STANDALONE_DATA = path.join(__dirname, '..', 'data', 'bot');

const ADVANCE_WORDS = [
  'sim','não','nao','ok','okay','tá','ta','blz','beleza','certo','entendi',
  'claro','pode','bom','ótimo','otimo','legal','show','top','massa','boa',
  'perfeito','combinado','fechou','quero','vamos','bora','continua','vai',
  'obrigado','obrigada','valeu','vlw','tmj','aham','isso','exato','correto',
  'rs','kkk','haha','rsrs','👍','👏','😊','🙏','✅','💯'
];

let _flowsCache = null;
let _flowsCacheTime = 0;
const FLOWS_CACHE_TTL = 5000; // 5s cache — atualiza rápido quando salvar
function loadFlows() {
  const now = Date.now();
  if (_flowsCache && (now - _flowsCacheTime) < FLOWS_CACHE_TTL) return _flowsCache;
  try {
    _flowsCache = JSON.parse(fs.readFileSync(this.FLOWS_PATH, 'utf8'));
    _flowsCacheTime = now;
    return _flowsCache;
  } catch { return { botName: 'Bot', sysPrompt: '', fallbackAI: true, flows: [] }; }
}
function invalidateFlowsCache() { _flowsCache = null; _flowsCacheTime = 0; }
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); }
  catch { return { totalMessages:0, totalContacts:0, flowHits:{}, dailyMessages:{} }; }
}
function saveStats(s) { try { fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2)); } catch {} }
let _convsCache = null;
let _convsSaveTimer = null;

function loadConversations() {
  if (_convsCache) return _convsCache;
  try { _convsCache = JSON.parse(fs.readFileSync(CONV_PATH, 'utf8')); }
  catch { _convsCache = {}; }
  return _convsCache;
}
function saveConversations(c) {
  _convsCache = c;
  // Write-behind: debounce disk write to avoid blocking event loop on every message
  if (_convsSaveTimer) clearTimeout(_convsSaveTimer);
  _convsSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONV_PATH, JSON.stringify(c, null, 2)); }
    catch(e) { console.error('[BOT] Erro ao salvar conversas:', e.message); }
    _convsSaveTimer = null;
  }, 2000); // escreve no disco no máximo a cada 2s
}
function saveConversationsNow(c) {
  if (_convsSaveTimer) { clearTimeout(_convsSaveTimer); _convsSaveTimer = null; }
  _convsCache = c;
  try { fs.writeFileSync(CONV_PATH, JSON.stringify(c, null, 2)); } catch {}
}

function isUrl(str) { return typeof str === 'string' && (str.startsWith('http://') || str.startsWith('https://')); }
function checkUrl(url) {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, { method:'HEAD', timeout:5000 }, (res) => resolve(res.statusCode >= 200 && res.statusCode < 400));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}
function mediaContent(url) {
  if (isUrl(url)) return { url };
  if (fs.existsSync(url)) return fs.readFileSync(url);
  return null;
}
function getMimeType(url) {
  const ext = (url||'').split('.').pop().toLowerCase();
  const map = { pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip:'application/zip', mp4:'video/mp4', mp3:'audio/mpeg' };
  return map[ext] || 'application/octet-stream';
}
function typingDelay(text) {
  if (!text) return 800;
  return Math.min(Math.max(text.length * 22, 800), 4000) + Math.floor(Math.random() * 500) - 250;
}

// Pausa de 'leitura' antes de começar a digitar — varia por comprimento da msg recebida
function readingPause(incomingText) {
  if (!incomingText) return 1200;
  const len = (incomingText || '').length;
  // Textos curtos: 1-2s | Textos longos (endereço): 2-5s
  const base = Math.min(Math.max(len * 18, 1000), 4500);
  return base + Math.floor(Math.random() * 1500);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function shortJid(jid) { return (jid||'').replace('@s.whatsapp.net','').replace('@lid','').slice(-8); }
function shortText(t, n=40) { return (t||'').substring(0,n).replace(/\n/g,' ') + ((t||'').length>n?'…':''); }

function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')                    // remove emojis/pontuação
    .replace(/\s+/g, ' ')                             // colapsa espaços múltiplos
    .trim();
}
function matchesKeywords(text, keywords) {
  if (!keywords || !keywords.length) return false;
  const t = normalizeText(text);
  return keywords.some(k => {
    const kn = normalizeText(k);
    if (!kn) return false;
    return t === kn || t.includes(kn);
  });
}
function isAdvanceWord(text) {
  const t = text.toLowerCase().trim().replace(/[!.?]+$/, '');
  return ADVANCE_WORDS.some(w => t === w);
}

// Detecta se a IA enviou o link de pagamento — só encerra fluxo se mandou o link real
// Evitar falsos positivos com palavras como "pix" ou "valor" que a IA usa normalmente
function aiMentionedPayment(reply) {
  if (!reply) return false;
  const r = reply.toLowerCase();
  // Só considera encerrado se mandou um link HTTP real (não apenas mencionou pix/valor)
  return r.includes('http://') || r.includes('https://');
}

class WhatsAppBot {
  constructor(io, dataDir) {
    this.io = io;
    this.dataDir = dataDir || STANDALONE_DATA;
    // Ensure data directories exist
    ['rm-media','flow-audio','camp-media','auth'].forEach(d => {
      const p = path.join(this.dataDir, d);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });
    // Per-instance file paths
    this.FLOWS_PATH = path.join(this.dataDir, 'flows.json');
    this.STATS_PATH = path.join(this.dataDir, 'stats.json');
    this.CONV_PATH  = path.join(this.dataDir, 'conversations.json');
    this.CAMP_PATH  = path.join(this.dataDir, 'campaigns.json');
    this.SESS_PATH  = path.join(this.dataDir, 'sessions.json');

    this.sock = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.ai = null;
    this.reconnectAttempts = 0;
    this.userSessions = {};
    this.processingQueue = {};
    this.dashboardSentIds = new Set();
    this.remarketingInProgress = new Set();
    this.remarketingTimer = null;
    this.debounceTimers = {};
    this.pendingMessages = {};
    this.groq = null;
    this.groqAvailable = true;
    this.groqRetryAt = null;
    this.sessionSaveTimer = null;
    this.archivedJids = new Set();
  }

  loadSessions() {
    try {
      const p = this.SESS_PATH;
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        this.userSessions = data || {};
        const count = Object.keys(this.userSessions).length;
        console.log('[BOT] ✓ Sessões restauradas: ' + count + ' leads');
      }
    } catch(e) {
      console.error('[BOT] Erro ao carregar sessões:', e.message);
      this.userSessions = {};
    }
    // Carrega arquivados em memória para lookup instantâneo
    try {
      const convPath = this.CONV_PATH;
      const convs = JSON.parse(fs.readFileSync(convPath, 'utf-8'));
      this.archivedJids = new Set(Object.keys(convs).filter(j => convs[j]?.archived));
      console.log('[BOT] ' + this.archivedJids.size + ' leads arquivados carregados.');
    } catch {}
  }

  saveSessions() {
    try {
      const p = this.SESS_PATH;
      // Remove dados pesados antes de salvar (histórico de IA fica na memória)
      const toSave = {};
      for (const [jid, s] of Object.entries(this.userSessions)) {
        if (!s) continue;
        toSave[jid] = {
          currentFlowIndex: s.currentFlowIndex,
          sentFlowIds: s.sentFlowIds || [],
          finished: s.finished || false,
          started: s.started || false,
          pausedByHuman: s.pausedByHuman || false,
          inAIMode: s.inAIMode || false,
          aiUsagePerFlow: s.aiUsagePerFlow || {},
          remarketingCount: s.remarketingCount || 0,
          lastRemarketingAt: s.lastRemarketingAt || null,
          lastActivity: s.lastActivity || Date.now()
          // Não salva: history (IA), debounce timers, processingQueue
        };
      }
      fs.writeFileSync(p, JSON.stringify(toSave, null, 2));
    } catch(e) {
      console.error('[BOT] Erro ao salvar sessões:', e.message);
    }
  }

  startSessionSaving() {
    // Salva sessões a cada 2 minutos
    this.sessionSaveTimer = setInterval(() => this.saveSessions(), 2 * 60 * 1000);
    console.log('[BOT] Auto-save de sessões ativado (2 em 2 min)');
  }

  initAI() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key && key !== 'sk-ant-SUA_CHAVE_AQUI') {
      this.ai = new Anthropic({ apiKey: key });
    }
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== 'gsk_SUA_CHAVE_GROQ') {
      this.groq = new Groq({ apiKey: groqKey });
      console.log('[BOT] Groq (transcrição de áudio) inicializado');
    }
    return !!this.ai;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.io.emit('bot:status', { status, ...extra });
    const _statusEmoji = {connected:'✓',connecting:'…',disconnected:'✗',qr:'📱'};
    console.log('[BOT] ' + (_statusEmoji[status]||'?') + ' Status: ' + status);
  }

  getSession(jid) {
    if (!this.userSessions[jid]) {
      // Sessão nova
      this.userSessions[jid] = {
        started: false,
        currentFlowIndex: -1,
        sentFlowIds: [],  // IDs dos fluxos já enviados — nunca repetir
        finished: false,
        pausedByHuman: false,
        inAIMode: false,
        aiUsagePerFlow: {},
        history: [],
        remarketingCount: 0,
        lastRemarketingAt: null,
        lastActivity: Date.now()
      };
    } else {
      // Sessão restaurada do disco — garante que todos os campos existem sem sobrescrever dados salvos
      const s = this.userSessions[jid];
      if (s.started === undefined) s.started = false;
      if (s.currentFlowIndex === undefined) s.currentFlowIndex = -1;
      if (!s.sentFlowIds) s.sentFlowIds = [];
      if (s.finished === undefined) s.finished = false;
      if (s.pausedByHuman === undefined) s.pausedByHuman = false;
      if (s.inAIMode === undefined) s.inAIMode = false;
      if (!s.aiUsagePerFlow) s.aiUsagePerFlow = {};
      if (!s.history) s.history = [];
      // ── Remarketing: preserva os valores salvos ──────────────────
      if (s.remarketingCount === undefined) s.remarketingCount = 0;
      if (s.lastRemarketingAt === undefined) s.lastRemarketingAt = null;
      // lastActivity: NÃO sobrescreve — preserva o tempo real da última interação
      // Isso garante que o remarketing continue de onde parou após reiniciar
      if (!s.lastActivity) s.lastActivity = Date.now();
    }
    // Só atualiza lastActivity quando há interação real (chamado por updateActivity)
    return this.userSessions[jid];
  }

  updateActivity(jid) {
    if (this.userSessions[jid]) {
      this.userSessions[jid].lastActivity = Date.now();
    }
  }

  setSession(jid, updates) { Object.assign(this.getSession(jid), updates); }
  resetSession(jid) { delete this.userSessions[jid]; }

  cleanOldSessions() {
    const now = Date.now();
    for (const jid in this.userSessions) {
      if (now - this.userSessions[jid].lastActivity > 2 * 60 * 60 * 1000) delete this.userSessions[jid];
    }
  }

  getActiveFlows(flows) { return flows.filter(f => f.active !== false); }

  // ─── REMARKETING ENGINE ───────────────────────────────────────────────────

  async resumePendingFlows() {
    // Não envia automaticamente — impossível saber se lead está esperando
    // o bot enviar ou esperando o lead responder.
    // O remarketing cuida de reengajar leads inativos.
    const sessions = this.userSessions;
    let count = 0;
    for (const [jid, sess] of Object.entries(sessions)) {
      if (sess && sess.started && !sess.finished && !sess.pausedByHuman) count++;
    }
    console.log('[BOT] ' + count + ' leads com fluxo em andamento restaurados — aguardarão interação ou remarketing.');
  }

  startRemarketingTimer() {
    // Cancela timer anterior se existir (evita duplicatas ao reconectar)
    if (this.remarketingTimer) {
      clearInterval(this.remarketingTimer);
      this.remarketingTimer = null;
    }
    // Delay de segurança: aguarda 2 minutos antes de começar a checar
    // Evita disparo em massa logo ao religar quando leads já passaram do tempo
    const SAFETY_DELAY = 2 * 60 * 1000;
    console.log('[BOT] Remarketing aguardando 2 min antes de iniciar (delay de segurança)...');
    setTimeout(() => {
      this.remarketingTimer = setInterval(() => this.checkRemarketingLeads(), 5 * 60 * 1000);
      console.log('[BOT] Remarketing timer iniciado');
    }, SAFETY_DELAY);
  }

  async checkRemarketingLeads() {
    if (this.status !== 'connected') return;
    try {
      const cfg = loadFlows();
      const rm = cfg.remarketing;
      if (!rm || !rm.enabled) return;

      const delayMs = (rm.delayMinutes || 30) * 60 * 1000;
      const intervalMs = (rm.intervalMinutes || 60) * 60 * 1000;
      const maxMsgs = rm.maxMessages || 3;
      const messages = rm.messages || [];
      if (!messages.length) return;

      const now = Date.now();

      // Coleta leads elegíveis sem bloquear o loop principal
      const rmQueue = [];
      // Usa cache em memória — não lê disco durante o remarketing
      const convs = loadConversations();

      for (const [jid, session] of Object.entries(this.userSessions)) {
        if (
          session.currentFlowIndex !== 0 ||
          session.pausedByHuman ||
          session.finished ||
          session.remarketingCount >= maxMsgs
        ) continue;
        if (this.remarketingInProgress.has(jid)) continue;
        if (this.archivedJids.has(jid)) continue; // check em memória

        const lastActivity = session.lastActivity || 0;
        const timeSinceActivity = now - lastActivity;
        const lastRemarketingAt = session.lastRemarketingAt || 0;
        const timeSinceLastRM = now - lastRemarketingAt;
        const rmCount = session.remarketingCount || 0;

        const shouldSend = rmCount === 0
          ? timeSinceActivity >= delayMs
          : timeSinceLastRM >= intervalMs;

        if (!shouldSend) continue;

        const msg = messages[rmCount];
        if (!msg || (!msg.text && !msg.filename)) continue;

        rmQueue.push({ jid, session, rmCount, msg });
      }

      if (!rmQueue.length) return;

      // Dispara cada lead de forma NÃO bloqueante — event loop livre para mensagens
      const self = this;
      let delay = 0;
      for (const item of rmQueue) {
        const { jid, session, rmCount, msg } = item;
        self.remarketingInProgress.add(jid);
        const lastRemarketingAt = session.lastRemarketingAt || 0;

        setTimeout(async () => {
          try {
            session.remarketingCount = rmCount + 1;
            session.lastRemarketingAt = now;
            self.saveSessions();
            console.log('[REMARKETING] Msg ' + (rmCount+1) + '/' + maxMsgs + ' → ...' + shortJid(jid));

            const msgType = msg.type || 'text';
            if (msgType === 'image' && msg.filename) {
              const imgPath = path.join(this.dataDir, 'rm-media', msg.filename);
              await self.sendImageHuman(jid, imgPath, msg.caption || msg.text || '');
              self.recordMessage(jid, 'bot', '[Imagem] ' + (msg.caption || ''), 'Remarketing ' + (rmCount+1));
            } else if (msgType === 'video' && msg.filename) {
              const vidPath = path.join(this.dataDir, 'rm-media', msg.filename);
              await self.sendVideoHuman(jid, vidPath, msg.caption || msg.text || '');
              self.recordMessage(jid, 'bot', '[Vídeo] ' + (msg.caption || ''), 'Remarketing ' + (rmCount+1));
            } else {
              await self.sendTextHuman(jid, msg.text || '');
              self.recordMessage(jid, 'bot', msg.text || '', 'Remarketing ' + (rmCount+1));
            }
          } catch(e) {
            session.remarketingCount = rmCount;
            session.lastRemarketingAt = lastRemarketingAt || null;
            console.error('[REMARKETING] Erro → ...' + shortJid(jid) + ':', e.message);
          } finally {
            self.remarketingInProgress.delete(jid);
          }
        }, delay);

        delay += 3000; // 3s entre cada lead — não sobrecarrega mas também não bloqueia
      }
    } catch(e) {
      console.error('[REMARKETING] Erro:', e.message);
    }
  }

  pauseForHuman(jid) {
    const s = this.getSession(jid);
    if (!s.pausedByHuman) {
      s.pausedByHuman = true;
      // Para o indicador de digitação imediatamente
      if (this.sock) this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
      // Cancela timer de debounce pendente
      if (this.debounceTimers[jid]) {
        clearTimeout(this.debounceTimers[jid]);
        delete this.debounceTimers[jid];
        delete this.pendingMessages[jid];
      }
      // Cancela fila de processamento
      delete this.processingQueue[jid];
      // Se chegou mensagem enquanto processava, processa agora (sem loop infinito)
      if (this._pendingRetry?.[jid]) {
        const retryText = this._pendingRetry[jid];
        delete this._pendingRetry[jid];
        // Delay de 300ms para evitar race condition
        setTimeout(() => this.processMessage(jid, retryText), 300);
      }
      console.log('[BOT] Atendente assumiu: ...' + shortJid(jid));
      this.io.emit('bot:paused', { jid, contact: jid.replace('@s.whatsapp.net','') });
    }
  }

  resumeForBot(jid) {
    const s = this.getSession(jid);
    s.pausedByHuman = false;
    console.log('[BOT] Bot retomado: ...' + shortJid(jid));
    this.io.emit('bot:resumed', { jid });
  }


  // ─── TRANSCRIÇÃO DE ÁUDIO (GROQ WHISPER) ─────────────────────────────────────

  isGroqAvailable() {
    if (!this.groq) return false;
    if (!this.groqAvailable) {
      // Tenta reativar depois de 1 hora
      if (this.groqRetryAt && Date.now() > this.groqRetryAt) {
        this.groqAvailable = true;
        this.groqRetryAt = null;
        console.log('[BOT] Groq reativado — tentando novamente');
      } else {
        return false;
      }
    }
    return true;
  }

  async transcribeAudio(audioBuffer, mimeType) {
    if (!this.isGroqAvailable()) return null;
    try {
      const { Blob } = require('buffer');
      // Determina extensão pelo mimeType
      const ext = mimeType?.includes('ogg') ? 'ogg' :
                  mimeType?.includes('mp4') ? 'mp4' :
                  mimeType?.includes('mpeg') || mimeType?.includes('mp3') ? 'mp3' :
                  mimeType?.includes('webm') ? 'webm' : 'ogg';

      const file = new File([audioBuffer], 'audio.' + ext, { type: mimeType || 'audio/ogg' });

      const result = await this.groq.audio.transcriptions.create({
        file,
        model: 'whisper-large-v3-turbo',
        language: 'pt',
        response_format: 'text'
      });

      const text = typeof result === 'string' ? result.trim() : result?.text?.trim();
      // transcrito — log único abaixo
      return text || null;
    } catch(e) {
      const msg = e?.message || '';
      const status = e?.status || e?.error?.status || 0;

      if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('exceeded')) {
        this.groqAvailable = false;
        this.groqRetryAt = Date.now() + 60 * 60 * 1000; // tenta de novo em 1 hora
        console.log('[BOT] Groq limite atingido — transcrição pausada por 1h. Áudios serão ignorados.');
        return null;
      }

      if (status === 503 || msg.includes('unavailable') || msg.includes('timeout')) {
        // Erro temporário — tenta de novo em 5 minutos
        this.groqRetryAt = Date.now() + 5 * 60 * 1000;
        this.groqAvailable = false;
        console.log('[BOT] Groq indisponível temporariamente — tentando em 5min');
        return null;
      }

      console.error('[BOT] Erro Groq (silencioso):', msg.substring(0, 100));
      return null;
    }
  }

  // ─── ENVIO HUMANIZADO ──────────────────────────────────────────────────────

  async sendTyping(jid, ms) {
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      await sleep(ms);
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch {}
  }
  async sendTextHuman(jid, text, incomingText) {
    if (!text || !this.sock) return;
    // Verifica interceptação imediatamente antes de enviar
    const _sc = this.getSession(jid);
    if (_sc.pausedByHuman || this.archivedJids.has(jid)) return;
    try {
      // 1. Aparece como 'online' / lendo
      await this.sock.sendPresenceUpdate('available', jid);

      // 2. Pausa de leitura — simula tempo lendo a mensagem do lead
      const readMs = readingPause(incomingText || text);
      await sleep(readMs);

      // 3. Pequena pausa adicional aleatória antes de começar a digitar
      await sleep(300 + Math.floor(Math.random() * 700));

      // 4. Aparece 'digitando...'
      await this.sock.sendPresenceUpdate('composing', jid);

      // 5. Tempo digitando proporcional ao tamanho da resposta
      await sleep(typingDelay(text));

      // 6. Envia e para de digitar
      await this.sock.sendPresenceUpdate('paused', jid);
      await this.sock.sendMessage(jid, { text });
      await sleep(350);
    } catch {}
  }
  async sendImageHuman(jid, url, caption) {
    if (!this.sock || !url) return;
    try {
      const content = mediaContent(url);
      if (!content) return;
      if (isUrl(url) && !(await checkUrl(url))) { if (caption) await this.sendTextHuman(jid, caption); return; }
      await this.sock.sendPresenceUpdate('available', jid);
      await sleep(readingPause() + 400);
      await this.sendTyping(jid, 1200);
      await this.sock.sendMessage(jid, { image: content, caption: caption || '' });
      await sleep(400);
    } catch {}
  }
  async sendVideoHuman(jid, url, caption) {
    if (!this.sock || !url) return;
    try {
      const content = mediaContent(url);
      if (!content) return;
      if (isUrl(url) && !(await checkUrl(url))) { if (caption) await this.sendTextHuman(jid, caption); return; }
      await this.sock.sendPresenceUpdate('available', jid);
      await sleep(readingPause() + 400);
      await this.sendTyping(jid, 1400);
      await this.sock.sendMessage(jid, { video: content, caption: caption || '', mimetype: 'video/mp4' });
      await sleep(400);
    } catch {}
  }
  async sendAudioPTT(jid, audioUrl) {
    // Envia áudio como PTT (Push to Talk) — aparece igual a mensagem de voz gravada
    if (!this.sock || !audioUrl) return;
    try {
      let audioBuffer;
      if (audioUrl.startsWith('/flow-audio/')) {
        // Arquivo local
        const fpath = path.join(this.dataDir, 'flow-audio', path.basename(audioUrl));
        audioBuffer = fs.readFileSync(fpath);
      } else {
        // URL externa
        const https = require('https');
        const http = require('http');
        const lib = audioUrl.startsWith('https') ? https : http;
        audioBuffer = await new Promise((res, rej) => {
          lib.get(audioUrl, (r) => {
            const chunks = [];
            r.on('data', d => chunks.push(d));
            r.on('end', () => res(Buffer.concat(chunks)));
            r.on('error', rej);
          });
        });
      }

      // Simula presença de "gravando audio" antes de enviar
      await this.sock.sendPresenceUpdate('recording', jid);
      // Delay proporcional ao tamanho do áudio (~1s a cada 10KB, mínimo 2s, máximo 12s)
      const recordDelay = Math.min(12000, Math.max(2000, Math.floor(audioBuffer.length / 10000) * 1000));
      await sleep(recordDelay + Math.floor(Math.random() * 1500));
      await this.sock.sendPresenceUpdate('paused', jid);
      await sleep(300 + Math.floor(Math.random() * 400));

      // Verifica se ainda pode enviar
      const sess = this.getSession(jid);
      if (sess.pausedByHuman || this.archivedJids.has(jid)) return;

      await this.sock.sendMessage(jid, {
        audio: audioBuffer,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus'
      });
    } catch(e) {
      console.error('[BOT] Erro ao enviar áudio PTT:', e.message);
    }
  }

  async sendDocumentHuman(jid, url, filename, caption, mimetype) {
    if (!this.sock || !url) return;
    try {
      const content = mediaContent(url);
      if (!content) return;
      if (isUrl(url) && !(await checkUrl(url))) { if (caption) await this.sendTextHuman(jid, caption); return; }
      await this.sendTyping(jid, 1000);
      await this.sock.sendMessage(jid, { document: content, fileName: filename || 'arquivo', mimetype: mimetype || getMimeType(url), caption: caption || '' });
      await sleep(400);
    } catch {}
  }
  async sendBlocks(jid, blocks) {
    if (!this.sock || !blocks?.length) return;
    for (const b of blocks) {
      try {
        if (b.type === 'text' && b.text) await this.sendTextHuman(jid, b.text);
        else if (b.type === 'image' && b.url) await this.sendImageHuman(jid, b.url, b.caption);
        else if (b.type === 'video' && b.url) await this.sendVideoHuman(jid, b.url, b.caption);
        else if (b.type === 'audio' && b.url) await this.sendAudioPTT(jid, b.url);
        else if (b.type === 'document' && b.url) await this.sendDocumentHuman(jid, b.url, b.filename, b.caption, b.mimetype);
        else if (b.type === 'pix') await this.sendPixButton(jid, cfg.pixKey || b.pixKey || '', b.text);
      } catch {}
    }
  }


  // PIX BUTTON
  async sendPixButton(jid, pixKey, caption) {
    if (!this.sock) return;
    if (!pixKey) {
      console.error('[BOT] PIX: chave não configurada! Vá em Configurações → Chave PIX e cadastre.');
      // Envia aviso apenas para não deixar o fluxo travar
      await this.sendTextHuman(jid, caption || 'Aguarde, estamos preparando o pagamento...');
      return;
    }
    try {
      // Leitura + digitação humana
      await this.sock.sendPresenceUpdate('available', jid);
      await sleep(1500 + Math.floor(Math.random() * 1000));
      await this.sendTyping(jid, 1200);

      // 1. Texto introdutório (se tiver)
      if (caption) {
        await this.sock.sendMessage(jid, { text: caption });
        await sleep(800);
      }

      // 2. Chave PIX destacada (monospace no WhatsApp = fácil de copiar)
      await this.sendTyping(jid, 800);
      await this.sock.sendMessage(jid, { text: pixKey });
      await sleep(600);

      // 3. Instrução de como copiar
      await this.sendTyping(jid, 700);
      await this.sock.sendMessage(jid, { text: '👆 Segure a mensagem com a chave acima e toque em *Copiar*' });
    } catch(e) {
      console.error('[BOT] sendPixButton error:', e.message);
    }
  }
  // Método público para enviar mensagem de qualquer tipo (usado pelo dashboard)
  async sendFromDashboard(jid, payload, skipPause = false) {
    if (!this.sock) throw new Error('Bot não conectado');
    if (!payload) throw new Error('Payload vazio');
    const type = payload.type || 'text';
    const text = payload.text || '';
    const url = payload.url || '';
    const caption = payload.caption || '';
    const filename = payload.filename || 'arquivo';
    const mimetype = payload.mimetype || payload.buffermime || 'application/octet-stream';
    const buffer = payload.buffer || null;
    let sentKey = null;
    if (type === 'text') {
      if (!text.trim()) throw new Error('Texto vazio');
      const result = await this.sock.sendMessage(jid, { text: String(text) });
      sentKey = result?.key?.id;
    } else if (type === 'image') {
      const content = buffer ? Buffer.from(buffer, 'base64') : (url ? { url: String(url) } : null);
      if (!content) throw new Error('Imagem sem conteúdo');
      await this.sock.sendMessage(jid, { image: content, caption: String(caption) });
    } else if (type === 'video') {
      const content = buffer ? Buffer.from(buffer, 'base64') : (url ? { url: String(url) } : null);
      if (!content) throw new Error('Vídeo sem conteúdo');
      await this.sock.sendMessage(jid, { video: content, caption: String(caption), mimetype: 'video/mp4' });
    } else if (type === 'document') {
      const content = buffer ? Buffer.from(buffer, 'base64') : (url ? { url: String(url) } : null);
      if (!content) throw new Error('Documento sem conteúdo');
      await this.sock.sendMessage(jid, { document: content, fileName: String(filename), mimetype: String(mimetype), caption: String(caption) });
    } else {
      throw new Error('Tipo de mensagem desconhecido: ' + type);
    }
    if (sentKey) {
      this.dashboardSentIds.add(sentKey);
      setTimeout(() => this.dashboardSentIds.delete(sentKey), 30000);
    }
    // Só pausa o bot se for mensagem manual do atendente (não campanha)
    if (!skipPause) this.pauseForHuman(jid);
  }

  // ─── IA ─────────────────────────────────────────────────────────────────────

  async applyAIDelay(jid) {
    try {
      const cfg = loadFlows();
      const delaySec = cfg.aiResponseDelay || 0;
      if (delaySec <= 0) return;
      const ms = delaySec * 1000 + Math.floor(Math.random() * delaySec * 300);
      if (ms > 10000) console.log('[BOT] AI delay: ' + Math.round(ms/1000) + 's');
      await this.sock.sendPresenceUpdate('composing', jid);
      // Verifica pausedByHuman a cada 500ms durante o delay — detecta interceptação imediata
      const steps = Math.ceil(ms / 500);
      for (let i = 0; i < steps; i++) {
        const sess = this.getSession(jid);
        if (sess.pausedByHuman || this.archivedJids.has(jid)) {
          await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
          return; // aborta imediatamente
        }
        await sleep(Math.min(500, ms - i * 500));
      }
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch {}
  }

  async _callAI(sysPrompt, history) {
    const _aiTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('IA timeout')), 25000));
    return Promise.race([this.ai.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: sysPrompt,
      messages: history
    }), _aiTimeout]);
  }

  async getAIResponse(userMsg, context, jid) {
    if (!this.ai) return null;
    try {
      const cfg = loadFlows();
      const session = this.getSession(jid);
      session.history.push({ role:'user', content: userMsg });
      if (session.history.length > 14) session.history = session.history.slice(-14);
      const sysPrompt = cfg.sysPrompt + (context ? '\n\n' + context : '') + '\n\nIMPORTANTE: Responda de forma curta e direta, máximo 2-3 frases.';

      let res = null;
      let attempts = 0;
      while (attempts < 2) {
        try {
          res = await this._callAI(sysPrompt, session.history);
          break; // sucesso
        } catch(e) {
          attempts++;
          const is500 = e.message?.includes('500') || e.message?.includes('Internal server');
          if (is500 && attempts < 2) {
            await new Promise(r => setTimeout(r, 2000)); // aguarda 2s antes de retry
            continue;
          }
          if (!e.message?.includes('IA timeout')) console.error('[BOT] AI error:', e.message);
          return null;
        }
      }

      const reply = res?.content?.[0]?.text || null;
      if (!reply) return null;
      session.history.push({ role:'assistant', content: reply });
      return reply;
    } catch(e) {
      if (!e.message?.includes('IA timeout')) console.error('[BOT] AI error:', e.message);
      return null;
    }
  }

  // ─── REGISTRO ───────────────────────────────────────────────────────────────

  recordMessage(jid, role, text, flowName) {
    try {
      const convs = loadConversations();
      if (!convs[jid]) convs[jid] = { contact: jid.replace('@s.whatsapp.net',''), messages:[], lastSeen:null };
      convs[jid].messages.push({ role, text: (text||'').substring(0,500), time: new Date().toISOString(), flow: flowName||null });
      // Máx 150 msgs por lead — evita crescimento infinito
      if (convs[jid].messages.length > 150) convs[jid].messages = convs[jid].messages.slice(-150);
      convs[jid].lastSeen = new Date().toISOString();
      if (convs[jid].messages.length > 100) convs[jid].messages = convs[jid].messages.slice(-100);
      this._pendingConvs = convs;
      saveConversations(convs);
      const stats = loadStats();
      stats.totalMessages = (stats.totalMessages||0) + 1;
      stats.totalContacts = Object.keys(convs).length;
      const today = new Date().toISOString().slice(0,10);
      stats.dailyMessages = stats.dailyMessages||{};
      stats.dailyMessages[today] = (stats.dailyMessages[today]||0) + 1;
      if (flowName) { stats.flowHits = stats.flowHits||{}; stats.flowHits[flowName] = (stats.flowHits[flowName]||0) + 1; }
      this._pendingStats = stats;
      saveStats(stats);
      // Não emite no dashboard se o lead estiver arquivado
      const _convs2 = convs || {};
      if (!_convs2[jid]?.archived) {
        this.io.emit('message:new', { jid, role, text: (text||'').substring(0,200), time: new Date().toISOString(), flow: flowName });
      }
      this.io.emit('stats:update', stats);
    } catch {}
  }

  // ─── EXECUTA FLUXO ──────────────────────────────────────────────────────────

  async executeFlowAt(jid, flow, index) {
    if (!flow) return;
    try {
      const session = this.getSession(jid);

      // Nunca enviar se lead estiver pausado ou arquivado
      if (session.pausedByHuman) {
        // silencioso — lead pausado
        return;
      }
      if (this.archivedJids.has(jid)) {
        // silencioso — lead arquivado
        return;
      }

      // ── Nunca repetir fluxo já enviado ──────────────────────────────────
      if (!session.sentFlowIds) session.sentFlowIds = [];
      if (session.sentFlowIds.includes(flow.id)) {
        console.log('[BOT] Fluxo "' + flow.name + '" já enviado — pulando para próximo');
        // Tenta avançar para o próximo fluxo não enviado
        const cfg = loadFlows();
        const active = this.getActiveFlows(cfg.flows || []);
        const nextUnsent = active.find((f, i) => i > index && !session.sentFlowIds.includes(f.id));
        if (nextUnsent) {
          const nextIdx = active.indexOf(nextUnsent);
          await this.executeFlowAt(jid, nextUnsent, nextIdx);
        } else {
          // Todos os fluxos já foram enviados — IA assume
          session.inAIMode = true;
          console.log('[BOT] Todos os fluxos concluídos — IA assumiu: ...' + shortJid(jid));
        }
        return;
      }

      session.currentFlowIndex = index;
      session.inAIMode = false;
      // Reset remarketing ao avançar no fluxo
      if (index > 0) { session.remarketingCount = 0; session.lastRemarketingAt = null; }
      // Garante estrutura de contagem de IA
      if (!session.aiUsagePerFlow) session.aiUsagePerFlow = {};
      session.sentFlowIds.push(flow.id);

      // Delay humanizado antes de enviar (configurável por fluxo)
      if (flow.delayBefore && flow.delayBefore > 0) {
        const minMs = flow.delayBefore * 1000;
        const variation = minMs * 0.3;
        const totalMs = minMs + Math.floor(Math.random() * variation * 2) - variation;
        console.log('[BOT] Aguardando ' + Math.round(totalMs/1000) + 's antes de: ' + flow.name);
        // Mantém "online" durante a espera
        const iv = setInterval(async () => { try { await this.sock.sendPresenceUpdate('available', jid); } catch {} }, 20000);
        await sleep(totalMs);
        clearInterval(iv);
        // Pausa extra simulando início da digitação
        await sleep(800 + Math.floor(Math.random() * 1800));
      }

      await this.sendBlocks(jid, flow.blocks || []);
      const replyText = (flow.blocks||[]).filter(b => b.type==='text').map(b => b.text).join('\n');
      this.recordMessage(jid, 'bot', replyText || '[mídia]', flow.name);
      // Notifica dashboard para atualizar CRM em tempo real
      this.io.emit('crm:lead_moved', { jid, flowIndex: index, flowName: flow.name });
    } catch(e) { console.error('[BOT] executeFlowAt error:', e.message); }
  }


  // Verifica se pode usar IA nesta etapa (respeita aiLimit do fluxo)
  // Retorna true se pode, false se atingiu o limite
  canUseAI(jid, flowId, aiLimit) {
    // aiLimit = 0 ou undefined = sem limite
    if (!aiLimit || aiLimit <= 0) return true;
    const session = this.getSession(jid);
    if (!session.aiUsagePerFlow) session.aiUsagePerFlow = {};
    const used = session.aiUsagePerFlow[flowId] || 0;
    return used < aiLimit;
  }

  // Incrementa o contador de uso de IA para esta etapa
  incrementAIUsage(jid, flowId) {
    const session = this.getSession(jid);
    if (!session.aiUsagePerFlow) session.aiUsagePerFlow = {};
    session.aiUsagePerFlow[flowId] = (session.aiUsagePerFlow[flowId] || 0) + 1;
    return session.aiUsagePerFlow[flowId];
  }

  // Retorna o fluxo atual ativo do lead
  getCurrentFlow(session, activeFlows) {
    if (session.currentFlowIndex < 0 || session.currentFlowIndex >= activeFlows.length) return null;
    return activeFlows[session.currentFlowIndex];
  }

  // ─── PROCESSAMENTO PRINCIPAL ────────────────────────────────────────────────

  async processMessage(jid, text) {
    if (this.processingQueue[jid]) {
      // Já está processando — agenda retry único para não perder o lead
      if (!this._pendingRetry) this._pendingRetry = {};
      // Acumula ao invés de sobrescrever
      this._pendingRetry[jid] = (this._pendingRetry[jid] ? this._pendingRetry[jid] + '\n' : '') + text;
      return;
    }
    this.processingQueue[jid] = true;
    try {
      const cfg = loadFlows();
      const flows = cfg.flows || [];
      const active = this.getActiveFlows(flows);
      const session = this.getSession(jid);
      const t = text.toLowerCase().trim();

      this.updateActivity(jid); // atualiza lastActivity só quando há mensagem real
      this.recordMessage(jid, 'user', text, null);

      // ── Nunca responder a leads arquivados (check em memória = instantâneo) ──
      if (this.archivedJids.has(jid)) {
        // silencioso — lead arquivado ignorado
        return;
      }

      // ── Palavras que pausam a IA ──────────────────────────────────────
      const aiPauseWords = (cfg.aiPauseWords || []).map(function(w){ return w.toLowerCase().trim(); });
      if (aiPauseWords.length) {
        const tLow = text.toLowerCase().trim();
        if (aiPauseWords.some(function(w){ return tLow === w || tLow.includes(w); })) {
          this.pauseForHuman(jid);
          console.log('[BOT] Palavra de pausa detectada — pausando: "' + shortText(text) + '"');
          return;
        }
      }

      // ── Lead finalizou o fluxo → continua com IA livre ───────────────
      if (session.finished) {
        if (this.ai && !session.pausedByHuman) {
          // Pós-fluxo sem limite (aiLimit não se aplica)
          await this.applyAIDelay(jid);
          if (session.pausedByHuman) return;
          const replyPF = await this.getAIResponse(text, '', jid);
          if (!session.pausedByHuman && replyPF) { await this.sendTextHuman(jid, replyPF); this.recordMessage(jid, 'bot', replyPF, 'IA Pós-Fluxo'); }
          // Já está em finished, não há fluxo para encerrar
        }
        return;
      }

      // ── Pausado por atendente: silêncio ───────────────────────────────
      if (session.pausedByHuman) {
        // silencioso — pausado ignorando mensagem
        return;
      }

      // Horário de atendimento
      if (cfg.workingHours?.enabled) {
        const now = new Date();
        const [sh, sm] = (cfg.workingHours.start||'09:00').split(':').map(Number);
        const [eh, em] = (cfg.workingHours.end||'18:00').split(':').map(Number);
        const cur = now.getHours()*60 + now.getMinutes();
        const isWeekend = now.getDay()===0 || now.getDay()===6;
        if (isWeekend || cur < sh*60+sm || cur > eh*60+em) {
          await this.sendTextHuman(jid, cfg.workingHours.msg || 'Fora do horário de atendimento.');
          return;
        }
      }

      // Reset manual
      const resetWords = ['menu','inicio','início','reiniciar','voltar','/start'];
      if (resetWords.includes(t)) {
        this.resetSession(jid);
        if (active.length > 0) await this.executeFlowAt(jid, active[0], 0);
        this.getSession(jid).started = true;
        return;
      }


      // ════════════════════════════════════════════════════════════════════
      // CASO 1: Primeiro contato
      // ════════════════════════════════════════════════════════════════════
      if (!session.started) {
        // Garante que sentFlowIds existe para novos leads
        if (!session.sentFlowIds) session.sentFlowIds = [];
        if (active.length === 0) return;

        // Tenta bater com qualquer fluxo ativo em ordem
        let startFlow = null;
        let startIndex = 0;
        for (let si = 0; si < active.length; si++) {
          const sf = active[si];
          // Sem keywords = qualquer mensagem inicia
          if (!sf.keywords || sf.keywords.length === 0) {
            startFlow = sf; startIndex = si; break;
          }
          if (matchesKeywords(text, sf.keywords)) {
            startFlow = sf; startIndex = si; break;
          }
        }

        if (startFlow) {
          // Keyword bateu — inicia o fluxo
          session.started = true;
          await this.executeFlowAt(jid, startFlow, startIndex);
        } else {
          // Não bateu keyword — IA responde sem iniciar fluxo
          // Lead fica com started=false até mandar a keyword correta
          if (this.ai) {
            await this.applyAIDelay(jid);
            if (session.pausedByHuman || this.archivedJids.has(jid)) return;
            const cfg2 = loadFlows();
            const replyPre = await this.getAIResponse(text, '', jid);
            if (replyPre && !session.pausedByHuman && !this.archivedJids.has(jid)) {
              await this.sendTextHuman(jid, replyPre);
              this.recordMessage(jid, 'bot', replyPre, 'IA Pré-Fluxo');
            }
          }
          // NÃO marca started=true — lead ainda pode mandar a keyword e iniciar o fluxo
        }
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // CASO 2: Lead está em modo IA (respondeu algo fora do fluxo)
      // Verifica se voltou para um fluxo primeiro
      // ════════════════════════════════════════════════════════════════════
      if (session.inAIMode) {
        // Quando a IA assumiu, não avança mais o fluxo automaticamente
        // O lead precisa usar uma palavra de reset (menu/inicio) para recomeçar
        // Continua em modo IA — respeita limite por etapa
        if (session.pausedByHuman) return;
        const curFlow = this.getCurrentFlow(session, active);
        const flowId = curFlow?.id || 'free';
        const aiLimit = curFlow?.aiLimit || 0;
        if (!this.canUseAI(jid, flowId, aiLimit)) {
          console.log('[BOT] Limite de IA atingido para fluxo ' + (curFlow?.name || flowId) + ' — silêncio');
          return;
        }
        await this.applyAIDelay(jid);
        if (session.pausedByHuman) return;
        const reply = await this.getAIResponse(text, '', jid);
        if (!session.pausedByHuman && reply) {
          this.incrementAIUsage(jid, flowId);
          await this.sendTextHuman(jid, reply);
          this.recordMessage(jid, 'bot', reply, 'IA (' + (curFlow?.name || 'livre') + ')');
          // Se a IA mencionou link ou valor, encerra o fluxo para não mandar mais etapas
          if (aiMentionedPayment(reply)) {
            session.finished = true;
            session.inAIMode = false;
            console.log('[BOT] IA mencionou pagamento — fluxo encerrado para ' + jid);
          }
        }
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // CASO 3: Lead em fluxo normal
      // ════════════════════════════════════════════════════════════════════
      if (session.currentFlowIndex >= 0) {

        // Se o lead recebeu remarketing e está respondendo — só IA, sem forçar próxima etapa do fluxo
        if ((session.remarketingCount || 0) > 0 && !session.inAIMode) {
          session.inAIMode = true;
          if (this.ai && !session.pausedByHuman && !this.archivedJids.has(jid)) {
            await this.applyAIDelay(jid);
            if (session.pausedByHuman || this.archivedJids.has(jid)) return;
            const rmReply = await this.getAIResponse(text, '', jid);
            if (rmReply) { await this.sendTextHuman(jid, rmReply); this.recordMessage(jid, 'bot', rmReply, 'IA Remarketing'); }
          }
          return;
        }

        const nextIndex = session.currentFlowIndex + 1;

        // Fim do fluxo — marca como finalizado mas continua com IA
        if (nextIndex >= active.length) {
          session.finished = true;
          // Já responde com IA para esta mensagem
          if (this.ai) {
            await this.applyAIDelay(jid);
            const reply = await this.getAIResponse(text, '', jid);
            if (reply) { await this.sendTextHuman(jid, reply); this.recordMessage(jid, 'bot', reply, 'IA Pós-Fluxo'); }
          }
          return;
        }

        const nextFlow = active[nextIndex];
        const canAdvance = isAdvanceWord(text) || matchesKeywords(text, nextFlow.keywords) ||
          active.slice(0, nextIndex).some(f => matchesKeywords(text, f.keywords));

        if (canAdvance) {
          await this.executeFlowAt(jid, nextFlow, nextIndex);
          return;
        }

        // Não bateu com fluxo → entra em modo IA (resposta curta)
        if (this.ai) {
          session.inAIMode = true;
          if (session.pausedByHuman) return;
          const curFlow2 = this.getCurrentFlow(session, active);
          const flowId2 = curFlow2?.id || 'free';
          const aiLimit2 = curFlow2?.aiLimit || 0;
          if (!this.canUseAI(jid, flowId2, aiLimit2)) {
            console.log('[BOT] Limite de IA atingido para fluxo ' + (curFlow2?.name || flowId2));
            return;
          }
          await this.applyAIDelay(jid);
          if (session.pausedByHuman) return;
          const reply2 = await this.getAIResponse(text, '', jid);
          if (!session.pausedByHuman && reply2) {
            this.incrementAIUsage(jid, flowId2);
            await this.sendTextHuman(jid, reply2);
            this.recordMessage(jid, 'bot', reply2, 'IA (' + (curFlow2?.name || 'livre') + ')');
            // Se a IA mencionou link ou valor, encerra o fluxo para não mandar mais etapas
            if (aiMentionedPayment(reply2)) {
              session.finished = true;
              session.inAIMode = false;
              console.log('[BOT] IA mencionou pagamento — fluxo encerrado para ' + jid);
            }
          }
        }
        // Se não tem IA → silêncio
        return;
      }

    } catch(e) { console.error('[BOT] Erro (silencioso):', e.message); }
    finally {
      await sleep(400);
      delete this.processingQueue[jid];
      // Salva sessões 3s após interação real (preserva remarketing, flowIndex, etc.)
      if (!this._saveDebounce) {
        this._saveDebounce = setTimeout(() => {
          this.saveSessions();
          this._saveDebounce = null;
        }, 3000);
      }
    }
  }

  // ─── START / STOP ────────────────────────────────────────────────────────────

  async start() {
    if (this.status === 'connected') return;
    this.initAI();
    this.setStatus('connecting');
    this.loadSessions();
    this.startSessionSaving();
    setInterval(() => this.cleanOldSessions(), 30 * 60 * 1000);
    this.startRemarketingTimer();

    const { state, saveCreds } = await useMultiFileAuthState(path.join(this.dataDir, 'auth'));
    const { version } = await fetchLatestBaileysVersion();

    // Store para getMessage - evita falha de descriptografia
    const msgStore = {};

    this.sock = makeWASocket({
      version, auth: state,
      printQRInTerminal: false,
      browser: ['Dashboard Bot','Chrome','1.0'],
      getMessage: async (key) => {
        const id = key.id;
        if (msgStore[id]) return msgStore[id];
        return { conversation: '' };
      }
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { this.qrDataUrl = await qrcode.toDataURL(qr); this.setStatus('qr', { qr: this.qrDataUrl }); }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.setStatus('disconnected');
        if (code === DisconnectReason.loggedOut) {
          console.log('[BOT] ✗ Sessão encerrada — reconecte pelo dashboard');
        } else {
          this.reconnectAttempts++;
          // Backoff exponencial: 4s, 8s, 16s, 30s, 30s, 30s...
          const delay = Math.min(4000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
          console.log('[BOT] ⚠ Reconectando em ' + Math.round(delay/1000) + 's (tentativa ' + this.reconnectAttempts + ')');
          setTimeout(() => this.start(), delay);
        }
      }
      if (connection === 'open') { this.reconnectAttempts = 0; this.qrDataUrl = null; this.setStatus('connected'); }
    });

    // Detecta arquivamento/desarquivamento feito no celular
    // Detecta arquivamento pelo celular — Baileys usa 'archive' (não 'archived')
    this.sock.ev.on('chats.update', (updates) => {
      let convs = loadConversations();
      let changed = false;
      for (const update of updates) {
        const jid = update.id;
        if (!jid) continue;
        const isArchived = update.archive ?? update.archived;
        if (typeof isArchived === 'undefined') continue;
        if (!convs[jid]) convs[jid] = { contact: jid.replace('@s.whatsapp.net',''), messages: [], lastSeen: null };
        convs[jid].archived = isArchived === true || isArchived === 1;
        changed = true;
        console.log('[BOT] Chat ...' + shortJid(jid) + (convs[jid].archived ? ' arquivado ✓' : ' desarquivado'));
        // Atualiza cache em memória instantaneamente
        if (convs[jid].archived) {
          this.archivedJids.add(jid);
        } else {
          this.archivedJids.delete(jid);
        }
        this.io.emit('chat:archived', { jid, archived: convs[jid].archived });
      }
      if (changed) saveConversations(convs);
    });

    this.sock.ev.on('chats.set', ({ chats }) => {
      if (!chats || !chats.length) return;
      let convs = loadConversations();
      let changed = false;
      for (const chat of chats) {
        const jid = chat.id;
        if (!jid) continue;
        const isArchived = chat.archive ?? chat.archived;
        if (typeof isArchived === 'undefined') continue;
        if (!convs[jid]) convs[jid] = { contact: jid.replace('@s.whatsapp.net',''), messages: [], lastSeen: null };
        const wasArchived = convs[jid].archived || false;
        const nowArchived = isArchived === true || isArchived === 1;
        if (wasArchived !== nowArchived) {
          convs[jid].archived = nowArchived;
          changed = true;
          if (nowArchived) { this.archivedJids.add(jid); } else { this.archivedJids.delete(jid); }
          this.io.emit('chat:archived', { jid, archived: nowArchived });
        }
      }
      if (changed) saveConversations(convs);
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Armazena para getMessage (retry de descriptografia)
      messages.forEach(msg => {
        if (msg.message && msg.key && msg.key.id) {
          msgStore[msg.key.id] = msg.message;
          const keys = Object.keys(msgStore);
          if (keys.length > 200) delete msgStore[keys[0]];
        }
      });
      if (type !== 'notify') return;
      const now = Math.floor(Date.now() / 1000);
      // type: notify = mensagem nova em tempo real | type: append = histórico/sync
      // CRÍTICO: ignorar append elimina o flood de mensagens antigas ao reconectar
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // Ignora newsletters, grupos e canais (não são conversas de leads)
        if (jid.includes('@newsletter') || jid.includes('@g.us') || jid.includes('@broadcast')) continue;

        const msgTime = msg.messageTimestamp ? parseInt(msg.messageTimestamp) : 0;

        if (msg.key.fromMe) {
          const msgId = msg.key?.id || '';
          if (this.dashboardSentIds.has(msgId)) continue;
          // Só pausa se mensagem é recente (< 90s) — evita falso positivo de retry
          const msgAge = msgTime > 0 ? (now - msgTime) : 0;
          if (msgAge > 90) continue;
          // Detecta qualquer tipo de conteúdo: texto, áudio, imagem, vídeo, sticker
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          const hasMedia = !!(
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.stickerMessage ||
            msg.message?.documentMessage
          );
          const hasContent = (text && text.trim()) || hasMedia;
          if (hasContent) {
            if (text && text.trim()) this.recordMessage(jid, 'human', text.trim(), 'Manual');
            console.log('[BOT] Atendente assumiu (' + (hasMedia ? 'mídia' : 'texto') + '): ...' + shortJid(jid));
            this.pauseForHuman(jid);
          }
          continue;
        }

        // Ignora mensagens de leads arquivados instantaneamente
        if (this.archivedJids.has(jid)) continue;

        // Ignora mensagens de leads com mais de 3 minutos (evita retries antigos)
        if (msgTime > 0 && (now - msgTime) > 180) continue;

        // Extrai texto da mensagem (texto normal)
        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

        // ── ÁUDIO: tenta transcrever com Groq ────────────────────────────
        const audioMsg = msg.message?.audioMessage || msg.message?.ptv; // ptv = audio note
        if (!text && audioMsg && this.isGroqAvailable()) {
          try {
            console.log('[BOT] Áudio recebido — transcrevendo...');
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const audioBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            const mime = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const transcribed = await this.transcribeAudio(audioBuffer, mime);
            if (transcribed) {
              text = transcribed;
              console.log('[BOT] Áudio transcrito: "' + shortText(text, 50) + '"');
            } else {
              console.log('[BOT] Áudio não transcrito (Groq indisponível ou vazio) — ignorando');
              continue;
            }
          } catch(e) {
            console.error('[BOT] Erro ao baixar/transcrever áudio:', e.message);
            continue;
          }
        }

        if (!text?.trim()) continue;


        // ── DEBOUNCE: acumula mensagens e espera parar de digitar ────────
        const cfg = loadFlows();
        const debounceMs = (cfg.messageDebounceSeconds || 4) * 1000;

        if (!this.pendingMessages[jid]) this.pendingMessages[jid] = [];
        this.pendingMessages[jid].push(text.trim());

        // Cancela timer anterior e cria novo
        if (this.debounceTimers[jid]) clearTimeout(this.debounceTimers[jid]);

        this.debounceTimers[jid] = setTimeout(async () => {

          // Junta todas as linhas acumuladas
          const accumulated = this.pendingMessages[jid] || [];
          delete this.pendingMessages[jid];
          delete this.debounceTimers[jid];

          if (!accumulated.length) return;

          // Une as linhas em uma única mensagem (separa por newline)
          const fullMessage = accumulated.join('\n');
          await this.processMessage(jid, fullMessage);
        }, debounceMs);
        // ────────────────────────────────────────────────────────────────
      }
    });
  }

  async stop() {
    this.saveSessions();
    if (this.sessionSaveTimer) clearInterval(this.sessionSaveTimer);
    if (this.sock) { try { await this.sock.logout(); } catch {} this.sock = null; }
    this.userSessions = {};
    this.processingQueue = {};
    this.setStatus('disconnected');
  }
  async disconnect() {
    this.saveSessions();
    if (this.sock) { try { this.sock.end(); } catch {} this.sock = null; }
    this.setStatus('disconnected');
  }
  getSessions() { return this.userSessions; }
  pauseSession(jid) { this.pauseForHuman(jid); }
  resumeSession(jid) { this.resumeForBot(jid); }
}

function _saveAndExit(signal) {
  console.log('[BOT] Sinal ' + signal + ' recebido — salvando tudo...');
  try {
    if (global._botInstance) {
      global._botInstance.saveSessions();
      const stats = global._botInstance._pendingStats;
      if (stats) saveStats(stats);
    }
    // Força gravação imediata das conversas (bypassa debounce)
    if (_convsCache) saveConversationsNow(_convsCache);
    console.log('[BOT] Tudo salvo com sucesso.');
  } catch(e) {
    console.error('[BOT] Erro ao salvar:', e.message);
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT',  () => _saveAndExit('SIGINT'));
process.on('SIGTERM', () => _saveAndExit('SIGTERM'));
process.on('exit', () => {
  try {
    if (global._botInstance) {
      global._botInstance.saveSessions();
      const c = global._botInstance._pendingConvs; if (c) saveConversations(c);
      const s = global._botInstance._pendingStats; if (s) saveStats(s);
    }
  } catch {}
});

module.exports = WhatsAppBot;
