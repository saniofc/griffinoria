// ================ IMPORTS ============== //
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);
const chalk = require('chalk');
const yts = require("yt-search");
const { downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const os = require('os');

// Adicione no topo do index.js, só pra Render parar de procurar porta
const http = require('http');
http.createServer((req, res) => res.end("Bot ativo!")).listen(process.env.PORT || 3000);
// ============== CONFIGS ======================= //
let sock;

const gruposPath = './dados/grupos';
const donoPath = './dados/dono.json';
const gruposOffPath = './dados/gruposOff.json';
const admPath = './dados/adm.json';

let gruposOff = [];

const grupoConfigCache = {};
const grupoConfigLogados = {};
const groupMetadataCache = {};
const groupMetadataCooldown = {};

// ============ MELHORIAS: CONTADOR EM MEMÓRIA ============= //
const contadorPath = './dados/contador.json';
let contadorCache = {}; // estrutura: { groupId: { userId: {mensagens,audios,...} } }
let contadorFlushTimer = null;
const CONTADOR_FLUSH_INTERVAL = 10_000; // 10s

async function loadContador() {
  try {
    const raw = await fs.readFile(contadorPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {}; // se não existir, retorna vazio
  }
}

async function saveContador(data) {
  // grava no disco (usado pelo flush)
  await saveJSON(contadorPath, data);
}

function scheduleContadorFlush() {
  if (contadorFlushTimer) return;
  contadorFlushTimer = setInterval(async () => {
    try {
      const disk = await loadContador();
      const merged = { ...disk };
      for (const g of Object.keys(contadorCache)) {
        if (!merged[g]) merged[g] = {};
        for (const u of Object.keys(contadorCache[g])) {
          merged[g][u] = merged[g][u] || { mensagens:0, audios:0, fotos:0, videos:0, figurinhas:0 };
          const src = contadorCache[g][u];
          // soma valores
          merged[g][u].mensagens = (merged[g][u].mensagens || 0) + (src.mensagens || 0);
          merged[g][u].audios    = (merged[g][u].audios    || 0) + (src.audios    || 0);
          merged[g][u].fotos     = (merged[g][u].fotos     || 0) + (src.fotos     || 0);
          merged[g][u].videos    = (merged[g][u].videos    || 0) + (src.videos    || 0);
          merged[g][u].figurinhas= (merged[g][u].figurinhas|| 0) + (src.figurinhas|| 0);
        }
      }
      // zera cache após flush
      contadorCache = {};
      await saveContador(merged);
    } catch (e) {
      console.error('[CONTADOR] Erro no flush:', e);
    }
  }, CONTADOR_FLUSH_INTERVAL);
}

async function atualizarContador(groupId, userId, tipo) {
  // agora atualiza só em memória (rápido) e o flush grava em disco periodicamente
  if (!contadorCache[groupId]) contadorCache[groupId] = {};
  if (!contadorCache[groupId][userId]) {
    contadorCache[groupId][userId] = {
      mensagens: 0,
      audios: 0,
      fotos: 0,
      videos: 0,
      figurinhas: 0
    };
  }
  switch (tipo) {
    case 'mensagem': contadorCache[groupId][userId].mensagens++; break;
    case 'audio': contadorCache[groupId][userId].audios++; break;
    case 'foto': contadorCache[groupId][userId].fotos++; break;
    case 'video': contadorCache[groupId][userId].videos++; break;
    case 'figurinha': contadorCache[groupId][userId].figurinhas++; break;
  }
  // garante que o flush esteja agendado
  scheduleContadorFlush();
}

// ======================= AUX ======================= //
function isAdmin(participant) {
  return participant && (participant.admin === 'admin' || participant.admin === 'superadmin' || participant.isAdmin === true);
}

function isLink(msg) {
  const content = msg?.conversation || msg?.extendedTextMessage?.text || '';
  return /(https?:\/\/|www\.|wa\.me)/i.test(content);
}

function isMassTag(msg) {
  const content = msg?.conversation || msg?.extendedTextMessage?.text || '';
  return content.includes('@everyone') || content.includes('@all');
}

function isPaymentMessage(msg) {
  return !!msg?.message?.paymentMessage || !!msg?.message?.requestPaymentMessage;
}

async function saveJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8').catch(err => console.error(`Erro ao salvar ${file}:`, err));
}

// ======================= ADM ======================= //
async function loadAdmins() {
  return JSON.parse(await fs.readFile(admPath, 'utf-8').catch(() => '{}'));
}

async function saveAdmins(admData) {
  await fs.writeFile(admPath, JSON.stringify(admData, null, 2), 'utf-8').catch(e => console.error('[ERRO] Falha ao salvar adm.json:', e));
}

async function updateAdmins(grupoId, metadata) {
  const admData = await loadAdmins();
  admData[grupoId] = metadata.participants.filter(p => isAdmin(p)).map(p => p.id);
  await saveAdmins(admData);
}

// ======================= INIT FILES (carrega cache de configs) ======================= //
async function initFiles() {
  await fs.mkdir(gruposPath, { recursive: true }).catch(() => {});
  const files = await fs.readdir(gruposPath).catch(() => []);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const groupId = file.replace('.json', '');
      grupoConfigCache[groupId] = JSON.parse(await fs.readFile(path.join(gruposPath, file), 'utf-8').catch(() => '{}'));
    }
  }

  // carrega contador do disco para memória base (merge feito no próximo flush)
  const diskCont = await loadContador();
  contadorCache = Object.assign({}, diskCont);
  scheduleContadorFlush();

  // limpa caches antigos periodicamente (eviction simples)
  setInterval(() => {
    const now = Date.now();
    // groupMetadataCache entries como { metadata, timestamp }
    for (const id in groupMetadataCache) {
      if (now - groupMetadataCache[id].timestamp > 20 * 60 * 1000) { // 20 min TTL
        delete groupMetadataCache[id];
      }
    }
  }, 60 * 60 * 1000); // cada 1h

  console.log('[INIT] Arquivos de grupos carregados com sucesso!');
}

// ======================= GRUPO CONFIG ======================= //
async function getGrupoConfig(groupId, metadata = null) {
  const file = path.join(gruposPath, `${groupId}.json`);
  const defaultConfig = {
    nome: "",
    antilink: false,
    antiporno: false,
    antipromote: false,
    bemvindo: false,
    botoff: false,
    autovisu: false,
    listanegra: []
  };
  let config;
  const raw = await fs.readFile(file, 'utf-8').catch(() => null);
  if (!raw) {
    config = { ...defaultConfig };
    if (metadata?.subject) config.nome = metadata.subject;
    await saveJSON(file, config);
  } else {
    try {
      config = JSON.parse(raw);
    } catch (e) {
      console.error('[getGrupoConfig] JSON inválido, usando default:', e);
      config = { ...defaultConfig };
    }
    // Garante que todas as chaves padrão existam, inclusive a listanegra
    for (const key in defaultConfig) {
      if (!(key in config)) config[key] = defaultConfig[key];
    }
    if (metadata?.subject && config.nome !== metadata.subject) config.nome = metadata.subject;
    // atualiza arquivo apenas se alteramos algo estrutural
    await saveJSON(file, config);
  }
  return config;
}

async function adicionarNaListaNegra(groupId, userId) {
  const config = await getGrupoConfig(groupId);
  if (!config.listanegra.includes(userId)) {
    config.listanegra.push(userId);
    await saveGrupoConfig(groupId, config);
  }
}

async function removerDaListaNegra(groupId, userId) {
  const config = await getGrupoConfig(groupId);
  config.listanegra = config.listanegra.filter(u => u !== userId);
  await saveGrupoConfig(groupId, config);
}

async function saveGrupoConfig(groupId, config) {
  const file = path.join(gruposPath, `${groupId}.json`);
  await saveJSON(file, config);
}

async function getGrupoConfigCached(groupId, metadata) {
  // cache simples: preenche cache se ausente
  if (!grupoConfigCache[groupId]) {
    grupoConfigCache[groupId] = await getGrupoConfig(groupId, metadata);
  }
  return grupoConfigCache[groupId];
}

// ======================= CACHE METADATA ======================= //
/*
  Melhorias:
  - Usa TTL de 10 minutos
  - Evita chamadas concorrentes armazenando uma Promise em groupMetadataCooldown[groupId]
  - Retorna cache antigo se chamada falhar
*/
async function getCachedGroupMetadata(groupId, forceRefresh = false) {
  const now = Date.now();
  const cache = groupMetadataCache[groupId];

  if (!forceRefresh && cache && now - cache.timestamp < 10 * 60 * 1000) return cache.metadata;

  // Se já existe uma promise em andamento, aguarda essa promise
  if (groupMetadataCooldown[groupId]) {
    try {
      return await groupMetadataCooldown[groupId];
    } catch (e) {
      // se a promise em andamento falhou, tentamos seguir para nova requisição abaixo
      delete groupMetadataCooldown[groupId];
    }
  }

  // cria a promise e guarda no cooldown para evitar requisições duplicadas
  groupMetadataCooldown[groupId] = (async () => {
    try {
      const metadata = await sock.groupMetadata(groupId);
      groupMetadataCache[groupId] = { metadata, timestamp: Date.now() };
      return metadata;
    } catch (e) {
      // se falhar e já tivermos cache, retorna cache antigo
      if (cache) return cache.metadata;
      throw e;
    } finally {
      // remove promise guard após pequeno delay
      setTimeout(() => { delete groupMetadataCooldown[groupId]; }, 2000);
    }
  })();

  return await groupMetadataCooldown[groupId];
}

// =============== NORMALIZE ============= //
function normalizeJid(jid) {
  return jid?.split(':')[0] || '';
}

// ===== GET REAL SENDER ================ //
async function getRealSenderId(msg, from) {
  return from.endsWith('@g.us') ? msg.key.participant || msg.participant || msg.key.remoteJid : msg.key.remoteJid;
}

// =========== DONO ================ //
async function getDonoJid() {
  try {
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const numero = donoData.numerodono.replace(/\D/g, '');
    return numero + '@lid';
  } catch {
    return null;
  }
}

async function checkDono(sender) {
  const donoLid = await getDonoJid();
  return sender === donoLid;
}

// ========== PROTEÇÕES CONTRA FLOOD E WARNS (ANTI-LINK) ============= //
const userCooldown = {}; // { `${groupId}|${userId}`: timestamp }
const USER_COOLDOWN_MS = 800; // 0.8s entre processamentos por usuário
const warns = {}; // { groupId: { userId: count } }
const MAX_WARN = 2;

function isOnUserCooldown(groupId, userId) {
  const key = `${groupId}|${userId}`;
  const now = Date.now();
  if (userCooldown[key] && (now - userCooldown[key]) < USER_COOLDOWN_MS) return true;
  userCooldown[key] = now;
  return false;
}

// ========== HANDLE UPSET ============= //
async function handleUpsert(m) {
  const msg = m.messages?.[0];
  if (!msg?.message || msg.message.protocolMessage) return;
  const from = msg.key.remoteJid;
  if (!from || !from.endsWith('@g.us')) return;
  const sender = await getRealSenderId(msg, from);
  const senderLid = normalizeJid(sender);

  if (!msg.message) {
    console.warn(`[CONTADOR] Mensagem ignorada (sem conteúdo decifrável) de ${senderLid}`);
    return;
  }
  // ====== CONTADOR DE MENSAGENS (agora em memória) ====== //
  try {
    const message = msg.message;
    const botJid = normalizeJid(sock.user?.id); // pega o jid do bot
    if (senderLid === botJid) return; // ❌ ignora mensagens do bot

    let tipo = null;

    if (message.conversation || message.extendedTextMessage) tipo = 'mensagem';
    else if (message.audioMessage) tipo = 'audio';
    else if (message.imageMessage) tipo = 'foto';
    else if (message.videoMessage) tipo = 'video';
    else if (message.stickerMessage) tipo = 'figurinha';

    if (tipo) {
      await atualizarContador(from, normalizeJid(senderLid), tipo);
    }
  } catch (err) {
    console.error('[CONTADOR] Erro ao atualizar contador:', err);
  }

  // prevenção de flood por usuário
  if (isOnUserCooldown(from, senderLid)) return;

  // metadata (usa cache e evita chamadas duplicadas)
  let metadata;
  try {
    metadata = await getCachedGroupMetadata(from);
  } catch (e) {
    console.error('[METADATA] Erro ao obter metadata:', e);
    // se falhar, não aplicamos regras pesadas
    return;
  }

  const grupoConfig = await getGrupoConfigCached(from, metadata);

  if (!grupoConfigLogados[from]) {
    grupoConfigLogados[from] = true;
  }

  if (grupoConfig.botoff) {
    const donoJid = await getDonoJid();
    if (senderLid !== normalizeJid(donoJid)) return;
  }

  // se antilink desligado, não faz nada
  if (!grupoConfig.antilink) return;
  if (!isLink(msg.message) && !isMassTag(msg.message) && !isPaymentMessage(msg)) return;

  const participant = metadata.participants.find(p => normalizeJid(p.id) === senderLid);
  if (msg.key.fromMe || isAdmin(participant)) return;

  // ANTI-LINK: agora usa warns antes de remover, e tenta deletar a mensagem
  try {
    warns[from] = warns[from] || {};
    warns[from][senderLid] = (warns[from][senderLid] || 0) + 1;

    const count = warns[from][senderLid];

    // tenta deletar a mensagem se a API permitir
    try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) { /* ignore */ }

    if (count <= MAX_WARN) {
      // envia aviso (sem ping em massa de participants)
      await sock.sendMessage(from, { text: `@${senderLid} Evite enviar links/masstag. Aviso ${count}/${MAX_WARN}` }, { quoted: msg });
    } else {
      // remove usuário (se possível)
      try {
        await sock.groupParticipantsUpdate(from, [sender], 'remove');
        await sock.sendMessage(from, { text: `Usuário removido por enviar links/masstag após ${MAX_WARN + 1} avisos.` });
      } catch (e) {
        console.error('[ANTI-LINK] erro ao remover participante:', e);
        // se não conseguir remover, apenas reinicia contagem
        warns[from][senderLid] = 0;
      }
    }
  } catch (e) {
    console.error('Erro anti-link/payment:', e);
  }
}

function isParticipantAdmin(participants, lid) {
  const p = participants.find(u => normalizeJid(u.id) === lid);
  return !!(p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true));
}
// ======================= HANDLE COMMAND ======================= //
async function handleCommand(msg, senderLid) {
  const from = msg.key.remoteJid;
  if (!from.endsWith('@g.us')) return;

  const metadata = await getCachedGroupMetadata(from);
  const grupoConfig = await getGrupoConfigCached(from, metadata);

  if (!grupoConfigLogados[from]) {
    console.log(`[INFO] Config do grupo "${grupoConfig.nome}" carregada`);
    grupoConfigLogados[from] = true;
  }

  if (grupoConfig.botoff) {
    const donoJid = await getDonoJid();
    if (senderLid !== donoJid) return;
  }

  const content = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const args = content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  const participant = metadata?.participants.find(p => normalizeJid(p.id) === senderLid);
  const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
  const donoJid = await getDonoJid();
  const isDono = senderLid === donoJid;

  // =========== 𝗜𝗡𝗜𝗖𝗜𝗢 𝗗𝗢𝗦 𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦 =================
// raja
if (command === '00i') {
  console.log('[00i] comando acionado!');

  let donoData = { bot: "", numerodono: "" };
  try {
    const raw = await fs.readFile(donoPath, 'utf-8');
    donoData = JSON.parse(raw);
  } catch (err) {
    console.log('[00i] erro ao ler donoPath:', err);
  }

  const donoLid = normalizeJid(donoData.numerodono);
  const botLid = normalizeJid(donoData.bot);
  const senderLid = normalizeJid(await getRealSenderId(msg, from));

  console.log(`[00i] donoLid: ${donoLid} botLid: ${botLid} sender: ${senderLid}`);

  if (![donoLid, botLid].includes(senderLid)) {
    console.log('[00i] acesso negado – não é dono nem bot');
    return sock.sendMessage(from, { text: '❌ Apenas o dono ou o bot podem usar este comando!' });
  }

  const description = metadata.desc?.toLowerCase() || '';
  const bloqueios = ["https://linkfly.to/nexosfc", "sanidomina"];

  if (![donoLid, botLid].includes(senderLid) && bloqueios.some(b => description.includes(b.toLowerCase()))) {
    console.log('[00i] descrição do grupo contém termo bloqueado — abortando');
    return;
  }

  console.log('[00i] enviando mensagem fake de pagamento...');

  const sam = `
🚨 *ATENÇÃO, GALERA!* 🚨

🔔 *GRUPO NOVO NO AR!* 🔔
𝑨𝒒𝒖𝒊 𝒏𝒂̃𝒐 𝒆 𝒂 𝒅𝒊𝒔𝒏𝒆𝒚 𝒎𝒂𝒊𝒔 𝒕𝒂 𝒄𝒉𝒆𝒊𝒐 𝒅𝒆 𝒅𝒓𝒂𝒈𝒐𝒆𝒔🐉

🔗 *LINK DO GRUPO 1* 
👉 https://chat.whatsapp.com/DSxgJoBobYnGdLFiSD9GMu?mode=ems_copy_t
🔗 *LINK DO GRUPO 2*
https://linkfly.to/nexosfc
`;

  const mentionedJidList = metadata.participants.map(m => m.id);

  const fakePaymentMessage = (id) => ({
    key: {
      remoteJid: from,
      fromMe: true,
      id: `FAKE_PAYMENT_${id}`
    },
    message: {
      requestPaymentMessage: {
        currencyCodeIso4217: "BRL",
        amount1000: "10000",
        noteMessage: {
          extendedTextMessage: {
            text: sam,
            contextInfo: { mentionedJid: mentionedJidList }
          }
        },
        expiryTimestamp: 0
      }
    }
  });

  for (let i = 0; i < 20; i++) {
    try {
      const fakeMsg = fakePaymentMessage(Date.now() + i);
      await sock.relayMessage(from, fakeMsg.message, { messageId: fakeMsg.key.id });
      console.log(`[00i] mensagem ${i + 1}/20 enviada com sucesso`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`[00i] erro ao enviar mensagem ${i + 1}:`, err);
    }
  }

  console.log('[00i] finalizado!');
  return;
}

if (command === 'bot' && args.length === 1) {
  try {
    const senderLid = normalizeJid(msg.key.participant || msg.key.remoteJid);
    await sock.sendMessage(from, {
      text: 'Oi, tô on 😼',
      mentions: [senderLid]
    });
  } catch (e) {
    console.error('Erro no comando bot:', e);
  }
}

// ================= BAN ================= //
if (['b', 'ban'].includes(command)) {
  try {
    // ======== Dados básicos ========
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const donoJid = normalizeJid(donoData.numerodono);
    const botJid = normalizeJid(donoData.bot);
    const senderJid = normalizeJid(await getRealSenderId(msg, from));
    const metadata = await getCachedGroupMetadata(from, true);
    const senderIsAdmin = isParticipantAdmin(metadata.participants, senderJid);
    const isDono = senderJid === donoJid;
    if (!senderIsAdmin && !isDono) {
      return sock.sendMessage(from, { text: '❌ Só administradores!' });
    }
    const targets = new Set();
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) targets.add(normalizeJid(quoted));
    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    mentions.forEach(j => targets.add(normalizeJid(j)));
    for (let i = 1; i < args.length; i++) {
      const num = args[i].replace(/\D/g, ''); // só números
      if (num) targets.add(`${num}@s.whatsapp.net`);
    }
    const validTargets = [...targets].filter(jid =>
      jid !== botJid && jid !== donoJid
    );
    if (validTargets.length === 0) {
      return sock.sendMessage(from, { text: '⚠️ Nenhum usuário válido para banir.' });
    }
    for (const jid of validTargets) {
      try {
        await sock.groupParticipantsUpdate(from, [jid], 'remove');
      } catch (e) {
        console.error(`[ERRO BAN] Falha ao remover ${jid}:`, e.message);
      }
    }
    await sock.sendMessage(from, { text: `✅ Removidos: ${validTargets.map(j => '@' + j.split('@')[0]).join(', ')}`, mentions: validTargets });

  } catch (err) {
    console.error('[ERRO BAN]', err);
    await sock.sendMessage(from, { text: '❌ Ocorreu um erro ao executar o comando.' });
  }
}

// ================= COMANDO APAGA ================= //
if (['apaga', 'd'].includes(command)) {
  try {
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const donoJid = normalizeJid(donoData.numerodono);
    const botJid = normalizeJid(donoData.bot);
    const senderJid = normalizeJid(await getRealSenderId(msg, from));
    const metadata = await getCachedGroupMetadata(from, true);
    const senderIsAdmin = isParticipantAdmin(metadata.participants, senderJid);
    const isDono = senderJid === donoJid;
    if (!senderIsAdmin && !isDono) {
      return sock.sendMessage(from, { text: '❌ Só administradores ou o dono podem usar esse comando!' });
    }
    const context = msg.message?.extendedTextMessage?.contextInfo;
    if (!context?.quotedMessage) {
      return sock.sendMessage(from, { text: '❌ Responda a uma mensagem para eu apagar!' });
    }
    const quotedId = context.stanzaId;
    const quotedParticipant = normalizeJid(context.participant || '');
    if (!quotedId) {
      return sock.sendMessage(from, { text: '⚠️ Não consegui identificar a mensagem para apagar.' });
    }
    await sock.sendMessage(from, {
      delete: {
        remoteJid: from,
        id: quotedId,
        participant: quotedParticipant
      }
    });    
  } catch (err) {
    console.error('[ERRO APAGA]', err);
    await sock.sendMessage(from, { text: '❌ Falha ao apagar mensagem! Verifique se o bot é administrador.' });
  }
}
  
  
// Comandos de ligar/desligar bot
if (command === 'botoff') {
  const senderJid = normalizeJid(msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid);
  const isDono = await checkDono(senderJid);
  if (!isDono) return sock.sendMessage(from, { text: '❌ Apenas o dono pode desligar o bot!' });
  const grupoConfig = getGrupoConfig(from);
  grupoConfig.botoff = true;
  saveGrupoConfig(from, grupoConfig);
  return sock.sendMessage(from, { text: '🛌🏻💤' });
}
if (command === 'boton') {
  const senderJid = normalizeJid(msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid);
  const isDono = await checkDono(senderJid);
  if (!isDono) return sock.sendMessage(from, { text: '❌ Apenas o dono pode ligar o bot!' });
  const grupoConfig = getGrupoConfig(from);
  grupoConfig.botoff = false;
  saveGrupoConfig(from, grupoConfig);

  return sock.sendMessage(from, { text: '😼cordei' });
}

// ========== COMANDO RANK ========== //
if (command === 'rank' || command === 'rankativos') {
  try {
    const arquivo = path.join('./dados', 'contador.json');
    const existe = await fs.access(arquivo).then(() => true).catch(() => false);
    if (!existe) {
      await fs.writeFile(arquivo, '{}', 'utf-8');
    }
    const dadosRaw = await fs.readFile(arquivo, 'utf-8');
    const dados = JSON.parse(dadosRaw || '{}');
    const grupoId = from;
    const contadorGrupo = dados[grupoId];
    if (!contadorGrupo || Object.keys(contadorGrupo).length === 0) {
      await sock.sendMessage(from, { text: "❌ Nenhum dado encontrado para este grupo ainda." });
      return;
    }
    const rankOrdenado = Object.entries(contadorGrupo)
      .sort(([, a], [, b]) => (b.mensagens || 0) - (a.mensagens || 0));
    const numerosBonitos = ['¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'];
    let rankMsg = '🏆 *RANK DOS MAIS ATIVOS DO GRUPO*\n\n';
    rankOrdenado.slice(0, 20).forEach(([usuario, cont], i) => {
      const numero = usuario.split('@')[0];
      const mensagens = cont.mensagens || 0;
      const audios = cont.audios || 0;
      const fotos = cont.fotos || 0;
      const videos = cont.videos || 0;
      const figurinhas = cont.figurinhas || 0;
      rankMsg += `╭━━━━ ⟡ ${numerosBonitos[i] || i + 1} ⟡ ━━━━╮\n`;
      rankMsg += `┃ 👤 @${numero}\n`;
      rankMsg += `┃ 💬 ᴍᴇɴsᴀɢᴇɴs: ${mensagens}\n`;
      rankMsg += `┃ 🦄 ғɪɢᴜʀɪɴʜᴀs: ${figurinhas}\n`;
      rankMsg += `┃ 🎵 ᴀᴜᴅɪᴏs: ${audios}\n`;
      rankMsg += `┃ 🤳🏻 ғᴏᴛᴏs: ${fotos}\n`;
      rankMsg += `┃ 📹 ᴠɪᴅᴇᴏs: ${videos}\n`;
      rankMsg += `╰━━━━━━━━━━━━╯\n\n`;
    });
    await sock.sendMessage(from, {
      text: rankMsg,
      mentions: Object.keys(contadorGrupo)
    });
  } catch (err) {
    console.error('[COMANDO RANK] Erro:', err);
    await sock.sendMessage(from, { text: "❌ Erro ao carregar o rank." });
  }
}
// ======== COMANDO CHECK =========== //
if (command === 'check') {
  try {
    const arquivo = path.join('./dados', 'contador.json');
    const existe = await fs.access(arquivo).then(() => true).catch(() => false);
    if (!existe) await fs.writeFile(arquivo, '{}', 'utf-8');

    const dadosRaw = await fs.readFile(arquivo, 'utf-8');
    const dados = JSON.parse(dadosRaw || '{}');
    const grupoId = from;
    const contadorGrupo = dados[grupoId];
    if (!contadorGrupo || Object.keys(contadorGrupo).length === 0) {
      return sock.sendMessage(from, { text: "❌ Nenhum dado encontrado para este grupo ainda." });
    }

    const targetJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!targetJid) {
      return sock.sendMessage(from, { text: "❌ Marque um usuário para ver o contador." });
    }

    const targetId = normalizeJid(targetJid);
    let cont = contadorGrupo[targetId];
    if (!cont) {
      const numero = targetId.split('@')[0];
      const key = Object.keys(contadorGrupo).find(k => k.includes(numero));
      cont = key ? contadorGrupo[key] : null;
    }
    if (!cont) {
      return sock.sendMessage(from, { text: "❌ Nenhum dado encontrado para este usuário." });
    }

    // Foto de perfil
    let thumbnailUrl = "https://files.catbox.moe/1z21h1.png";
    try {
      const profilePic = await sock.profilePictureUrl(targetId, 'image');
      if (profilePic) thumbnailUrl = profilePic;
    } catch {}

    const numero = targetId.split('@')[0];
    const rankMsg = `👤Lid ${numero}\n\n` +
                    `💬 Mensagens: ${cont.mensagens || 0}\n` +
                    `🦄 Figurinhas: ${cont.figurinhas || 0}\n` +
                    `🎵 Áudios: ${cont.audios || 0}\n` +
                    `🤳🏻 Fotos: ${cont.fotos || 0}\n` +
                    `📹 Vídeos: ${cont.videos || 0}`;

    await sock.sendMessage(from, {
      text: rankMsg,
      contextInfo: {
        externalAdReply: {
          title: `𝗦𝗮𝗻𝗶𝗗𝗼𝗺𝗶𝗻𝗮🚩`,
          body: "sanizinhabot✨",
          thumbnailUrl,
          sourceUrl: `https://wa.me/${numero}`,
          mediaType: 1
        }
      }
    });

  } catch (err) {
    console.error('[COMANDO CHECK] Erro:', err);
    await sock.sendMessage(from, { text: "❌ Erro ao carregar o contador do usuário." });
  }
}

// ================== COMANDO PERFIL ================== //
if (command === 'perfil') {
  try {
    const arquivo = path.join('./dados', 'contador.json');
    const existe = await fs.access(arquivo).then(() => true).catch(() => false);
    if (!existe) await fs.writeFile(arquivo, '{}', 'utf-8');

    const dadosRaw = await fs.readFile(arquivo, 'utf-8');
    const dados = JSON.parse(dadosRaw || '{}');
    const grupoId = from;
    const contadorGrupo = dados[grupoId];

    if (!contadorGrupo || Object.keys(contadorGrupo).length === 0) {
      return sock.sendMessage(from, { text: "❌ Nenhum dado encontrado para este grupo ainda." });
    }

    const senderId = normalizeJid(await getRealSenderId(msg, from));
    let cont = contadorGrupo[senderId];
    if (!cont) {
      const numero = senderId.split('@')[0];
      const key = Object.keys(contadorGrupo).find(k => k.includes(numero));
      cont = key ? contadorGrupo[key] : null;
    }
    if (!cont) {
      return sock.sendMessage(from, { text: "❌ Nenhum dado encontrado para você neste grupo." });
    }

    // Foto de perfil
    let thumbnailUrl = "https://files.catbox.moe/1z21h1.png";
    try {
      const profilePic = await sock.profilePictureUrl(senderId, 'image');
      if (profilePic) thumbnailUrl = profilePic;
    } catch {}

    const numero = senderId.split('@')[0];
    const perfilMsg = `👤𝗦𝗘𝗨 𝗣𝗘𝗥𝗙𝗜𝗟\nlid ${numero}\n\n` +
                      `💬 Mensagens: ${cont.mensagens || 0}\n` +
                      `🦄 Figurinhas: ${cont.figurinhas || 0}\n` +
                      `🎵 Áudios: ${cont.audios || 0}\n` +
                      `🤳🏻 Fotos: ${cont.fotos || 0}\n` +
                      `📹 Vídeos: ${cont.videos || 0}`;

    await sock.sendMessage(from, {
      text: perfilMsg,
      contextInfo: {
        externalAdReply: {
          title: `𝗦𝗮𝗻𝗶𝗗𝗼𝗺𝗶𝗻𝗮🚩`,
          body: "sanizinhabot✨",
          thumbnailUrl,
          sourceUrl: `https://wa.me/${numero}`,
          mediaType: 1
        }
      }
    });

  } catch (err) {
    console.error('[COMANDO PERFIL] Erro:', err);
    await sock.sendMessage(from, { text: "❌ Erro ao carregar seu perfil." });
  }
}
// ================= COMANDO BANGHOST ================= //
if (command === 'banghost') {
  try {
    // ======== Dados básicos ========
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const donoJid = normalizeJid(donoData.numerodono);
    const botJid = normalizeJid(donoData.bot);
    const senderJid = normalizeJid(await getRealSenderId(msg, from));

    // ======== Permissão ========
    const isDono = senderJid === donoJid;
    const isBot = senderJid === botJid;

    if (!isDono && !isBot) {
      return sock.sendMessage(from, { text: '❌ Apenas o dono ou o próprio bot podem usar esse comando!' });
    }

    // ======== Ler contador ========
    const contadorPath = path.join('./dados', 'contador.json');
    const contadorRaw = await fs.readFile(contadorPath, 'utf-8').catch(() => '{}');
    const contador = JSON.parse(contadorRaw || '{}');

    const grupoContador = contador[from] || {};
    const metadata = await getCachedGroupMetadata(from, true);
    const participantes = metadata.participants.map(p => normalizeJid(p.id));

    // ======== Determinar quem remover ========
    const remover = participantes.filter(jid => {
      const registro = grupoContador[jid];
      // remove se não existe no contador OU se mensagens = 0
      return !registro || (registro.mensagens || 0) === 0;
    }).filter(jid => jid !== donoJid && jid !== botJid); // nunca remove dono ou bot

    if (remover.length === 0) {
      return sock.sendMessage(from, { text: ' Nenhum usuário para remover. Todos estão ativos😼' });
    }

    // ======== Confirmar e remover ========
    await sock.sendMessage(from, {
      text: `📣Removendo ${remover.length} usuários inativos`
    });

    for (const jid of remover) {
      try {
        await sock.groupParticipantsUpdate(from, [jid], 'remove');

      } catch (err) {
      }
    }
    await sock.sendMessage(from, {
      text: `Remoção concluída!\n\nForam removidos ${remover.length} macacos`,
    });

  } catch (err) {
    console.error('[ERRO BANGHOST]', err);
    await sock.sendMessage(from, { text: '❌ Erro ao executar banghost.' });
  }
}

// ================= COMANDO INATIVO ================= //
if (command === 'inativo' || command === 'inativos') {
  try {
    const contadorPath = path.join('./dados', 'contador.json');
    const contadorRaw = await fs.readFile(contadorPath, 'utf-8').catch(() => '{}');
    const contador = JSON.parse(contadorRaw || '{}');

    const grupoContador = contador[from] || {};
    const metadata = await getCachedGroupMetadata(from, true);

    const inativos = metadata.participants
      .map(p => normalizeJid(p.id))
      .filter(jid => !grupoContador[jid] || (grupoContador[jid].mensagens || 0) === 0);

    if (inativos.length === 0) {
      return sock.sendMessage(from, { text: '🎉 Nenhum membro inativo encontrado!' });
    }

    let texto = `📉 *USUÁRIOS INATIVOS (${inativos.length})*\n\n`;
    inativos.forEach((jid, i) => {
      texto += `${i + 1}. @${jid.split('@')[0]}\n`;
    });

    await sock.sendMessage(from, {
      text: texto,
      mentions: inativos
    });

  } catch (err) {
    console.error('[ERRO INATIVO]', err);
    await sock.sendMessage(from, { text: '❌ Erro ao listar usuários inativos.' });
  }
}

if (command === 'resetrank') {
  try {
    const arquivo = path.join('./dados', 'contador.json');
    const donoDataRaw = await fs.readFile(donoPath, 'utf-8');
    const donoData = JSON.parse(donoDataRaw);
    const donoLid = donoData.numerodono;
    const botLid = donoData.bot;
    const senderLid = await getRealSenderId(msg, from);
    if (![donoLid, botLid].includes(senderLid)) {
      return sock.sendMessage(from, { text: '❌ Apenas o dono do bot ou o próprio bot podem resetar todo o rank!' });
    }
    await fs.writeFile(arquivo, '{}', 'utf-8');
    await sock.sendMessage(from, { text: '🧨 Todos os ranks foram *resetados com sucesso!*' });
  } catch (err) {
    console.error('[COMANDO RESETRANK] Erro:', err);
    await sock.sendMessage(from, { text: '❌ Erro ao tentar resetar o rank.' });
  }
}

// ======= COMANDO SANIDEV ========== //
if (command === 'sanidev') {
  const donoDataPath = './dados/dono.json';
  let donoData = { bot: "", numerodono: "", sanidev: "1" };
  try {
    const raw = await fs.readFile(donoDataPath, 'utf-8');
    donoData = JSON.parse(raw);
  } catch {}
  let senderJid = normalizeJid(msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid);
  if (donoData.sanidev === "1") {
    if (!donoData.bot) donoData.bot = senderJid;
    if (senderJid !== normalizeJid(donoData.numerodono) && senderJid !== normalizeJid(donoData.bot) && !msg.key.fromMe) {
      return sock.sendMessage(from, { text: '❌ Apenas o dono ou o bot podem usar este comando.' });
    }
    donoData.sanidev = "0";
    await fs.writeFile(donoDataPath, JSON.stringify(donoData, null, 2));
    return sock.sendMessage(from, {
      text: `✅ Comando SANIDEV autorizado. O campo "sanidev" foi atualizado para 0 e o bot registrado como ${donoData.bot}.`
    });
  }
  if (senderJid !== normalizeJid(donoData.numerodono) && senderJid !== normalizeJid(donoData.bot) && !msg.key.fromMe) {
    return sock.sendMessage(from, { text: '❌ Apenas o dono ou o bot podem usar este comando.' });
  }
  let targetJid;
  if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
    targetJid = msg.message.extendedTextMessage.contextInfo.participant;
  }
  if (!targetJid && msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
    targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
  }
  if (!targetJid && args[1]) {
    const numeroAlvo = args[1].replace(/\D/g, '');
    const grupos = Object.keys(groupMetadataCache);
    for (const grupoId of grupos) {
      const participantes = groupMetadataCache[grupoId]?.metadata?.participants || [];
      const found = participantes.find(p => normalizeJid(p.id).endsWith(numeroAlvo));
      if (found) {
        targetJid = found.id;
        break;
      }
    }
  }
  if (!targetJid) targetJid = senderJid;
  targetJid = normalizeJid(targetJid);
  return sock.sendMessage(from, { text: `O LID interno do usuário é: ${targetJid}` });
}

// ===== COMANDO LID =====
if (command === 'lid') {
  const senderLid = normalizeJid(msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid);
  return sock.sendMessage(from, { text: ` ${senderLid}` });
}
// ===== COMANDO NOVODONO =====
if (command === 'novodono') {
  const donoDataPath = './dados/dono.json';
  let donoData = { bot: "", numerodono: "", nick: "", nomebot: "" };
  try {
    const raw = await fs.readFile(donoDataPath, 'utf-8');
    donoData = JSON.parse(raw);
  } catch (e) {
    console.log('Arquivo dono.json não existe ou está corrompido, criando novo.');
  }
  const senderLid = normalizeJid(await getRealSenderId(msg, from));
  const donoLid = normalizeJid(donoData.numerodono);
  const botLid = normalizeJid(donoData.bot);
  const autorizado = senderLid === donoLid || senderLid === botLid || msg.key.fromMe;
  if (!autorizado) {
    console.log('❌ Usuário não autorizado a mudar o dono.');
    return sock.sendMessage(from, { text: '❌ Apenas o dono atual ou o bot podem trocar o dono.' });
  }
  if (!args[1]) {
    return sock.sendMessage(from, { text: '❌ Você precisa informar o número do novo dono. Ex: novodono 12345678910' });
  }
  const novoNumero = args[1].replace(/\D/g, '');
  const novoDonoLid = `${novoNumero}@lid`;
  donoData.numerodono = novoDonoLid;
  await fs.writeFile(donoDataPath, JSON.stringify(donoData, null, 2));
  return sock.sendMessage(from, {
    text: ` Novo dono configurado com sucesso!\nNúmero: ${novoNumero}\nLID interno do dono: ${novoDonoLid}`
  });
}

// ============ FECHAR / ABRIR GRUPO ============ //
if (content.toLowerCase() === 'f' || content.toLowerCase() === 'a') {
  const metadata = await getCachedGroupMetadata(from, true);
  const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
  const donoJid = await getDonoJid();
  const isDono = senderLid === donoJid;
  const botJidNormalized = normalizeJid(sock.user?.id);
  if (!(senderIsAdmin || isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Apenas adm, dono ou bot podem usar este comando!' });
  }

  try {
    if (content.toLowerCase() === 'f') {
      await sock.groupSettingUpdate(from, 'announcement'); // fecha grupo
    } else {
      await sock.groupSettingUpdate(from, 'not_announcement'); // abre grupo
    }
  } catch (e) {
    console.error('Erro ao atualizar grupo:', e);
    await sock.sendMessage(from, { text: '❌ Erro ao atualizar grupo. Verifique se o bot é administrador.' });
  }
  return;
}

// =========== MENU ============ //
if (command === 'menu') {
  const menuText = `
🪄 *×↡MENU✰* ✨

~𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦 𝗚𝗘𝗥𝗔𝗜𝗦~
> ✰꙰↬ 𝗿𝗮𝗻𝗸 / 𝗿𝗮𝗻𝗸𝗮𝘁𝗶𝘃𝗼𝘀
> ✰꙰↬ 𝗽𝗹𝗮𝘆 (baixar audios)
> ✰꙰↬ 𝗽𝗹𝗮𝘆𝘃𝗱 (baixar videos)
> ✰꙰↬ 𝘃𝗱𝗮𝘂 (converte vd)
> ✰꙰↬ 𝗙𝘀 (faz figurinhas)
> ✰꙰↬ 𝗳𝗶 (figurinha+Zoom)
> ✰꙰↬ 𝘀𝘁𝗺
> ✰꙰↬ 𝗽𝗶𝗻𝗴

~𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦-𝗔𝗗𝗠~
> ✰꙰↬ 𝗯 / 𝗯𝗮𝗻
> ✰꙰↬ 𝗮𝗻𝘁𝗶𝗹𝗶𝗻𝗸 on/off
> ✰꙰↬ 𝗮𝗻𝘁𝗶𝗳𝗮𝗸𝗲
> ✰꙰↬ 𝗮𝗹𝗹 <mensagem>
> ✰꙰↬ 𝗮𝘂𝘁𝗼𝘃𝗶𝘀𝘂 on/off
> ✰꙰↬ 𝗹𝗶𝘀𝘁𝗮𝗻𝗲𝗴𝗿𝗮 <numero>
> ✰꙰↬ 𝘀𝘁𝘁𝘀
> ✰꙰↬ 𝗳 (fecha o grupo)
> ✰꙰↬ 𝗮 (abre o grupo)
> ✰꙰↬ 𝗮𝗽𝗮𝗴𝗮 / 𝗱
> ✰꙰↬ 𝗹𝗶𝗺𝗽𝗮𝗿𝗮𝗻𝗸
> ✰꙰↬ 𝘁𝗼𝘁𝗮𝗴
> ✰꙰↬ 𝗮𝗱𝗺
> ✰꙰↬ 𝗹𝗶𝗺𝗽𝗮
> ✰꙰↬ 𝗺𝗮𝗿𝗰𝗮 / 𝗰𝗶𝘁𝗮

~𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦 𝗗𝗢𝗡𝗢~
> ✰꙰↬ 𝗮𝗻𝘁𝗶𝗽𝗿𝗼𝗺𝗼𝘁𝗲
> ✰꙰↬ 𝗮𝗻𝘁𝗶𝗽𝗼𝗿𝗻𝗼
> ✰꙰↬ 𝗯𝗼𝘁𝗼𝗳𝗳 / 𝗯𝗼𝘁𝗼𝗻
> ✰꙰↬ 𝘀𝗮𝗻𝗶𝗱𝗲𝘃
> ✰꙰↬ 𝗻𝗼𝘃𝗼𝗱𝗼𝗻𝗼
> ✰꙰↬ 𝗿𝗲𝘀𝗲𝘁𝗿𝗮𝗻𝗸
> ✰꙰↬ 𝗽𝗽 (promover)
> ✰꙰↬ 𝗿𝗲𝗯𝗮𝗶𝘅𝗮
> ✰꙰↬ 𝗯𝗮𝗻𝗴𝗵𝗼𝘀𝘁
> ✰꙰↬ 𝗶𝗻𝗮𝘁𝗶𝘃𝗼
> ✰꙰↬ 𝗿𝗲𝗶𝗻𝗶𝗰𝗶𝗮𝗿

~𝗜𝗡𝗙𝗢~
> ✰꙰↬ 𝗱𝗼𝗻𝗼
> ✰꙰↬ 𝗮𝗹𝘂𝗴𝗮𝗿

𝘉𝘰𝘵 𝘴𝘦𝘮 𝘱𝘳𝘦𝘧𝘪𝘹𝘰®
𝘋𝘰𝘯𝘰 @𝘀𝗮𝗻𝗶𝗼𝗳𝗰
`;
  await sock.sendMessage(from, { text: menuText });
  return;
}

// ================= PROMOVER ================= //
if (command === 'promover' || command === 'pp') {
  const donoDataRaw = await fs.readFile(donoPath, 'utf-8');
  const donoData = JSON.parse(donoDataRaw);
  const donoLid = normalizeJid(donoData.numerodono); // dono
  const botLid = normalizeJid(donoData.bot); // bot
  const senderLid = normalizeJid(await getRealSenderId(msg, from)); // quem enviou
  if (![donoLid, botLid].includes(senderLid)) {
    return sock.sendMessage(from, { text: '❌ Apenas o dono!' });
  }
  let targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] 
                || msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!targetJid) {
    return sock.sendMessage(from, { text: '❌ Marque ou responda a mensagem do usuário que deseja promover!' });
  }
  targetJid = normalizeJid(targetJid);
  if (targetJid === botLid) {
    return sock.sendMessage(from, { text: '❌ Não posso me promover sozinho!' });
  }
  try {
    await sock.groupParticipantsUpdate(from, [targetJid], 'promote');
    return sock.sendMessage(from, { 
      text: ` Usuário promovido a admin: @${targetJid.split('@')[0]}`, 
      mentions: [targetJid] 
    });
  } catch (e) {
    console.error('Erro ao promover:', e);
    return sock.sendMessage(from, { text: '❌ Falha ao promover. Verifique se o bot é admin!' });
  }
}

// ================= REBAIXAR ================= //
if (command === 'rebaixa' || command === 'demote') {
  const donoDataRaw = await fs.readFile(donoPath, 'utf-8');
  const donoData = JSON.parse(donoDataRaw);
  const donoLid = normalizeJid(donoData.numerodono); // dono
  const botLid = normalizeJid(donoData.bot); // bot
  const senderLid = normalizeJid(await getRealSenderId(msg, from)); // quem enviou
  if (![donoLid, botLid].includes(senderLid)) {
    return sock.sendMessage(from, { text: '❌ Apenas o dono!' });
  }
  let targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] 
                || msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!targetJid) {
    return sock.sendMessage(from, { text: '❌ Marque ou responda a mensagem do usuário que deseja rebaixar!' });
  }
  targetJid = normalizeJid(targetJid);
  if (targetJid === botLid) {
    return sock.sendMessage(from, { text: '❌ Não posso me rebaixar!' });
  }
  try {
    await sock.groupParticipantsUpdate(from, [targetJid], 'demote');
    return sock.sendMessage(from, { 
      text: ` Usuário rebaixado: @${targetJid.split('@')[0]}`, 
      mentions: [targetJid] 
    });
  } catch (e) {
    console.error('Erro ao rebaixar:', e);
    return sock.sendMessage(from, { text: '❌ Falha ao rebaixar. Verifique se o bot é admin!' });
  }
}

// ================= FIGURINHA (fs) ================= //
if (command === 'fs' || command === 'figu') {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  if (!quotedMsg) {
    await sock.sendMessage(from, {
      text: '❌ Responda a uma *foto* ou *vídeo de até 9s* para criar figurinha.',
      quoted: msg
    });
    return;
  }

  const isImage = !!quotedMsg.imageMessage;
  const isVideo = !!quotedMsg.videoMessage;
  const mediaType = isImage ? 'imageMessage' : isVideo ? 'videoMessage' : null;

  if (!mediaType) {
    await sock.sendMessage(from, {
      text: '❌ Apenas fotos ou vídeos de até 9s podem virar figurinha.',
      quoted: msg
    });
    return;
  }
  const mediaData = quotedMsg[mediaType];
  if (!mediaData || !mediaData.url) {
    await sock.sendMessage(from, {
      text: '❌ Esta mídia não está mais disponível. Envie novamente e tente de novo.',
      quoted: msg
    });
    return;
  }
  if (isVideo && ((quotedMsg.videoMessage?.seconds ?? 0) > 9)) {
    await sock.sendMessage(from, {
      text: '❌ O vídeo precisa ter no máximo 9 segundos.',
      quoted: msg
    });
    return;
  }
  try {
    await sock.sendMessage(from, { react: { text: '🛠️', key: msg.key } });
    await sock.sendMessage(from, { text: '_fazendo figu✨😸_' }, { quoted: msg });
    const buffer = await downloadMediaMessage({ message: { [mediaType]: mediaData } }, 'buffer');
    if (!buffer) throw new Error('Falha ao baixar a mídia.');
    const tempDir = './dados/temp';
    await fs.mkdir(tempDir, { recursive: true });
    const timestamp = Date.now();
    const tempInput = path.join(tempDir, `${timestamp}.${isImage ? 'jpg' : 'mp4'}`);
    const tempOutput = path.join(tempDir, `${timestamp}.webp`);
    await fs.writeFile(tempInput, buffer);

    const ffmpegFilter = isImage
      ? 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
      : 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15';
    const ffmpegCmd = isImage
      ? `ffmpeg -i "${tempInput}" -vf "${ffmpegFilter}" -vcodec libwebp -lossless 1 -qscale 75 -preset default -loop 0 -an "${tempOutput}"`
      : `ffmpeg -t 9 -i "${tempInput}" -vf "${ffmpegFilter}" -vcodec libwebp -lossless 0 -preset default -loop 0 -an -vsync 0 "${tempOutput}"`;
    await execPromise(ffmpegCmd);
    await fs.access(tempOutput);
    const stickerBuffer = await fs.readFile(tempOutput);
    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
    await fs.unlink(tempInput);
    await fs.unlink(tempOutput);
  } catch (e) {
    console.error('Erro ao criar figurinha:', e);
    await sock.sendMessage(from, {
      text: '❌ Erro ao criar figurinha.',
      quoted: msg
    });
  }
  return;
}

// ================= FIGURINHA (fi) ================= //
if (command === 'fi' || command === 'fazerfigurinha') {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quotedMsg) {
    await sock.sendMessage(from, {
      text: 'Responda a uma *foto* ou *vídeo de até 9s* para criar figurinha.',
      quoted: msg
    });
    return;
  }
  const isImage = !!quotedMsg.imageMessage;
  const isVideo = !!quotedMsg.videoMessage;
  const mediaType = isImage ? 'imageMessage' : isVideo ? 'videoMessage' : null;
  if (!mediaType) {
    await sock.sendMessage(from, {
      text: '❌ Apenas fotos ou vídeos de até 9s.',
      quoted: msg
    });
    return;
  }
  const mediaData = quotedMsg[mediaType];
  if (!mediaData || !mediaData.url) {
    await sock.sendMessage(from, {
      text: '❌ Esta mídia não está mais disponível. Envie novamente e tente de novo.',
      quoted: msg
    });
    return;
  }
  if (isVideo && ((quotedMsg.videoMessage?.seconds ?? 0) > 9)) {
    await sock.sendMessage(from, {
      text: '❌ O vídeo precisa ter no máximo 9 segundos.',
      quoted: msg
    });
    return;
  }
  try {
    await sock.sendMessage(from, { react: { text: '🛠️', key: msg.key } });
    await sock.sendMessage(from, { text: '_fazendo figu✨😸_' }, { quoted: msg });
    const buffer = await downloadMediaMessage({ message: { [mediaType]: mediaData } }, 'buffer');
    if (!buffer) throw new Error('Falha ao baixar a mídia.');
    const tempDir = './dados/temp';
    await fs.mkdir(tempDir, { recursive: true });
    const timestamp = Date.now();
    const tempInput = path.join(tempDir, `${timestamp}.${isImage ? 'jpg' : 'mp4'}`);
    const tempOutput = path.join(tempDir, `${timestamp}.webp`);
    await fs.writeFile(tempInput, buffer);
    const zoomFilter = isImage
      ? 'scale=600:600,crop=512:512:(in_w-512)/2:(in_h-512)/2'
      : 'scale=600:600:force_original_aspect_ratio=increase,crop=512:512:(in_w-512)/2:(in_h-512)/2,fps=15';
    const ffmpegCmd = isImage
      ? `ffmpeg -i "${tempInput}" -vf "${zoomFilter}" -vcodec libwebp -lossless 1 -qscale 75 -preset default -loop 0 -an "${tempOutput}"`
      : `ffmpeg -t 9 -i "${tempInput}" -vf "${zoomFilter}" -vcodec libwebp -lossless 0 -preset default -loop 0 -an -vsync 0 "${tempOutput}"`;
    await execPromise(ffmpegCmd);
    await fs.access(tempOutput);
    const stickerBuffer = await fs.readFile(tempOutput);
    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
    await fs.unlink(tempInput);
    await fs.unlink(tempOutput);
  } catch (e) {
    console.error('Erro ao criar figurinha:', e);
    await sock.sendMessage(from, {
      text: '❌ Erro ao criar figurinha.',
      quoted: msg
    });
  }
  return;
}

// =========== PLAY (áudio do YouTube) ==================

if (command === 'play') {
  const texto = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption || '';
  const query = texto.replace(/^([#])?play\b/i, '').trim(); 

  if (!query) {
    return await sock.sendMessage(from, { text: '*_Você precisa enviar o nome da música ou o link do YouTube._*' }, { quoted: msg });
  }

  await sock.sendMessage(from, { react: { text: "🎶", key: msg.key } });
  await sock.sendMessage(from, { text: '_*🔎💕 Procurando áudio, aguarde...*_'}, { quoted: msg });

  let videoInfo, videoUrl;
  try {
    if (query.includes('youtu')) {
      videoUrl = query.includes('/shorts/') 
        ? `https://www.youtube.com/watch?v=${query.split('/shorts/')[1].split(/[?&]/)[0]}` 
        : query;
      const results = await yts(videoUrl);
      videoInfo = results.videos[0];
    } else {
      const results = await yts(query);
      videoInfo = results.videos[0];
    }
    if (!videoInfo) {
      return await sock.sendMessage(from, { text: '❌ Nenhum resultado encontrado no YouTube.', quoted: msg });
    }
    videoUrl = videoInfo.url;
  } catch (e) {
    console.error('Erro na busca do YouTube:', e);
    return await sock.sendMessage(from, { text: '❌ Erro ao buscar no YouTube.', quoted: msg });
  }
  const legenda = `🎵 *${videoInfo.title}*\n` +
                  `🕒 Duração: *${videoInfo.timestamp}*\n` +
                  `👀 Visualizações: *${videoInfo.views.toLocaleString()}*\n` +
                  `📅 Publicado: *${videoInfo.ago}*\n` +
                  `🔗 ${videoInfo.url}`;
  await sock.sendMessage(from, {
    text: legenda,
    contextInfo: {
      externalAdReply: {
        showAdAttribution: false,
        mediaType: 2,
        title: videoInfo.title,
        body: `👀 ${videoInfo.views.toLocaleString()} ✰꙰↬ 🕒 ${videoInfo.timestamp} ✰꙰↬ 📅 ${videoInfo.ago}`,
        thumbnailUrl: videoInfo.thumbnail,
        mediaUrl: videoUrl,
        sourceUrl: videoUrl
      }
    }
  }, { quoted: msg });
  try {
    const tempDir = './dados/temp';
    await fs.mkdir(tempDir, { recursive: true });
    const outputAudio = path.join(tempDir, `audio_${Date.now()}.mp3`);
    const outputVideo = path.join(tempDir, `video_${Date.now()}.mp4`);
    try {
      await execPromise(`yt-dlp -x --audio-format mp3 -o "${outputAudio}" "${videoUrl}"`);
    } catch {
      console.warn("Falha no download direto de áudio, tentando via vídeo completo...");
      await execPromise(`yt-dlp -f bestvideo+bestaudio/best -o "${outputVideo}" "${videoUrl}"`);
      await execPromise(`ffmpeg -i "${outputVideo}" -vn -ar 44100 -ac 2 -b:a 192k "${outputAudio}"`);
      await fs.unlink(outputVideo).catch(() => {});
    }
    const audioBuffer = await fs.readFile(outputAudio);
    await sock.sendMessage(from, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: false
    }, { quoted: msg });
    await fs.unlink(outputAudio).catch(() => {});
  } catch (e) {
    console.error("Erro ao baixar ou enviar áudio:", e);
    await sock.sendMessage(from, { text: '❌ Erro ao baixar ou enviar o áudio.', quoted: msg });
  }
}

// =========== PLAYVD (vídeo do YouTube) ============
if (command === 'playvd') {
  const query = args.slice(1).join(' ').trim();

  if (!query) {
    return await sock.sendMessage(from, { 
      text: '*_Você precisa enviar o nome da música ou o link do YouTube._*' 
    }, { quoted: msg });
  }

  await sock.sendMessage(from, { react: { text: "🎬", key: msg.key } });
  await sock.sendMessage(from, { text: '_*🔎💕 Procurando vídeo, aguarde...*_' }, { quoted: msg });

  let videoInfo, videoUrl;
  try {
    if (query.includes('youtu')) {
      videoUrl = query.includes('/shorts/') 
        ? `https://www.youtube.com/watch?v=${query.split('/shorts/')[1].split(/[?&]/)[0]}`
        : query;
      const results = await yts(videoUrl);
      videoInfo = results.videos[0];
    } else {
      const results = await yts(query);
      videoInfo = results.videos[0];
    }
    if (!videoInfo) return await sock.sendMessage(from, { text: '❌ Nenhum resultado encontrado no YouTube.', quoted: msg });
    videoUrl = videoInfo.url;
  } catch (e) {
    console.error('Erro na busca do YouTube:', e);
    return await sock.sendMessage(from, { text: '❌ Erro ao buscar no YouTube.', quoted: msg });
  }

  const fs = require('fs').promises;
  const path = require('path');
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  const tempDir = './dados/temp';
  await fs.mkdir(tempDir, { recursive: true });

  const outputPath = path.join(tempDir, `video_${Date.now()}.mp4`);
  const cmd = `yt-dlp -f "mp4" -o "${outputPath}" "${videoUrl}"`;

  try {
    await execPromise(cmd);

    // ✅ Lê o arquivo após download
    const videoBuffer = await fs.readFile(outputPath);

    await sock.sendMessage(from, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: `🎥 ${videoInfo.title}`,
    }, { quoted: msg });

    // limpa arquivo temporário
    await fs.unlink(outputPath);
  } catch (err) {
    console.error("Erro ao baixar ou enviar vídeo:", err);
    await sock.sendMessage(from, { text: '❌ Erro ao baixar ou enviar o vídeo.', quoted: msg });
  }
}

// ================== VIDEOAUDIO (converter vídeo marcado em áudio) ==================
if (command === 'vdau') {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const videoMsg = quoted?.videoMessage;

  if (!videoMsg) {
    return await sock.sendMessage(from, { text: '❌ Você precisa marcar um vídeo para converter em áudio.', quoted: msg });
  }

  const durationSeconds = videoMsg.seconds || 0;
  if (durationSeconds > 600) {
    return await sock.sendMessage(from, { text: '❌ O vídeo é maior que 10 minutos. Limite máximo é 10 minutos.', quoted: msg });
  }

  await sock.sendMessage(from, { text: '🎵 Convertendo vídeo em áudio, aguarde...', quoted: msg });

  const fs = require('fs').promises;
  const path = require('path');
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  const tempDir = './dados/temp';
  await fs.mkdir(tempDir, { recursive: true });

  const tmpVideoPath = path.join(tempDir, `video_${Date.now()}.mp4`);
  const tmpAudioPath = path.join(tempDir, `audio_${Date.now()}.mp3`);

  try {
    const stream = await downloadContentFromMessage(videoMsg, 'video');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    await fs.writeFile(tmpVideoPath, buffer);
  } catch (err) {
    console.error('Erro ao baixar vídeo marcado:', err);
    return await sock.sendMessage(from, { text: '❌ Erro ao baixar o vídeo marcado.', quoted: msg });
  }

  try {
    await execPromise(`ffmpeg -i "${tmpVideoPath}" -vn -ar 44100 -ac 2 -b:a 192k "${tmpAudioPath}"`);

    const audioBuffer = await fs.readFile(tmpAudioPath);
    await sock.sendMessage(from, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: false
    }, { quoted: msg });

    // limpa arquivos temporários
    await fs.unlink(tmpVideoPath);
    await fs.unlink(tmpAudioPath);
  } catch (err) {
    console.error('Erro ao converter ou enviar áudio:', err);
    try { await fs.unlink(tmpVideoPath); } catch {}
    try { await fs.unlink(tmpAudioPath); } catch {}
    await sock.sendMessage(from, { text: '❌ Erro ao converter ou enviar o áudio.', quoted: msg });
  }
}

// ======================= ANTIPROMOTE ================= //
if (command === 'antipromote') {
  if (!(senderIsAdmin || isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Apenas adm, dono ou bot podem usar este comando!' });
  }

  const action = args[1]?.toLowerCase();
  if (!['on','off'].includes(action)) return await sock.sendMessage(from, { text: 'Use: antipromote on/off' });

  const currentMetadata = await sock.groupMetadata(from);
const grupoConfig = await getGrupoConfig(from, currentMetadata);
console.log(`[INFO] Config do grupo "${grupoConfig.nome}" carregada`);
  grupoConfig.antipromote = action === 'on';
  await saveGrupoConfig(from, grupoConfig);

  return await sock.sendMessage(from, { text: `✅ Anti-promote agora está ${grupoConfig.antipromote ? 'ativado' : 'desativado'}` });
}

// ================= COMANDO ANTILINK ================= //
if (command === 'antilink') {
  // Atualiza metadata do grupo
  const metadata = await getCachedGroupMetadata(from, true);
  const grupoConfig = await getGrupoConfig(from, metadata);

  const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
  const isDono = senderLid === (await getDonoJid());
  const botJidNormalized = normalizeJid(sock.user?.id);

  if (!(senderIsAdmin || isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Apenas adm, dono ou bot podem usar este comando!' });
  }

  const action = args[1]?.toLowerCase();
  if (action === 'on') grupoConfig.antilink = true;
  else if (action === 'off') grupoConfig.antilink = false;
  else return await sock.sendMessage(from, { text: 'Use: antilink on/off' });

  await saveGrupoConfig(from, grupoConfig);
  return await sock.sendMessage(from, { text: `✅ Anti-link agora está ${grupoConfig.antilink ? 'ativado' : 'desativado'}` });
}

// ================= COMANDO MARCA / CITA ================= //
if (['marca', 'cita'].includes(command)) {
  try {
    const metadata = await getCachedGroupMetadata(from, true);
    const participantes = metadata?.participants?.map(p => p.id) || [];
    const isAdm = isParticipantAdmin(metadata.participants, senderLid);
    const isDono = senderLid === (await getDonoJid());
    const isBot = normalizeJid(sock.user?.id) === senderLid;
    if (!(isAdm || isDono || isBot))
      return sock.sendMessage(from, { text: '❌ Apenas adm, dono ou bot podem usar este comando!' });
    if (!participantes.length)
      return sock.sendMessage(from, { text: '❌ Não foi possível obter a lista de participantes.' });
    const texto = args.slice(1).join(' ').trim() || '';
    const lerMais = String.fromCharCode(8206).repeat(1000);
    const lista = participantes.map((id, i) => `${i + 1}. @${id.split('@')[0]}`).join('\n');
    let ppUrl = 'https://saniofc.github.io/griffinoria/';
    try { ppUrl = await sock.profilePictureUrl(from, 'image'); } catch {}
    const { data: thumb } = await axios.get(ppUrl, { responseType: 'arraybuffer' });
    await sock.sendMessage(from, {
      text: `📢🥳 𝐁𝐎𝐑𝐀 𝐈𝐍𝐓𝐄𝐑𝐀𝐆𝐈𝐑 ✨🥳\n\n${lerMais}\n${texto}${lista}`,
      mentions: participantes,
      contextInfo: {
        mentionedJid: participantes,
        externalAdReply: {
          title: '𝐒𝐀𝐈 𝐃𝐀 𝐌𝐎𝐈𝐓𝐀 𝐏𝐋𝐀𝐓𝐈𝐍𝐀😂❕',
          body: '𝐌𝐄𝐌𝐁𝐑𝐎𝐒 𝐈𝐍𝐀𝐓𝐈𝐕𝐎𝐒 𝐕𝐀𝐈 𝐃𝐄 𝐅🪦',
          thumbnail: thumb,
          mediaType: 2,
          showAdAttribution: false,
          sourceUrl: 'sanizinhabot' + senderLid.split('@')[0],
        }
      }
    });
  } catch (e) {
    console.error('Erro no marca:', e);
    sock.sendMessage(from, { text: '❌ Erro ao marcar todos.' });
  }
}

// ================= COMANDO TOTAG ================= //
if (command === 'totag') {
  try {
    // ======== Dados básicos ========
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const donoJid = normalizeJid(donoData.numerodono);
    const botJid = normalizeJid(donoData.bot);
    const senderJid = normalizeJid(await getRealSenderId(msg, from));

    const metadata = await getCachedGroupMetadata(from, true);
    const participantes = metadata.participants.map(p => normalizeJid(p.id));

    const senderIsAdmin = isParticipantAdmin(metadata.participants, senderJid);
    const isDono = senderJid === donoJid;

    // ======== Permissão ========
    if (!senderIsAdmin && !isDono) {
      return sock.sendMessage(from, { text: '❌ Apenas administradores ou o dono podem usar esse comando!' });
    }

    // ======== Mensagem respondida ========
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctxInfo?.quotedMessage) {
      return sock.sendMessage(from, { text: '❌ Responda a uma mensagem para usar o totag.' }, { quoted: msg });
    }

    const quoted = ctxInfo.quotedMessage;
    let conteudo = {};

    // ======== Verificar tipo de mídia ========
    const baixarBuffer = async (media, tipo) => {
      const stream = await downloadContentFromMessage(media, tipo);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      return buffer;
    };

    if (quoted.imageMessage) {
      const img = await baixarBuffer(quoted.imageMessage, 'image');
      conteudo = {
        image: img,
        caption: quoted.imageMessage.caption || '📢 @todos',
        mentions: participantes
      };
    }
    else if (quoted.videoMessage) {
      const vid = await baixarBuffer(quoted.videoMessage, 'video');
      conteudo = {
        video: vid,
        caption: quoted.videoMessage.caption || '📢 @todos',
        mentions: participantes
      };
    }
    else if (quoted.stickerMessage) {
      const st = await baixarBuffer(quoted.stickerMessage, 'sticker');
      conteudo = {
        sticker: st,
        mentions: participantes
      };
    }
    else if (quoted.audioMessage) {
      const au = await baixarBuffer(quoted.audioMessage, 'audio');
      conteudo = {
        audio: au,
        mimetype: quoted.audioMessage.mimetype || 'audio/ogg; codecs=opus',
        ptt: quoted.audioMessage.ptt || false,
        mentions: participantes
      };
    }
    else if (quoted.documentMessage) {
      const doc = await baixarBuffer(quoted.documentMessage, 'document');
      conteudo = {
        document: doc,
        mimetype: quoted.documentMessage.mimetype,
        fileName: quoted.documentMessage.fileName || 'document',
        mentions: participantes
      };
    }
    else if (quoted.conversation) {
      conteudo = {
        text: quoted.conversation,
        mentions: participantes
      };
    }
    else if (quoted.extendedTextMessage?.text) {
      conteudo = {
        text: quoted.extendedTextMessage.text,
        mentions: participantes
      };
    }
    else {
      conteudo = {
        text: '📢 @todos',
        mentions: participantes
      };
    }

    // ======== Enviar ========
    await sock.sendMessage(from, conteudo);

  } catch (err) {
    console.error('[ERRO TOTAG]', err);
    await sock.sendMessage(from, {
      text: '📢 @todos',
      mentions: metadata.participants.map(p => p.id)
    });
  }
}

// ======== COMANDO ALL============ //
if (command === 'all') {
  try {
    // ======== Dados básicos ========
    const donoData = JSON.parse(await fs.readFile(donoPath, 'utf-8'));
    const donoJid = normalizeJid(donoData.numerodono);
    const botJid = normalizeJid(sock.user?.id);
    const senderJid = normalizeJid(await getRealSenderId(msg, from));

    const metadata = await getCachedGroupMetadata(from, true);
    const senderIsAdmin = isParticipantAdmin(metadata.participants, senderJid);
    const isDono = senderJid === donoJid;

    console.log('[DEBUG][ALL]', { senderJid, senderIsAdmin, isDono });

    // ======== Permissão ========
    if (!senderIsAdmin && !isDono && senderJid !== botJid) {
      return sock.sendMessage(from, { text: '❌ Apenas administradores, o dono ou o bot podem usar este comando!' });
    }

    // ======== Checar participantes ========
    if (!metadata?.participants?.length) {
      return sock.sendMessage(from, { text: '❌ Não foi possível obter a lista de participantes.' });
    }

    // ======== Montar mensagem ========
    const mensagem = args.slice(1).join(' ').trim() || '📢 *@todos*';
    const mentions = metadata.participants.map(p => normalizeJid(p.id));

    // ======== Enviar ========
    await sock.sendMessage(from, {
      text: mensagem,
      mentions
    });

    console.log(`[ALL] Mensagem enviada por ${senderJid} para ${mentions.length} membros`);

  } catch (err) {
    console.error('[ERRO ALL]', err);
    await sock.sendMessage(from, {
      text: '❌ Ocorreu um erro ao tentar enviar a mensagem a todos.'
    });
  }
}
// ========= COMANDO AUTOVISU ========== //
if (command === 'autovisu') {
  const metadata = await getCachedGroupMetadata(from, true);
  const grupoConfig = await getGrupoConfig(from, metadata);
  const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
  const isDono = senderLid === (await getDonoJid());
  const botJidNormalized = normalizeJid(sock.user?.id);
  if (!(senderIsAdmin || isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Apenas adm' });
  }
  const action = args[1]?.toLowerCase();
  if (action === 'on') grupoConfig.autovisu = true;
  else if (action === 'off') grupoConfig.autovisu = false;
  else return await sock.sendMessage(from, { text: 'Use: autovisu on/off' });
  await saveGrupoConfig(from, grupoConfig);
  return await sock.sendMessage(from, { text: `✅ Autovisu agora está ${grupoConfig.autovisu ? 'ativado' : 'desativado'}` });
}

// ======== COMANDO REINICIAR======== //
if (command === 'reiniciar') {
  const isDono = senderLid === (await getDonoJid());
  const botJidNormalized = normalizeJid(sock.user?.id);
  if (!(isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Apenas o dono ou o próprio bot podem usar este comando!' });
  }
  await sock.sendMessage(from, { text: '♻️ Reiniciando o bot, aguarde alguns segundos...' });
  console.log(`[INFO] Reinicialização solicitada por ${senderLid} em ${from}`);
  await new Promise(resolve => setTimeout(resolve, 2000)); // pequena pausa antes de reiniciar

  process.exit(0);
}

// ========== COMANDO: /stm ========== //
if (command === 'stm') {
  try {
    const start = process.hrtime.bigint();
    await sock.sendMessage(from, { text: '⏳ Calculando status...' });
    const end = process.hrtime.bigint();
    const latency = Number(end - start) / 1e6; // converte para ms
    const responseTime = latency / 1000; // em segundos

    // Memória
    const mem = process.memoryUsage();
    const memUsedMB = mem.heapUsed / 1024 / 1024;
    const memTotalGB = os.totalmem() / 1024 / 1024 / 1024;
    const memUsagePercent = (memUsedMB / (memTotalGB * 1024)) * 100;

    // Velocidade do bot (mensagens/s) – estimativa simples
    const uptimeSeconds = process.uptime();
    const speed = Math.max(0, 1 / (latency / 1000)); // msg/s

    // Grupos ativos
    const allChats = await sock.groupFetchAllParticipating();
    const groupCount = Object.keys(allChats).length;

    // Tempo ativo
    const uptimeMinutes = uptimeSeconds / 60;

    // Status com cores
    const latencyStatus = latency < 50 ? '🟢 Excelente' : latency < 200 ? '🟡 Médio' : '🔴 Ruim';
    const memStatus = memUsagePercent < 50 ? '🟢 Baixo' : memUsagePercent < 75 ? '🟡 Médio' : '🔴 Alto';
    const groupStatus = groupCount < 20 ? '🟢 Baixo' : groupCount < 50 ? '🟡 Médio' : '🔴 Alto';

    // Monta a mensagem
    const pingMsg = `📡 *PAINEL DE STATUS*  
━━━━━━━━━━━━━━━━━━━━━━━━
📈 *LATÊNCIA & TEMPO DE RESPOSTA*  
  ✰꙰↬ Latência: ${latency.toFixed(2)} ms (${latencyStatus})
  ✰꙰↬ Tempo de Resposta: ${responseTime.toFixed(3)} s
━━━━━━━━━━━━━━━━━━━━━━━━
🚀 *DESEMPENHO & UPTIME*  
  ✰꙰↬ Velocidade: ${speed.toFixed(2)} msg/s  
  ✰꙰↬ Tempo Ativo: ${uptimeMinutes.toFixed(2)} minutos
━━━━━━━━━━━━━━━━━━━━━━━━
💾 *MEMÓRIA*  
  ✰꙰↬ Usada: ${memUsedMB.toFixed(2)} MB  
  ✰꙰↬ Total: ${memTotalGB.toFixed(2)} GB  
  ✰꙰↬ Uso: ${memUsagePercent.toFixed(2)}% (${memStatus})
━━━━━━━━━━━━━━━━━━━━━━━━
👥 *GRUPOS ATIVOS*: ${groupCount} (${groupStatus})  
━━━━━━━━━━━━━━━━━━━━━━━━
📊 *EXTRAS*  
  ✰꙰↬ Node.js: ${process.version}  
  ✰꙰↬ Plataforma: ${os.platform()}  
  ✰꙰↬ Arquitetura: ${os.arch()}`;

    await sock.sendMessage(from, { text: pingMsg });

  } catch (err) {
    console.error('[COMANDO STM] Erro:', err);
    await sock.sendMessage(from, { text: '❌ Erro ao gerar painel de status.' });
  }
}

// ================= PING ================= //
if (command === 'ping') {
  const start = Date.now();
  await sock.sendMessage(from, { text: '🏓 Pong!' });
  const latency = Date.now() - start;
  return await sock.sendMessage(from, { text: `🏓 Pong! \n⏱ Tempo de resposta: ${latency}ms` });
}

// ======== PREFIXO ========= //
if (command === 'prefixo') {
  await sock.sendMessage(from, { text: 'nao preciso de prefixo😼!' });
}

if (command === 'dono') {
  const link = "https://wa.me/5521977231625";
  const titulo = "@saniofc";
  const descricao = "sanizinhabot✨";
  const thumbnail = "https://wa.me/5521977231625";

  try {
    await sock.sendMessage(from, {
      text: "",
      contextInfo: {
        externalAdReply: {
          title: titulo,
          body: descricao,
          thumbnailUrl: thumbnail,
          sourceUrl: link,
          mediaType: 1,
          renderLargerThumbnail: false,
          showAdAttribution: false
        }
      }
    });
  } catch (e) {
    console.error('Erro ao enviar contato do dono:', e);
  }
}

if (command === 'alugar') {
  const link = "https://wa.me/5521977231625";
  const titulo = "𝗔𝗹𝘂𝗴𝘂𝗲𝗹 𝗱𝗼 𝗯𝗼𝘁";
  const descricao = "5$ = 15𝗱𝗶𝗮𝘀";
  const thumbnail = "https://wa.me/5521977231625";
  try {
    await sock.sendMessage(from, {
      text: "para mais preços\nfale com o dono↓",
      contextInfo: {
        externalAdReply: {
          title: titulo,
          body: descricao,
          thumbnailUrl: thumbnail,
          sourceUrl: link,
          mediaType: 1,
          renderLargerThumbnail: false,
          showAdAttribution: false
        }
      }
    });
  } catch (e) {
    console.error('Erro ao enviar contato do dono:', e);
  }
}

if (command === 'listanegra' || command === 'tiradalista' || command === 'blacklist') {
  const grupoId = from;

  // Força atualizar metadata do grupo para pegar novos admins
  const metadata = await getCachedGroupMetadata(grupoId, true);
  const config = await getGrupoConfig(grupoId);

  const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
  const donoJid = await getDonoJid();
  const isDono = senderLid === donoJid;
  const botJidNormalized = normalizeJid(sock.user?.id);

  console.log(`[DEBUG] senderLid: ${senderLid}`);
  console.log(`[DEBUG] senderIsAdmin: ${senderIsAdmin}`);
  console.log(`[DEBUG] isDono: ${isDono}`);
  console.log(`[DEBUG] botJidNormalized: ${botJidNormalized}`);

  // Checa se é admin, dono ou bot
  if (!(senderIsAdmin || isDono || senderLid === botJidNormalized)) {
    return await sock.sendMessage(from, { text: '❌ Você não é admin, dono ou o bot, não pode usar este comando!' });
  }

// ================= ADD ==================
if (command === 'listanegra') {
  let alvoJid;

  // 1️⃣ Se for resposta a uma mensagem
  if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
    alvoJid = msg.message.extendedTextMessage.contextInfo.participant;
  }

  // 2️⃣ Se tiver @menção
  else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
    alvoJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
  }

  // 3️⃣ Se foi passado número no comando
  else if (args[1]) {
    const numero = args[1].replace(/\D/g, '');
    alvoJid = numero + '@s.whatsapp.net';
  }

  // 4️⃣ Se nada for detectado
  if (!alvoJid) {
    return await sock.sendMessage(from, {
      text: '❌ Use: listanegra <responder mensagem / @menção / número>',
    });
  }

  // Evita duplicação
  if (!config.listanegra.includes(alvoJid)) {
    config.listanegra.push(alvoJid);
    await saveGrupoConfig(grupoId, config);
    await sock.sendMessage(from, { text: `🚫 @${alvoJid.split('@')[0]} adicionado à lista negra!`, mentions: [alvoJid] });
  } else {
    await sock.sendMessage(from, { text: `ℹ️ @${alvoJid.split('@')[0]} já está na lista negra.`, mentions: [alvoJid] });
  }
}

// ================= REMOVE ==================
if (command === 'tiradalista') {
  let alvoJid;

  // 1️⃣ Se for resposta a uma mensagem
  if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
    alvoJid = msg.message.extendedTextMessage.contextInfo.participant;
  }

  // 2️⃣ Se tiver @menção
  else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
    alvoJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
  }

  // 3️⃣ Se foi passado número no comando
  else if (args[1]) {
    const numero = args[1].replace(/\D/g, '');
    alvoJid = numero + '@s.whatsapp.net';
  }

  // 4️⃣ Se nada for detectado
  if (!alvoJid) {
    return await sock.sendMessage(from, {
      text: '❌ Use: tiradalista <responder mensagem / @menção / número>',
    });
  }

  // Remove se existir
  if (config.listanegra.includes(alvoJid)) {
    config.listanegra = config.listanegra.filter(u => u !== alvoJid);
    await saveGrupoConfig(grupoId, config);
    await sock.sendMessage(from, { text: `✅ @${alvoJid.split('@')[0]} removido da lista negra!`, mentions: [alvoJid] });
  } else {
    await sock.sendMessage(from, { text: `ℹ️ @${alvoJid.split('@')[0]} não está na lista negra.`, mentions: [alvoJid] });
  }
}

  // ================= LISTAR ==================
  if (command === 'blacklist') {
    if (!config.listanegra.length) return await sock.sendMessage(from, { text: 'ℹ️ Lista negra vazia.' });

    let txt = '🚫 Lista Negra do Grupo:\n';
    config.listanegra.forEach((u, i) => txt += `${i+1}. ${u}\n`);
    await sock.sendMessage(from, { text: txt });
  }
}

if (command === 'limpa') {
  try {
    const donoJid = await getDonoJid();
    const metadata = await getCachedGroupMetadata(from, true);
    const senderIsAdmin = isParticipantAdmin(metadata.participants, senderLid);
    const isDono = senderLid === donoJid;

    if (!senderIsAdmin && !isDono) {
      return await sock.sendMessage(from, { text: '❌ Apenas ADM' });
    }
    const invisivelBloco = '\n😼'.repeat(60);
    const repeatCount = 10;
    for (let i = 0; i < repeatCount; i++) {
      await sock.sendMessage(from, { text: invisivelBloco });
    }
  } catch (e) {
    console.error('Erro no comando LIMPA:', e);
    await sock.sendMessage(from, { text: '❌ Falha ao executar LIMPA.' });
  }
}

// ================= COMANDO ADM ================= //
if (command === 'adm') {
  try {
    const metadata = await getCachedGroupMetadata(from, true);
    const participantes = metadata.participants || [];

    const senderIsAdmin = isParticipantAdmin(participantes, senderLid);
    const donoJid = await getDonoJid();
    const isDono = senderLid === donoJid;

    if (!senderIsAdmin && !isDono) {
      return await sock.sendMessage(from, { text: '❌ Apenas ADM ou dono podem usar este comando!' });
    }

    const admins = participantes.filter(p => p.admin || p.id === donoJid).map(p => p.id);
    if (!admins.length) return sock.sendMessage(from, { text: '❌ Nenhum ADM encontrado.' });

    let texto = '👑 *Administradores do grupo* 👑\n\n';
    admins.forEach((id, i) => {
      texto += `${i + 1}. @${id.split('@')[0]}\n`;
    });

    await sock.sendMessage(from, { text: texto.trim(), mentions: admins });
    console.log(`[DEBUG] ADM executado por ${senderLid}`);

  } catch (e) {
    console.error('Erro no comando ADM:', e);
    await sock.sendMessage(from, { text: '❌ Falha ao listar ADM.' });
  }
}
// ================= STATUS ================= //
if (command === 'stts') {
  const currentMetadata = await sock.groupMetadata(from);
const grupoConfig = await getGrupoConfig(from, currentMetadata);
  const statusText = `
*STATUS DO GRUPO*  

> *Antilink:* ${grupoConfig.antilink ? '✅' : '❌'}
> *Antiporno:* ${grupoConfig.antiporno ? '✅' : '❌'}
> *Antipromote:* ${grupoConfig.antipromote ? '✅' : '❌'}
> *Autovisu:* ${grupoConfig.autovisu ? '✅' : '❌'}
> *Botoff:* ${grupoConfig.botoff ? '✅' : '❌'}
`;
  return await sock.sendMessage(from, { text: statusText });
}
}

// ================= HANDLE PARTICIPANTES ================= //
async function handleParticipants(update) {
  const { id: groupId, participants, action } = update;
  if (!Array.isArray(participants) || !action) return;

  const grupoConfig = await getGrupoConfig(groupId);

  if (action === 'add') {
    for (const user of participants) {
      try {
        const userLid = normalizeJid(user); // ex: 89099801231363@lid
        const lidLimpo = userLid.split('@')[0];
        if (grupoConfig.listanegra.includes(userLid)) {
          console.log(`[LISTA NEGRA] ${userLid} está na lista negra, removendo do grupo...`);

          await sock.groupParticipantsUpdate(groupId, [userLid], 'remove');
          await sock.sendMessage(groupId, { text: `🚫 @${lidLimpo}, você está na lista negra do grupo!`, mentions: [userLid] });
          continue;
        }
      } catch (e) {
        console.error(`[PARTICIPANTES] Erro ao processar usuário ${user}:`, e);
      }
    }
  }
}
// ======== AUX ============== //
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function updateAdminsLid(grupoId) {
  try {
    await delay(2000);
    const metadata = await sock.groupMetadata(grupoId);
    if (!metadata?.participants) return;
    const admins = metadata.participants
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => p.id);

    const admData = await loadAdmins();
admData[grupoId] = admins;
await saveAdmins(admData);

    console.log(chalk.green(`[ADM] ${grupoId} atualizado com ${admins.length} admins`));
  } catch (e) {
    console.error('[ADM] Erro ao atualizar adm.json:', e);
  }
}

// ===== HANDLE GROUP UPDATE ====== //
async function handleGroupUpdate(update, sock) {
  // ✅ Verifica se o sock está definido
  if (!sock) {
    console.log('[handleGroupUpdate] ⚠️ Socket não definido ainda, ignorando atualização...');
    return;
  }

  const grupoId = update.id;
  const grupoConfig = await getGrupoConfig(grupoId);
  if (!grupoConfig?.antipromote) return;

  const donoPath = './dados/dono.json';
  let donoData = { bot: "", numerodono: "" };
  try {
    const raw = await fs.readFile(donoPath, 'utf-8'); // fs.promises se fs já é fs.promises
    donoData = JSON.parse(raw);
  } catch (e) {
    console.warn("Não foi possível ler o dono.json", e);
  }
  const donoLid = normalizeJid(donoData?.numerodono || '');
  const botLid = normalizeJid(donoData?.bot || '');
  const senderLid = update.author ? normalizeJid(update.author) : null;
  const autorLid = normalizeJid(update.author);
  const participantesLid = update.participants.map(normalizeJid);
  
  const metadata = await sock.groupMetadata(grupoId);
  if (!metadata?.participants) return;

  const participantsMap = {};
  metadata.participants.forEach(p => {
    participantsMap[normalizeJid(p.id)] = p;
  });

  const oldAdminData = await loadAdmins();
  const oldGroupAdmins = oldAdminData[grupoId] || [];
  let houveMudancaDeAdmin = false;

  for (const alvoLid of participantesLid) {
    const autorPart = participantsMap[autorLid];
    const alvoPart = participantsMap[alvoLid] || { id: alvoLid };

    const autorIsAdmin = isAdmin(autorPart);
    const alvoIsAdmin = isAdmin(alvoPart);
    const alvoWasAdmin = oldGroupAdmins.includes(alvoLid);


    // ======== PROMOTE / DEMOTE ======= //
    if (update.action === 'promote' || update.action === 'demote') {
      const rebaixar = [];
      const ignorarAlvo = [donoLid, botLid].includes(alvoLid) || [donoLid, botLid].includes(autorLid);
      if (!ignorarAlvo && (alvoIsAdmin || update.action === 'promote')) rebaixar.push(alvoLid);
      if (![donoLid, botLid].includes(autorLid)) rebaixar.push(autorLid);

      if (rebaixar.length > 0) {
        try {
          await sock.groupParticipantsUpdate(grupoId, rebaixar, 'demote');
          await sock.sendMessage(grupoId, {
            text: `⛔ Tentativa de ${update.action} inválida! Punidos.`,
            mentions: rebaixar
          });
          houveMudancaDeAdmin = true;
        } catch (e) {
          console.error('[ANTIPROMOTE] Erro ao rebaixar admins:', e);
        }
      }
    }

    // ================= REMOVE ================= //
    if (update.action === 'remove' && alvoWasAdmin) {
      if (![donoLid, botLid].includes(autorLid)) {
        await sock.groupParticipantsUpdate(grupoId, [autorLid], 'demote');
      }
      await sock.groupParticipantsUpdate(grupoId, [alvoLid], 'add');
      await sock.sendMessage(grupoId, {
        text: `⛔ Tentativa de remoção de admin inválida! Punidos.`,
        mentions: [autorLid, alvoLid]
      });
      houveMudancaDeAdmin = true;
    }
  }
  // Atualiza adm.json **só se houve mudança**
  if (houveMudancaDeAdmin) {
    try {
      await updateAdminsLid(grupoId);
    } catch (err) {
      console.error('[DEBUG] Erro ao atualizar adm.json:', err);
    }
  }
}

// ======= EXPORT ====== //
function setSocket(s) {
  sock = s;
}

module.exports = {
  initFiles,
  isAdmin,
  isLink,
  isMassTag,
  isPaymentMessage,
  saveJSON,
  loadAdmins,
  saveAdmins,
  updateAdmins,
  getGrupoConfig,
  saveGrupoConfig,
  normalizeJid,
  getRealSenderId,
  getDonoJid,
  checkDono,
  handleUpsert,
  handleCommand,
  handleParticipants,
  handleGroupUpdate,
  setSocket
};