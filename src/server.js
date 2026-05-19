require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer    = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', credentials: true },
});
const PORT   = process.env.PORT || 3000;

// ── Core setup ────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Session ───────────────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'tc-saas-secret-' + Math.random();
const SESSION_DB     = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) + '/sessions.db' : './data/sessions.db';

fs.mkdirSync(path.dirname(SESSION_DB), { recursive: true });

const db = require('./db');

// Custom session store using better-sqlite3 (no extra packages needed)
function makeSQLiteSessionStore(sessionLib) {
  const Store = sessionLib.Store;
  class SQLiteSessionStore extends Store {
    constructor(db) {
      super();
      this.db = db;
      db.exec(`CREATE TABLE IF NOT EXISTS tc_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      )`);
      // cleanup expired sessions every 15 min
      setInterval(() => {
        try { db.prepare('DELETE FROM tc_sessions WHERE expire < ?').run(Date.now()); } catch {}
      }, 15 * 60 * 1000);
    }
    get(sid, cb) {
      try {
        const row = this.db.prepare('SELECT sess FROM tc_sessions WHERE sid=? AND expire>?').get(sid, Date.now());
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch(e) { cb(e); }
    }
    set(sid, sess, cb) {
      try {
        const expire = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7*24*60*60*1000;
        this.db.prepare('INSERT OR REPLACE INTO tc_sessions (sid,sess,expire) VALUES (?,?,?)').run(sid, JSON.stringify(sess), expire);
        cb(null);
      } catch(e) { cb(e); }
    }
    destroy(sid, cb) {
      try { this.db.prepare('DELETE FROM tc_sessions WHERE sid=?').run(sid); cb(null); } catch(e) { cb(e); }
    }
    touch(sid, sess, cb) { this.set(sid, sess, cb); }
  }
  return SQLiteSessionStore;
}

const SQLiteSessionStore = makeSQLiteSessionStore(session);
const sessionStore = new SQLiteSessionStore(db);

const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
  name: 'tc.sid',
});
app.use(sessionMiddleware);

// Share session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// ── Imports ───────────────────────────────────────────────────────────────────
const botManager = require('./bot-manager');
const { requireAuth, requireAdmin } = require('./middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return def; } }
function writeJson(p, d) { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(d,null,2)); }

function getBotPaths(userId) {
  const base = botManager.getUserDataDir(userId);
  return {
    base,
    flows:      path.join(base, 'flows.json'),
    stats:      path.join(base, 'stats.json'),
    conv:       path.join(base, 'conversations.json'),
    camps:      path.join(base, 'campaigns.json'),
    rmMedia:    path.join(base, 'rm-media'),
    flowAudio:  path.join(base, 'flow-audio'),
    campMedia:  path.join(base, 'camp-media'),
  };
}

function getUserBot(userId) {
  return botManager.getInstance(userId, io);
}

// ── Healthcheck ───────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Public static assets ──────────────────────────────────────────────────────
app.use('/static',    express.static(path.join(__dirname, '../public/dashboard')));
app.use('/auth-static', express.static(path.join(__dirname, '../public/auth')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));

// ── Landing page ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// ── Checkout (public) ─────────────────────────────────────────────────────────
const checkoutTemplate = fs.readFileSync(path.join(__dirname, '../public/checkout-template.html'), 'utf8');
app.get('/pay/:slug', (req, res) => {
  const link = db.prepare('SELECT * FROM payment_links WHERE slug = ? AND status = 1').get(req.params.slug);
  if (!link) return res.status(404).send('<h1>Link não encontrado ou inativo</h1>');
  const cfg = `var CONFIG = {
  FACEBOOK_PIXEL_ID:   ${JSON.stringify(link.facebook_pixel_id||'')},
  META_ACCESS_TOKEN:   ${JSON.stringify(link.meta_access_token||'')},
  META_TEST_EVENT_CODE:${JSON.stringify(link.meta_test_code||'')},
  WOOVI_APP_ID:        ${JSON.stringify(link.woovi_app_id||'')},
  UTMIFY_TOKEN:        ${JSON.stringify(link.utmify_token||'')},
  PRODUTO_ID:          ${JSON.stringify(link.produto_id||'produto-001')},
  PRODUTO_NOME:        ${JSON.stringify(link.produto_nome||'')},
  PRODUTO_DESC:        ${JSON.stringify(link.produto_desc||'')},
  PRODUTO_IMAGEM:      ${JSON.stringify(link.produto_imagem||'')},
  PRECO_1X:            ${Number(link.preco_1x)||0},
  PRECO_2X:            ${Number(link.preco_2x)||0},
  WHATSAPP_SUPORTE:    ${JSON.stringify(link.whatsapp_suporte||'')},
  LINK_SLUG:           ${JSON.stringify(link.slug)},
  REGISTER_URL:        "/api/orders/register"
};`;
  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.send(checkoutTemplate.replace('__DYNAMIC_CONFIG__', cfg));
});

// Woovi webhook (public)
app.post('/api/webhooks/woovi', (req, res) => {
  try {
    const { charge } = req.body || {};
    if (!charge) return res.json({ ok: false });
    const orderId   = charge.correlationID || charge.orderId;
    const wooviSt   = charge.status || '';
    let newStatus   = null;
    if (['ACTIVE','COMPLETED'].includes(wooviSt)) newStatus = 'paid';
    else if (['OVERDUE','EXPIRED'].includes(wooviSt)) newStatus = 'expired';
    if (orderId && newStatus) {
      const paidAt = newStatus==='paid' ? new Date().toISOString() : null;
      db.prepare('UPDATE orders SET status=?, paid_at=? WHERE order_id=?').run(newStatus, paidAt, orderId);
      const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(orderId);
      if (order) {
        io.to('user:'+order.user_id).emit('order:updated', { order_id:orderId, status:newStatus, valor:order.valor });
        if (newStatus==='paid' && order.whatsapp_jid && order.user_id) {
          const bot = botManager.getInstanceIfExists(order.user_id);
          if (bot) { const jid=order.whatsapp_jid+'@s.whatsapp.net'; const s=bot.getSessions()[jid]; if(s){s.paymentConfirmed=true;} }
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Register order from checkout
app.post('/api/orders/register', async (req, res) => {
  const { link_slug, order_id, customer_name, customer_email, customer_phone, valor, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, whatsapp_jid, source } = req.body;
  if (!link_slug || !order_id) return res.status(400).json({ error: 'link_slug e order_id obrigatórios' });
  const link = db.prepare('SELECT id, user_id FROM payment_links WHERE slug=?').get(link_slug);
  try {
    const existing = db.prepare('SELECT id FROM orders WHERE order_id=?').get(order_id);
    if (existing) return res.json({ ok:true });
    let finalUtmSource=utm_source||'', finalUtmCampaign=utm_campaign||'', finalFbclid=fbclid||'';
    if (whatsapp_jid && link?.user_id) {
      const bot = botManager.getInstanceIfExists(link.user_id);
      if (bot) { const tr=bot.getSessionTracking(whatsapp_jid+'@s.whatsapp.net'); if(tr){if(!finalUtmSource&&tr.utm_source)finalUtmSource=tr.utm_source;if(!finalUtmCampaign&&tr.utm_campaign)finalUtmCampaign=tr.utm_campaign;if(!finalFbclid&&tr.fbclid)finalFbclid=tr.fbclid;}}
    }
    db.prepare(`INSERT INTO orders (user_id,link_id,link_slug,order_id,customer_name,customer_email,customer_phone,valor,status,source,whatsapp_jid,utm_source,utm_medium,utm_campaign,utm_content,utm_term,fbclid,ip) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)`).run(link?.user_id||null,link?.id||null,link_slug,order_id,customer_name||'',customer_email||'',customer_phone||'',Number(valor)||0,source||(whatsapp_jid?'whatsapp_bot':'checkout'),whatsapp_jid||'',finalUtmSource,utm_medium||'',finalUtmCampaign,utm_content||'',utm_term||'',finalFbclid,req.ip||'');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── User Dashboard (/dashboard) ───────────────────────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

// Static for bot panel (per-user, protected)
// Bot panel — accessible at /bot (iframe) and /bot-panel
app.get('/bot',       requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/bot/index.html')));
app.get('/bot-panel', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/bot/index.html')));

// Bot static assets
app.use('/bot-static', requireAuth, express.static(path.join(__dirname, '../public/bot')));

// Serve user media files
app.use('/rm-media', requireAuth, (req, res, next) => {
  const dir = path.join(botManager.getUserDataDir(req.user.id), 'rm-media');
  express.static(dir)(req, res, next);
});
app.use('/flow-audio', requireAuth, (req, res, next) => {
  const dir = path.join(botManager.getUserDataDir(req.user.id), 'flow-audio');
  express.static(dir)(req, res, next);
});
app.use('/camp-media', requireAuth, (req, res, next) => {
  const dir = path.join(botManager.getUserDataDir(req.user.id), 'camp-media');
  express.static(dir)(req, res, next);
});

// ── Per-user API routes ───────────────────────────────────────────────────────
app.use('/api', requireAuth, require('./routes/api'));

// ── Bot API (per-user) ────────────────────────────────────────────────────────
function botRoute(method, pattern, handler) {
  app[method]('/bot-api' + pattern, requireAuth, handler);
}

// Multer per-user
function getUserRmUpload(userId) {
  const dir = path.join(botManager.getUserDataDir(userId), 'rm-media');
  fs.mkdirSync(dir, { recursive: true });
  return multer({ storage: multer.diskStorage({
    destination: (_,__,cb) => cb(null, dir),
    filename: (_,file,cb) => cb(null, Date.now()+'-'+file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_'))
  }), limits: { fileSize: 50*1024*1024 } });
}
function getUserFlowAudioUpload(userId) {
  const dir = path.join(botManager.getUserDataDir(userId), 'flow-audio');
  fs.mkdirSync(dir, { recursive: true });
  return multer({ storage: multer.diskStorage({
    destination: (_,__,cb) => cb(null, dir),
    filename: (_,file,cb) => cb(null, Date.now()+'_'+file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_'))
  }), limits: { fileSize: 100*1024*1024 } });
}
function getUserCampMediaUpload(userId) {
  const dir = path.join(botManager.getUserDataDir(userId), 'camp-media');
  fs.mkdirSync(dir, { recursive: true });
  return multer({ storage: multer.diskStorage({
    destination: (_,__,cb) => cb(null, dir),
    filename: (_,file,cb) => cb(null, Date.now()+'_'+file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_'))
  }), limits: { fileSize: 100*1024*1024 } });
}

// FLOWS
botRoute('get',  '/flows', (req,res) => { const p=getBotPaths(req.user.id); res.json(readJson(p.flows,{flows:[]})); });
botRoute('post', '/flows', (req,res) => { const p=getBotPaths(req.user.id); writeJson(p.flows,req.body); res.json({ok:true}); });
botRoute('post', '/flows/add', (req,res) => { const p=getBotPaths(req.user.id); const d=readJson(p.flows,{flows:[]}); const f={id:'f'+uuidv4().slice(0,8),active:true,name:'Nova etapa',keywords:[],blocks:[{id:'b'+uuidv4().slice(0,8),type:'text',text:''}],next:'',...req.body}; d.flows.push(f); writeJson(p.flows,d); res.json(f); });
botRoute('put',  '/flows/:id', (req,res) => { const p=getBotPaths(req.user.id); const d=readJson(p.flows,{flows:[]}); const i=d.flows.findIndex(f=>f.id===req.params.id); if(i===-1)return res.status(404).json({error:'Not found'}); d.flows[i]={...d.flows[i],...req.body}; writeJson(p.flows,d); res.json(d.flows[i]); });
botRoute('delete','/flows/:id', (req,res) => { const p=getBotPaths(req.user.id); const d=readJson(p.flows,{flows:[]}); d.flows=d.flows.filter(f=>f.id!==req.params.id); writeJson(p.flows,d); res.json({ok:true}); });

// SETTINGS
botRoute('get',  '/settings', (req,res) => { const d=readJson(getBotPaths(req.user.id).flows,{}); res.json({botName:d.botName,sysPrompt:d.sysPrompt,fallbackAI:d.fallbackAI,workingHours:d.workingHours,aiResponseDelay:d.aiResponseDelay||0,aiPauseWords:d.aiPauseWords||[],pixKey:d.pixKey||'',messageDebounceSeconds:d.messageDebounceSeconds||4}); });
botRoute('post', '/settings', (req,res) => { const p=getBotPaths(req.user.id); const d=readJson(p.flows,{flows:[]}); Object.assign(d,req.body); writeJson(p.flows,d); res.json({ok:true}); });

// STATS
botRoute('get', '/stats', (req,res) => { res.json(readJson(getBotPaths(req.user.id).stats,{totalMessages:0,totalContacts:0,flowHits:{},dailyMessages:{}})); });

// CONVERSATIONS
botRoute('get', '/conversations', (req,res) => {
  const p=getBotPaths(req.user.id); const convs=readJson(p.conv,{}); const bot=botManager.getInstanceIfExists(req.user.id);
  const sessions=bot?bot.getSessions():{};
  let list=Object.entries(convs).map(([jid,c])=>({jid,contact:c.contact,lastSeen:c.lastSeen,lastMsg:c.messages?.slice(-1)[0]?.text||'',count:c.messages?.length||0,finished:sessions[jid]?.finished||false,pausedByHuman:sessions[jid]?.pausedByHuman||false,archived:c.archived||false}));
  if(req.query.showArchived!=='true')list=list.filter(c=>!c.archived);
  const from=req.query.from?new Date(req.query.from):null, to=req.query.to?new Date(req.query.to):null;
  if(from||to)list=list.filter(c=>{const d=new Date(c.lastSeen||0);if(from&&d<from)return false;if(to&&d>to)return false;return true;});
  list.sort((a,b)=>new Date(b.lastSeen)-new Date(a.lastSeen));
  res.json(list);
});
botRoute('get',    '/conversations/:jid', (req,res) => { const p=getBotPaths(req.user.id); const convs=readJson(p.conv,{}); res.json(convs[decodeURIComponent(req.params.jid)]||{messages:[]}); });
botRoute('delete', '/conversations/:jid', (req,res) => { const p=getBotPaths(req.user.id); const convs=readJson(p.conv,{}); delete convs[decodeURIComponent(req.params.jid)]; writeJson(p.conv,convs); res.json({ok:true}); });

// BOT CONTROL
botRoute('get',  '/bot/status', (req,res) => { const b=botManager.getInstanceIfExists(req.user.id); res.json({status:b?b.status:'disconnected',qr:b?b.qrDataUrl:null}); });
botRoute('post', '/bot/start',  async(req,res) => { const b=getUserBot(req.user.id); b.start().catch(console.error); res.json({ok:true}); });
botRoute('post', '/bot/stop',   async(req,res) => { const b=botManager.getInstanceIfExists(req.user.id); if(b)await b.disconnect(); res.json({ok:true}); });
botRoute('post', '/bot/pause/:jid',  (req,res) => { const b=botManager.getInstanceIfExists(req.user.id); if(b)b.pauseSession(decodeURIComponent(req.params.jid)); res.json({ok:true}); });
botRoute('post', '/bot/resume/:jid', (req,res) => { const b=botManager.getInstanceIfExists(req.user.id); if(b)b.resumeSession(decodeURIComponent(req.params.jid)); res.json({ok:true}); });
botRoute('get',  '/bot/sessions', (req,res) => { const b=botManager.getInstanceIfExists(req.user.id); if(!b)return res.json([]); const s=b.getSessions(); res.json(Object.entries(s).map(([jid,s])=>({jid,contact:jid.replace('@s.whatsapp.net',''),pausedByHuman:s.pausedByHuman||false,finished:s.finished||false,currentFlowIndex:s.currentFlowIndex}))); });
botRoute('post', '/bot/send/:jid', async(req,res) => {
  const b=botManager.getInstanceIfExists(req.user.id); if(!b)return res.status(400).json({error:'Bot não iniciado'});
  const jid=decodeURIComponent(req.params.jid);
  try { await b.sendFromDashboard(jid,req.body); res.json({ok:true}); } catch(e){res.status(500).json({error:e.message});}
});
botRoute('post', '/bot/logout', async(req,res) => {
  const b=botManager.getInstanceIfExists(req.user.id); if(b)await b.stop();
  const authDir=path.join(botManager.getUserDataDir(req.user.id),'auth');
  if(fs.existsSync(authDir))fs.rmSync(authDir,{recursive:true});
  res.json({ok:true});
});

// CRM
botRoute('get', '/crm', (req,res) => {
  const uid=req.user.id; const p=getBotPaths(uid); const bot=botManager.getInstanceIfExists(uid);
  const flowsData=readJson(p.flows,{flows:[]}); const convs=readJson(p.conv,{}); const sessions=bot?bot.getSessions():{};
  const activeFlows=(flowsData.flows||[]).filter(f=>f.active!==false);
  const colors=['#3a8fff','#a855f7','#ec4899','#f59e0b','#14b8a6','#ef4444','#8b5cf6','#06b6d4','#84cc16','#f97316'];
  const columns={};
  columns['__none__']={id:'__none__',name:'Aguardando',color:'#5a6380',leads:[]};
  activeFlows.forEach((f,i)=>{columns[f.id]={id:f.id,name:f.name,color:colors[i%10],leads:[]};});
  columns['__done__']={id:'__done__',name:'Finalizado',color:'#25D366',leads:[]};
  columns['__paused__']={id:'__paused__',name:'Atendente',color:'#f59e0b',leads:[]};
  const now=Date.now(); const ONE_DAY=86400000;
  Object.entries(convs).forEach(([jid,conv])=>{
    const sess=sessions[jid];
    if(!sess){const lm=conv.messages?.length?conv.messages[conv.messages.length-1]:null;if(!lm||now-new Date(lm.time).getTime()>ONE_DAY)return;}
    const sd=sess||{}; const lm=conv.messages?.length?conv.messages[conv.messages.length-1]:null;
    const lead={jid,contact:conv.contact||jid.replace('@s.whatsapp.net',''),lastMsg:lm?lm.text:'',lastMsgTime:lm?lm.time:conv.lastSeen,lastRole:lm?lm.role:'user',flowIndex:sd.currentFlowIndex!==undefined?sd.currentFlowIndex:-1,started:sd.started||false,finished:sd.finished||false,pausedByHuman:sd.pausedByHuman||false,inAIMode:sd.inAIMode||false,remarketingCount:sd.remarketingCount||0,msgCount:conv.messages?.length||0};
    if((convs[jid]||{}).archived)return;
    if(lead.pausedByHuman)columns['__paused__'].leads.push(lead);
    else if(lead.finished)columns['__done__'].leads.push(lead);
    else if(lead.started&&lead.flowIndex>=0&&activeFlows[lead.flowIndex]){const fid=activeFlows[lead.flowIndex].id;if(columns[fid])columns[fid].leads.push(lead);else columns['__none__'].leads.push(lead);}
    else if(lead.started&&!lead.finished)columns['__none__'].leads.push(lead);
  });
  Object.values(columns).forEach(col=>col.leads.sort((a,b)=>new Date(b.lastMsgTime||0)-new Date(a.lastMsgTime||0)));
  const kpis={totalLeads:Object.keys(convs).length,activeLeads:Object.values(sessions).filter(s=>s&&s.started&&!s.finished).length,pausedByHuman:columns['__paused__'].leads.length,finished:columns['__done__'].leads.length};
  res.json({columns:Object.values(columns),kpis});
});

// REMARKETING
botRoute('get', '/remarketing', (req,res) => { const d=readJson(getBotPaths(req.user.id).flows,{}); res.json(d.remarketing||{enabled:false,delayMinutes:30,messages:[],intervalMinutes:60,maxMessages:3}); });
botRoute('post','/remarketing', (req,res) => { const p=getBotPaths(req.user.id); const d=readJson(p.flows,{flows:[]}); d.remarketing=req.body; writeJson(p.flows,d); res.json({ok:true}); });
botRoute('post','/remarketing/upload', (req,res,next) => getUserRmUpload(req.user.id).single('file')(req,res,next), (req,res) => {
  if(!req.file)return res.status(400).json({error:'Nenhum arquivo enviado'});
  res.json({ok:true,filename:req.file.filename,type:req.file.mimetype.startsWith('video')?'video':'image',mimetype:req.file.mimetype});
});
botRoute('delete','/remarketing/media/:filename', (req,res) => {
  const fp=path.join(botManager.getUserDataDir(req.user.id),'rm-media',req.params.filename);
  try{if(fs.existsSync(fp))fs.unlinkSync(fp);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
botRoute('get','/remarketing/stats', (req,res) => {
  const bot=botManager.getInstanceIfExists(req.user.id); const sessions=bot?bot.getSessions():{};
  const stats={eligible:0,sent1:0,sent2:0,sent3:0,converted:0,total:Object.keys(sessions).length};
  for(const[,s]of Object.entries(sessions)){if(!s||!s.started)continue;const rc=s.remarketingCount||0;if(s.currentFlowIndex===0&&!s.finished&&!s.pausedByHuman){stats.eligible++;if(rc===1)stats.sent1++;if(rc===2)stats.sent2++;if(rc>=3)stats.sent3++;}if(rc>0&&s.currentFlowIndex>0)stats.converted++;}
  res.json(stats);
});

// CAMPAIGNS (bot)
botRoute('get', '/campaigns/segments', (req,res) => {
  const bot=botManager.getInstanceIfExists(req.user.id); const sessions=bot?bot.getSessions():{}; const convs=readJson(getBotPaths(req.user.id).conv,{}); const now=Date.now();
  const H6=21600000,H24=86400000;
  const segments={nao_responderam:[],potencial_compra:[],novos:[],todos_ativos:[],finalizados:[]};
  for(const[jid,sess]of Object.entries(sessions)){
    if(!sess||!sess.started)continue;
    const la=sess.lastActivity||0;const im=now-la;
    const conv=convs[jid]||{};const lm=(conv.messages||[]).slice(-1)[0];
    const lead={jid,contact:conv.contact||jid.replace('@s.whatsapp.net',''),lastMsg:lm?.text?.substring(0,60)||'',lastActivity:la,flowIndex:sess.currentFlowIndex??-1,remarketingCount:sess.remarketingCount||0,finished:sess.finished||false,pausedByHuman:sess.pausedByHuman||false};
    if(sess.finished){segments.finalizados.push(lead);continue;}
    if(sess.pausedByHuman)continue;
    if(im<=H24)segments.novos.push(lead);
    if(im>=H6)segments.nao_responderam.push(lead);
    if(sess.currentFlowIndex>0)segments.potencial_compra.push(lead);
    segments.todos_ativos.push(lead);
  }
  res.json({segments,counts:Object.fromEntries(Object.entries(segments).map(([k,v])=>[k,v.length]))});
});

botRoute('get',   '/campaigns', (req,res) => { res.json(readJson(getBotPaths(req.user.id).camps,[])); });
botRoute('post',  '/campaigns', (req,res) => {
  const p=getBotPaths(req.user.id); const camps=readJson(p.camps,[]);
  const camp={id:'c'+uuidv4().slice(0,8),name:req.body.name||'Campanha',segment:req.body.segment||'todos_ativos',customJids:req.body.customJids||[],messages:req.body.messages||[],delaySeconds:req.body.delaySeconds||5,createdAt:new Date().toISOString(),status:'draft',sentCount:0,errorCount:0,log:[]};
  camps.unshift(camp); writeJson(p.camps,camps); res.json(camp);
});
botRoute('put',   '/campaigns/:id', (req,res) => { const p=getBotPaths(req.user.id); const camps=readJson(p.camps,[]); const i=camps.findIndex(c=>c.id===req.params.id); if(i===-1)return res.status(404).json({error:'Not found'}); camps[i]={...camps[i],...req.body}; writeJson(p.camps,camps); res.json(camps[i]); });
botRoute('delete','/campaigns/:id', (req,res) => { const p=getBotPaths(req.user.id); writeJson(p.camps,readJson(p.camps,[]).filter(c=>c.id!==req.params.id)); res.json({ok:true}); });

botRoute('post',  '/campaigns/:id/send', async(req,res) => {
  const uid=req.user.id; const p=getBotPaths(uid);
  let camps=readJson(p.camps,[]); const idx=camps.findIndex(c=>c.id===req.params.id);
  if(idx===-1)return res.status(404).json({error:'Not found'});
  const camp=camps[idx]; if(camp.status==='running')return res.status(400).json({error:'Já em execução'});
  const bot=botManager.getInstanceIfExists(uid);
  if(!bot||bot.status!=='connected')return res.status(400).json({error:'Bot não conectado'});
  const sessions=bot.getSessions(); const convs=readJson(p.conv,{}); const now=Date.now(); const H6=21600000,H24=86400000;
  const alreadySent=new Set(camp.sentJids||[]);
  let jids=[];
  if(camp.customJids?.length){jids=camp.customJids.filter(j=>!alreadySent.has(j));}
  else{for(const[jid,sess]of Object.entries(sessions)){if(!sess||!sess.started||sess.pausedByHuman)continue;const im=now-(sess.lastActivity||0);const seg=camp.segment;if(alreadySent.has(jid))continue;if(seg==='todos_ativos'&&!sess.finished)jids.push(jid);else if(seg==='nao_responderam'&&!sess.finished&&im>=H6)jids.push(jid);else if(seg==='potencial_compra'&&!sess.finished&&sess.currentFlowIndex>0)jids.push(jid);else if(seg==='novos'&&!sess.finished&&im<=H24)jids.push(jid);else if(seg==='finalizados'&&sess.finished)jids.push(jid);}}
  camps[idx]={...camp,status:'running',startedAt:new Date().toISOString(),sentCount:0,errorCount:0,totalLeads:jids.length};
  writeJson(p.camps,camps);
  io.to('user:'+uid).emit('campaign:update',{id:camp.id,status:'running',totalLeads:jids.length,sentCount:0});
  res.json({ok:true,totalLeads:jids.length});
  (async()=>{
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    let sent=0,errors=0; const convsCurrent=readJson(p.conv,{});
    for(const jid of jids){
      try{await bot.sendFromDashboard(jid,camp.messages[0]);sent++;const fr=readJson(p.camps,[]);const fi=fr.findIndex(c=>c.id===camp.id);if(fi!==-1){fr[fi].sentCount=sent;if(!fr[fi].sentJids)fr[fi].sentJids=[];fr[fi].sentJids.push(jid);writeJson(p.camps,fr);}io.to('user:'+uid).emit('campaign:update',{id:camp.id,status:'running',sentCount:sent,totalLeads:jids.length});}
      catch(e){errors++;console.error('[CAMP]',e.message);}
      await delay((camp.delaySeconds||5)*1000);
    }
    const fr=readJson(p.camps,[]);const fi=fr.findIndex(c=>c.id===camp.id);if(fi!==-1){fr[fi].status='done';fr[fi].sentCount=sent;fr[fi].errorCount=errors;fr[fi].finishedAt=new Date().toISOString();writeJson(p.camps,fr);}
    io.to('user:'+uid).emit('campaign:update',{id:camp.id,status:'done',sentCount:sent,errorCount:errors,totalLeads:jids.length});
  })();
});

// AUDIO upload (flows)
botRoute('post','/flows/upload-audio', (req,res,next)=>getUserFlowAudioUpload(req.user.id).single('audio')(req,res,next),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Arquivo não enviado'});
  res.json({ok:true,filename:req.file.filename,url:'/flow-audio/'+req.file.filename});
});

// AI chat
botRoute('post','/ai/chat', async(req,res)=>{
  const {message,history=[],context=''}=req.body;
  const apiKey=process.env.ANTHROPIC_API_KEY;
  if(!apiKey||apiKey==='sk-ant-SUA_CHAVE_AQUI')return res.json({reply:'Configure ANTHROPIC_API_KEY no .env'});
  const cfg=readJson(getBotPaths(req.user.id).flows,{});
  try{const Anthropic=require('@anthropic-ai/sdk');const ai=new Anthropic({apiKey});const result=await ai.messages.create({model:'claude-sonnet-4-5',max_tokens:600,system:(cfg.sysPrompt||'')+'\n\n'+context,messages:[...history,{role:'user',content:message}]});res.json({reply:result.content[0].text});}
  catch(e){res.json({reply:'Erro IA: '+e.message});}
});

// GROQ status
botRoute('get','/groq/status',(req,res)=>{
  const b=botManager.getInstanceIfExists(req.user.id);
  res.json({configured:!!process.env.GROQ_API_KEY,available:b?b.groqAvailable:false,retryAt:b?b.groqRetryAt:null});
});

// ── Admin seed (creates first admin if no admin exists) ──────────────────────────
app.post('/setup-admin', async(req, res) => {
  const existing = db.prepare("SELECT id FROM users WHERE plan='admin'").get();
  if (existing) return res.status(403).json({ error: 'Admin já existe. Use /admin para gerenciar.' });
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  try {
    const info = db.prepare("INSERT INTO users (name,email,password_hash,plan,status) VALUES (?,?,?,'admin','active')").run(name, email.toLowerCase(), hash);
    req.session.userId = info.lastInsertRowid;
    req.session.save(() => res.json({ ok: true, redirect: '/admin' }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/setup-admin', (req, res) => {
  const existing = db.prepare("SELECT id FROM users WHERE plan='admin'").get();
  if (existing) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../public/auth/setup-admin.html'));
});

// ── SUPER ADMIN (/admin) ───────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req,res) => res.sendFile(path.join(__dirname,'../public/superadmin/index.html')));
app.use('/admin-static', express.static(path.join(__dirname,'../public/superadmin')));

app.get('/admin-api/users', requireAdmin, (req,res) => {
  const users=db.prepare('SELECT id,name,email,plan,status,created_at,last_login FROM users ORDER BY created_at DESC').all();
  const bots=botManager.listInstances();
  const botsMap=Object.fromEntries(bots.map(b=>[b.userId,b]));
  res.json(users.map(u=>({...u,botStatus:botsMap[u.id]?.status||'offline',botLeads:botsMap[u.id]?.sessions||0})));
});

app.put('/admin-api/users/:id', requireAdmin, (req,res) => {
  const {plan,status,name}=req.body;
  db.prepare('UPDATE users SET plan=COALESCE(?,plan),status=COALESCE(?,status),name=COALESCE(?,name) WHERE id=?').run(plan||null,status||null,name||null,req.params.id);
  if(status==='suspended'){const b=botManager.getInstanceIfExists(Number(req.params.id));if(b)b.disconnect().catch(()=>{});}
  res.json({ok:true});
});

app.delete('/admin-api/users/:id', requireAdmin, async(req,res) => {
  await botManager.destroyInstance(Number(req.params.id));
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.get('/admin-api/stats', requireAdmin, (req,res) => {
  const totalUsers=db.prepare('SELECT COUNT(*) as c FROM users').get()?.c||0;
  const activeUsers=db.prepare("SELECT COUNT(*) as c FROM users WHERE status='active'").get()?.c||0;
  const bots=botManager.listInstances();
  const connectedBots=bots.filter(b=>b.status==='connected').length;
  const totalRevenue=db.prepare("SELECT SUM(valor) as r FROM orders WHERE status='paid'").get()?.r||0;
  res.json({totalUsers,activeUsers,connectedBots,totalBots:bots.length,totalRevenue});
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Authenticate socket via session
  const sess = socket.request?.session;
  const userId = sess?.userId;
  if (userId) {
    socket.join('user:' + userId);
    const bot = botManager.getInstanceIfExists(userId);
    if (bot) {
      socket.emit('bot:status', { status: bot.status, qr: bot.qrDataUrl });
    } else {
      socket.emit('bot:status', { status: 'disconnected', qr: null });
    }
  }
});

// ── Protected cloaking routes ─────────────────────────────────────────────────
app.use('/cloaker-admin', requireAuth, require('./routes/admin'));

// ── Cloaker API (user-scoped) ─────────────────────────────────────────────────
// (already mounted at /api above with requireAuth)

// ── Redirect (cloaking, must be last) ─────────────────────────────────────────
app.use('/', require('./routes/redirect'));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err,req,res,_next) => {
  console.error('[server]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Traffic Control SaaS                   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Landing:    http://localhost:${PORT}/         ║`);
  console.log(`║  Dashboard:  http://localhost:${PORT}/dashboard║`);
  console.log(`║  Super Admin:http://localhost:${PORT}/admin    ║`);
  console.log('╚══════════════════════════════════════════╝\n');
});
