// server.js (ESM) - CORRIGIDO E COMPLETO

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; 
import process from "process";
// Importar o dotenv é uma boa prática se você for testar localmente.
// O Render lida com process.env automaticamente, mas a linha abaixo não atrapalha:
// import dotenv from 'dotenv'; dotenv.config(); 

// --- Configuração Inicial ---
const app = express(); 

// Variáveis de ambiente
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
// CORREÇÃO: Usamos o link do seu Render para o Webhook
const RENDER_URL = "https://gri-t9jx.onrender.com"; 

if (!MP_ACCESS_TOKEN) {
  console.error("❌ MP_ACCESS_TOKEN não definido. O servidor não pode gerar pagamentos.");
}

// Middlewares
app.use(cors());
// Permite que o servidor entenda o JSON e o texto dos webhooks
app.use(express.json());
app.use(express.text({ type: 'application/x-www-form-urlencoded' }));


// --- Rotas ---

// Rota de teste
app.get("/", (req, res) => res.send("✅ Servidor MercadoPago e Express ativo."));

// 1. Rota para Geração de Preferência de Pagamento
// CORREÇÃO: O endpoint correto é /gerar-preferencia, conforme chamado no frontend
app.post("/gerar-preferencia", async (req, res) => {
  try {
    const { 
      valor = 5, 
      titulo = "Produto VIP", 
      quantity = 1, 
      external_reference, // ID do usuário
      back_urls // URLs de retorno
    } = req.body;

    if (!MP_ACCESS_TOKEN) {
         return res.status(503).json({ error: "Serviço indisponível. Token do Mercado Pago não configurado." });
    }

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
      back_urls: back_urls, 
      auto_return: "approved",
      external_reference: external_reference || 'sem-referencia', 
      
      // Rota de notificação (Webhook)
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

    // Retorna o ID da preferência para o frontend renderizar o botão
    return res.json({ preferenceId: data.id, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point });
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:", err);
    return res.status(500).json({ error: "erro_interno", detail: String(err) });
  }
});

// 2. Rota para Receber Notificações de Webhook do Mercado Pago
app.post("/webhook/mp", (req, res) => {
    // IMPORTANTE: Aqui você deve implementar a lógica para:
    // 1. Buscar o status real do pagamento usando o resourceId.
    // 2. Se APROVADO, SALVAR o Código VIP ou a ativação no Firebase.
    
    console.log("Notificação recebida do Mercado Pago:", req.query, req.body);

    const topic = req.query.topic || req.query.type;
    const resourceId = req.query.id || req.query['data.id'];

    if (topic === 'payment' && resourceId) {
        console.log(`Webhook de pagamento recebido para ID: ${resourceId}. Próxima ação: Verificar status e ativar VIP no Firebase.`);
    }

    // Resposta essencial para o Mercado Pago
    res.status(200).send("OK");
});


// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}. API URL: ${RENDER_URL}`));
