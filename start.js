// ======================= IMPORTS ======================= //
const fs = require('fs').promises;
const readline = require('readline');
const fsSync = require('fs'); // compatibilidade com funções síncronas
const { exec } = require('child_process');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const index = require('./index.js');

const number = process.env.WHATSAPP_NUMBER || 'default';
const qrcodePath = `./dados/sessoes/session-${number}`;
const pairingCode = process.argv.includes("--code");

const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(text, answer => { rl.close(); resolve(answer); }));
};

let sock;
let reconnecting = false;
let retryCount = 0;
let runningInstance = false;

// ===================== FUNÇÕES AUXILIARES ================= //
function normalizeJid(jid) {
  if (!jid) return null;
  return jid.split(':')[0];
}

async function getRealSenderId(msg, from) {
  if (from.endsWith('@g.us')) {
    return normalizeJid(msg.key.participant || msg.participant);
  }
  return normalizeJid(from);
}

// ======================= START BOT ======================= //
async function STBLK() {
  if (runningInstance) return;
  runningInstance = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(qrcodePath);
    const { version } = await fetchLatestBaileysVersion();

    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws && sock.ws.close && sock.ws.close(); } catch {}
      try { sock.end && sock.end(); } catch {}
      sock = null;
    }

    const logger = P({ level: 'error' });
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['Ubuntu', 'Edge', '110.0.1587.56'],
      keepAliveIntervalMs: 10000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true
    });
    index.setSocket(sock);

    // ======================= MENSAGENS ======================= //
    sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
      try {
        const msg = m.messages?.[0];
        if (!msg) return;

        if (msg.messageStubType === 'E2EE_NOTIFICATION') return;
        if (!msg.message) return;
        if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return;

        const from = msg.key.remoteJid;
        const sender = await getRealSenderId(msg, from);
        if (!sender) return;

        const senderLid = normalizeJid(sender);
        const pushName = msg.pushName || 'Usuário';
        const isGroup = from.endsWith('@g.us');
        let nomeGrupoOuPrivado = isGroup ? 'Grupo Desconhecido' : 'Privado';

        if (isGroup) {
          try {
            const metadata = await sock.groupMetadata(from);
            nomeGrupoOuPrivado = metadata.subject || nomeGrupoOuPrivado;
          } catch {}
        }

        const tipo = Object.keys(msg.message)[0];
        let conteudoMsg = '';
        switch (tipo) {
          case 'conversation': conteudoMsg = msg.message.conversation; break;
          case 'extendedTextMessage': conteudoMsg = msg.message.extendedTextMessage.text; break;
          case 'imageMessage': conteudoMsg = '📷 Foto'; break;
          case 'videoMessage': conteudoMsg = '🎥 Vídeo'; break;
          case 'stickerMessage': conteudoMsg = '🧩 Figurinha'; break;
          case 'audioMessage': conteudoMsg = '🎧 Áudio'; break;
          case 'documentMessage': conteudoMsg = '📄 Documento'; break;
          case 'contactMessage': conteudoMsg = '👤 Contato'; break;
          default: conteudoMsg = `[${tipo}]`;
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📍 Chat:', nomeGrupoOuPrivado);
        console.log('👤 Usuário:', `${pushName} @${senderLid.split('@')[0]}`);
        console.log('💬 Mensagem:', conteudoMsg);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // AUTOVISU
        try {
          const grupoPath = `./dados/grupos/${from}.json`;
          const configRaw = await fs.readFile(grupoPath, 'utf-8').catch(() => null);
          if (configRaw) {
            const configGrupo = JSON.parse(configRaw);
            if (configGrupo.autovisu && !msg.key.fromMe) {
              await sock.readMessages([msg.key]);
            }
          }
        } catch (err) {
          console.error('Erro autovisu:', err);
        }

        // EXECUTA COMANDOS
        await index.handleUpsert(m).catch(e => console.error('Erro handleUpsert:', e));
        await index.handleCommand(msg, senderLid).catch(e => console.error('Erro handleCommand:', e));

      } catch (e) {
        if (String(e).includes('No session found to decrypt message')) return;
        console.error('[MESSAGES.UPSERT]', e);
      }
    });

    // ================= PARTICIPANTES ================= //
sock.ev.on('group-participants.update', async (update) => {
  try {
    await index.handleParticipants(update);
    await index.handleGroupUpdate(update, sock); // ✅ aqui passamos o sock
  } catch (e) {
    console.error('Erro em group-participants.update:', e);
  }
});

    // ================= CONEXÃO ================= //
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr && !pairingCode) require('qrcode-terminal').generate(qr, { small: true });

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reconnecting) return;
        reconnecting = true;

        if (statusCode !== DisconnectReason.loggedOut) {
          retryCount++;
          const waitTime = Math.min(30000, 5000 * retryCount);
          console.log(`Tentando reconectar em ${waitTime / 1000} segundos...`);

          setTimeout(async () => {
            try {
              runningInstance = false;
              reconnecting = false;
              await STBLK();
            } catch (err) {
              console.error('Erro ao reconectar:', err);
            }
          }, waitTime);
        } else {
          console.log("Sessão encerrada pelo logout. Excluindo sessão...");
          exec(`rm -rf ${qrcodePath}`, (err) => { if (err) console.error(err); process.exit(0); });
        }

      } else if (connection === 'open') {
        retryCount = 0;
        reconnecting = false;
        console.log(`\n✅ BOT CONECTADO COM SUCESSO!`);
      }
    });

    // ================= PAREAMENTO ================= //
    if (pairingCode && !sock.authState.creds.registered) {
      let phoneNumber = await question("Digite o número do bot (sem + e sem espaços): ");
      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");
      let code = await sock.requestPairingCode(phoneNumber);
      code = code?.match(/.{1,4}/g)?.join("-") || code;
      console.log("🔗 Código de pareamento:", code);
    }

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('Erro geral na inicialização do bot:', err);
  } finally {
    runningInstance = false;
  }
}

// ======================= INÍCIO ======================= //
STBLK().catch(e => console.error("Erro ao iniciar o bot:", e));