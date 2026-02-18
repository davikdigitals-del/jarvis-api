const express = require("express");
const cors = require("cors");

const app = express();

// ================== MIDDLEWARE ==================
app.use(express.json());

// TEMP (Phase 1): allow all origins
app.use(cors({ origin: true }));

// ================== HELPERS ==================
function isBookingIntent(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("book") ||
    t.includes("booking") ||
    t.includes("appointment") ||
    t.includes("schedule") ||
    t.includes("reserve") ||
    t.includes("consultation")
  );
}

// ================== ROUTES ==================

app.post("/v1/chat", async (req, res) => {
  const {
    text = "",
    bookingUrl = "",
    siteId = "",
    domain = "",
  } = req.body || {};

  console.log("Jarvis chat:", { siteId, domain, text });

  // ---- Booking intent ----
  if (isBookingIntent(text)) {
    if (bookingUrl) {
      return res.json({
        replyText: "Sure. I’m taking you to the booking page now.",
        actions: [
          {
            type: "open_url",
            url: bookingUrl,
          },
        ],
      });
    }

    return res.json({
      replyText:
        "I can help you book a service, but no booking page is set yet.",
    });
  }

  // ---- Default reply (Phase 1 Q&A placeholder) ----
  return res.json({
    replyText:
      "I can help answer questions about this website or help you book a service. How can I help you?",
  });
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Jarvis API running on port", PORT);
});
