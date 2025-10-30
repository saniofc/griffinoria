// server.js (ESM)
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // se usar Node >=18 pode usar global fetch, mas deixei node-fetch pra compatibilidade
import process from "process";

const app = express();
app.use(cors());
app.use(express.json());

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || "https://gri-t9jx.onrender.com"; // ajuste

if (!MP_ACCESS_TOKEN) {
  console.error("MP_ACCESS_TOKEN não definido. Defina a variável de ambiente no Render.");
  process.exit(1);
}

// Rota de teste
app.get("/", (req, res) => res.send("Servidor MercadoPago ativo"));

// POST /gerar-preferencia
// body: { valor: 5, titulo: "VIP 24h", quantity: 1 }
app.post("/gerar-preferencia", async (req, res) => {
  try {
    const { valor = 5, titulo = "Produto VIP", quantity = 1 } = req.body;

    // Validações básicas
    if (typeof valor !== "number" || valor <= 0) {
      return res.status(400).json({ error: "valor inválido" });
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
      back_urls: {
        success: `${SITE_URL}/?status=success`,
        failure: `${SITE_URL}/?status=failure`,
        pending: `${SITE_URL}/?status=pending`,
      },
      auto_return: "approved",
      // notification_url: `${SITE_URL}/webhook/mp` // opcional
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
