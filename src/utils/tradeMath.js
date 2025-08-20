export function computeBuyAveragePriceCents(oldAvgCents, oldQty, buyPxCents, buyQty) {
  const safeOldQty = Number(oldQty) || 0;
  const safeBuyQty = Number(buyQty) || 0;
  const oldCost = Math.round((Number(oldAvgCents) || 0) * safeOldQty);
  const addCost = Math.round(Number(buyPxCents) * safeBuyQty);
  const newQty = safeOldQty + safeBuyQty;
  const newAvgPriceCents = newQty > 0 ? Math.floor((oldCost + addCost) / newQty) : 0;
  return { newAvgPriceCents, newQuantity: newQty };
}

export function computeSellRealizedPnlCents(avgPxCents, sellPxCents, sellQty) {
  const pnlPerShare = Number(sellPxCents) - Number(avgPxCents);
  return Math.round(pnlPerShare * (Number(sellQty) || 0));
}

