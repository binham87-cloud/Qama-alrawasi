// شغّل هذا الملف مرة واحدة في Console للنسخة القديمة على كل جهاز قبل الانتقال.
// ينزّل نسخة من مفاتيح قمة الرواسي فقط؛ لا يغيّر أو يحذف أي قيمة.
(() => {
  const values = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith("qama_")) values[key] = localStorage.getItem(key);
  }
  const payload = {
    format: "qama-legacy-localstorage-v1",
    exportedAt: new Date().toISOString(),
    origin: location.origin,
    values
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `qama-local-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  console.log(`QAMA: exported ${Object.keys(values).length} local keys without modifying them.`);
})();
