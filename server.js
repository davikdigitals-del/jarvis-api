const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

// TEMP: allow all origins (tighten later)
app.use(cors({ origin: true }));

app.post("/v1/chat", async (req, res) => {
  const { text, siteId, domain } = req.body || {};

  // later: validate siteId + domain
  return res.json({
    replyText: `Jarvis is live on Render 🚀 You said: "${text || ""}"`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Jarvis API running on port", PORT));
