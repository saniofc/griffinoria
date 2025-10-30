// server.js - Rota /gerar-preferencia CORRIGIDA

// POST /gerar-preferencia
// body: { 
//   valor: 5, 
//   titulo: "VIP 24h", 
//   quantity: 1, 
//   external_reference: "USER_ID", // Novo: ID do usuário
//   back_urls: { success: "...", failure: "..." } // Novo: URLs de retorno
// }
app.post("/gerar-preferencia", async (req, res) => {
  try {
    const { 
      valor = 5, 
      titulo = "Produto VIP", 
      quantity = 1, 
      external_reference, // 👈 Pega o ID do usuário
      back_urls // 👈 Pega as URLs de retorno do frontend
    } = req.body;

    // Validações básicas
    if (typeof valor !== "number" || valor <= 0) {
      return res.status(400).json({ error: "valor inválido" });
    }
    
    // Validação de segurança: É crucial que o back_urls seja fornecido pelo frontend agora
    if (!back_urls || !back_urls.success) {
         return res.status(400).json({ error: "URLs de retorno ausentes." });
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
      // 1. Usa as URLs enviadas pelo frontend (que contém o ID do cliente)
      back_urls: back_urls, 
      auto_return: "approved",
      // 2. Envia o ID do cliente para o Mercado Pago rastrear
      external_reference: external_reference || 'sem-referencia', 
      // notification_url: `${SITE_URL}/webhook/mp` // opcional: Descomente para Webhooks
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
