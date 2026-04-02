window.SC_POOLS = ["GRND", "POLY", "WGNW", "TRNSPRT", "KRKHF"];
window.SC_POOL_LABELS = {
  GRND: "Grnd",
  POLY: "Poly",
  WGNW: "Wgnw",
  TRNSPRT: "Trnsprt",
  KRKHF: "Krkhf"
};
window.scPoolLabel = function(code){
  const key = (code || "GRND").toString().trim().toUpperCase();
  return window.SC_POOL_LABELS[key] || key;
};
window.scNormalizePool = function(code){
  const key = (code || "GRND").toString().trim().toUpperCase();
  return window.SC_POOLS.includes(key) ? key : "GRND";
};
