export function load(url, context, next) {
  if (url.endsWith(".svg")) {
    return { format: "module", shortCircuit: true, source: 'export default "pitwall-mark.svg";' };
  }
  return next(url, context);
}
