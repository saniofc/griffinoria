// server.js (ESM) - CORRIGIDO E COMPLETO

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; 
import process from "process";

// --- Configuração Inicial ---
// 1. Inicializa o APP Express (CORREÇÃO DO ReferenceError)
const app = express(); 

// Variáveis de ambiente
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
// Use a URL do Render como base para Webhooks
const RENDER_URL = "https://gri-t9jx.onrender.com"; 

if (!MP_ACCESS_TOKEN) {
  console.error("❌ MP_ACCESS_TOKEN não definido. O servidor não pode funcionar.");
  // Em um ambiente de produção, você pode querer sair do processo:
  // process.exit(1); 
}

// Middlewares
app.use(cors());
// O Mercado Pago envia notificações (webhooks) como texto,
// então precisamos de um parser que trate tanto JSON quanto texto.
app.use(express.json());
app.use(express.text({ type: 'application/x-www-form-urlencoded' }));


// --- Rotas ---

// Rota de teste
app.get("/", (req, res) => res.send("✅ Servidor MercadoPago e Express ativo."));

// 1. Rota para Geração de Preferência de Pagamento
app.post("/gerar-preferencia", async (req, res) => {
  try {
    const { 
      valor = 5, 
      titulo = "Produto VIP", 
      quantity = 1, 
      external_reference, // ID do usuário (vindo do localStorage no frontend)
      back_urls // URLs de retorno para o GitHub Pages (saniofc.github.io)
    } = req.body;

    // Validação de dados essenciais
    if (typeof valor !== "number" || valor <= 0 || !back_urls || !back_urls.success) {
      return res.status(400).json({ error: "Parâmetros de pagamento inválidos ou incompletos." });
    }

    const payload = {
      items: [
        {
          title: String(titulo).slice(0, 120),
          quantity: Number(quantity) || 1,
          unit_price: Number((Math.round(valor * 100) / 100).toFixed(2)),
          currency_id: "BRL",
        },
      ],
      // CORREÇÃO CRUCIAL: Usa as URLs do frontend para o redirecionamento
      back_urls: back_urls, 
      auto_return: "approved",
      // Envia o ID do cliente para o Mercado Pago rastrear
      external_reference: external_reference || 'sem-referencia', 
      
      // Rota de notificação (Webhook) para ativação segura e futura do VIP
      notification_url: `${RENDER_URL}/webhook/mp`, 
    };

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro MP criar preference:", data);
      return res.status(response.status).json({ error: data });
    }

    return res.json({ preferenceId: data.id, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point });
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:", err);
    return res.status(500).json({ error: "erro_interno", detail: String(err) });
  }
});

// 2. Rota para Receber Notificações de Webhook do Mercado Pago (Futura Ativação VIP)
app.post("/webhook/mp", (req, res) => {
    // ESTA ROTA É A CHAVE PARA O SEU SITE DAR O CÓDIGO VIP DE FORMA SEGURA.
    
    console.log("Notificação recebida do Mercado Pago:", req.query, req.body);

    const topic = req.query.topic || req.query.type;
    const resourceId = req.query.id || req.query['data.id'];

    if (topic === 'payment' && resourceId) {
        // Ação: Chamar a API do Mercado Pago para ver o status do pagamento
        // Ex: fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, ...)
        
        // Se APROVADO:
        // 1. Gerar Código VIP.
        // 2. SALVAR CÓDIGO VIP no Firebase (associado ao external_reference).
        
        console.log(`Webhook de pagamento recebido para ID: ${resourceId}`);
    }

    // É ABSOLUTAMENTE ESSENCIAL responder com status 200 (OK) para o Mercado Pago
    // para que ele não tente reenviar a notificação infinitamente.
    res.status(200).send("OK");
});


// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}. API URL: ${RENDER_URL}`));
