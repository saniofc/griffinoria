import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference } from "mercadopago";

const app = express();
app.use(cors());
app.use(express.json());

// === CONFIG MERCADO PAGO ===
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// === ROTA DE PAGAMENTO ===
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { title, price, quantity } = req.body;

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [
          {
            title,
            quantity,
            currency_id: "BRL",
            unit_price: price,
          },
        ],
      },
    });

    res.json({ id: result.id, init_point: result.init_point });
  } catch (error) {
    console.error("Erro ao criar pagamento:", error);
    res.status(500).json({ error: "Erro ao criar pagamento" });
  }
});

// === TESTE DE VIDA ===
app.get("/", (req, res) => {
  res.send("Servidor ativo e conectado ao Mercado Pago 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
