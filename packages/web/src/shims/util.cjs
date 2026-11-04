// Minimal browser stand-in for node:util, used only by is-my-json-valid's code generator.
function inspect(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function format(f, ...args) {
  let i = 0;
  const s = String(f).replace(/%[sdijO%]/g, (m) => (m === "%%" ? "%" : i < args.length ? (m === "%j" || m === "%O" ? inspect(args[i++]) : String(args[i++])) : m));
  return [s, ...args.slice(i).map(String)].join(" ");
}
module.exports = { format, inspect, inherits: (c, p) => Object.setPrototypeOf(c.prototype, p.prototype) };
