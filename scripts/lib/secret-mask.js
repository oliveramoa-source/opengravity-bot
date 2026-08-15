// Utilidades compartidas para nunca imprimir un token de Telegram en texto plano.
// Usado por diag-webhook.js y rotate-token.js.

function maskToken(token) {
  if (!token) return '<TOKEN_VACIO>';
  return `<TOKEN_OCULTO_${token.length}_CHARS>`;
}

// Reemplaza cualquier aparicion literal del token por su version enmascarada.
// Sirve para URLs de la API de Telegram (ej. getWebhookInfo) o mensajes de error
// que puedan traerlo embebido.
function maskOccurrences(text, token) {
  if (!token || !text) return text;
  return text.split(token).join(maskToken(token));
}

// Red de seguridad final para mensajes de error inesperados: por si el texto
// trae un token que no es el que tenemos en memoria (ej. el viejo, en un error
// de otra llamada). Patron generico de token de Telegram: <digitos>:<32+ chars>.
function stripUnknownTokenPatterns(text) {
  if (!text) return text;
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<TOKEN_OCULTO>');
}

// Volcado de bytes seguro: solo bordes, nunca el medio, para detectar
// basura tipo \r\n pegada al copiar/pegar sin exponer el secret completo.
function maskBytesDump(token) {
  const buf = Buffer.from(token, 'utf8');
  const EDGE = 4;
  if (buf.length <= EDGE * 2) {
    return `[${buf.length} bytes totales, token corto: no se muestran para evitar reconstruirlo]`;
  }
  const toHexC = (b) => `${b.toString(16).padStart(2, '0')}(${JSON.stringify(String.fromCharCode(b))})`;
  const head = [...buf.slice(0, EDGE)].map(toHexC).join(' ');
  const tail = [...buf.slice(-EDGE)].map(toHexC).join(' ');
  const hiddenCount = buf.length - EDGE * 2;
  return `primeros ${EDGE} bytes: ${head}\nultimos ${EDGE} bytes:  ${tail}\n[${hiddenCount} bytes ocultos en el medio, total ${buf.length} bytes]`;
}

module.exports = { maskToken, maskOccurrences, stripUnknownTokenPatterns, maskBytesDump };
