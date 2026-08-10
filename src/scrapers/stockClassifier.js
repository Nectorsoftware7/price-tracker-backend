function classifyStockText(rawText) {
  if (!rawText) return { status: "unknown", raw: rawText, quantity: null };

  const text = rawText.toLowerCase();

  if (/out of stock|sold out|currently unavailable|not available/.test(text)) {
    return { status: "out_of_stock", raw: rawText, quantity: 0 };
  }

  const lowStockMatch = text.match(/only\s+(\d+)\s+left/);
  if (lowStockMatch) {
    return { status: "low_stock", raw: rawText, quantity: parseInt(lowStockMatch[1], 10) };
  }

  if (/in stock|add to cart|buy now/.test(text)) {
    return { status: "in_stock", raw: rawText, quantity: null };
  }

  return { status: "unknown", raw: rawText, quantity: null };
}

module.exports = { classifyStockText };
