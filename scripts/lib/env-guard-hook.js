#!/usr/bin/env node

// Hook de seguridad (PreToolUse, ver .claude/settings.json) — bloquea cualquier lectura del
// contenido de .env / .env.* sin importar la herramienta (Read, Grep, Bash, PowerShell) ni los
// flags usados. Motivo: 3 incidentes reales de exposición de secretos en texto plano en este
// repo (el más reciente, 29/08/2026, un Grep con -o que no recortó como se esperaba y volcó
// TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY, GOOGLE_OAUTH_REFRESH_TOKEN y otros en texto plano).
// Una instrucción en CLAUDE.md ya existía y no alcanzó — esto es una traba técnica real: revisa
// el comando/ruta real antes de que la herramienta se ejecute, no depende de que la sesión se
// acuerde de la regla.
//
// Recibe el JSON del evento PreToolUse por stdin y devuelve permissionDecision:"deny" si detecta
// ".env" en el comando (Bash/PowerShell) o en la ruta (Read/Grep) — excepto ".env.example", que
// es un template sin secretos reales y no tiene motivo para bloquearse.

let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const ti = input.tool_input || {};
    const target = String(ti.command || ti.file_path || ti.path || '');
    const withoutExample = target.replace(/\.env\.example\b/gi, '');
    // ".env" solo cuenta si aparece como nombre de archivo real (precedido por separador de ruta,
    // espacio, comilla o inicio de string) — evita el falso positivo real de "containers[0].env"
    // (campo JSON de `gcloud`, no un archivo) encontrado en vivo el 29/08/2026.
    const looksLikeEnvFile = /(^|[\s"'`|&;(){}<>,=:\\/])\.env(\.[A-Za-z0-9_-]+)?($|[\s"'`|&;(){}<>,\\/])/i;
    if (looksLikeEnvFile.test(withoutExample)) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Bloqueado por hook de seguridad (.claude/settings.json, ver CLAUDE.md): ninguna herramienta puede leer .env / .env.* en este repo, sin importar el flag usado. ' +
            'Para confirmar si existe una variable puntual sin ver su valor, usar: node scripts/lib/env-vars.js NOMBRE_VARIABLE',
        },
      }));
      return;
    }
    console.log('{}');
  } catch (e) {
    console.log('{}');
  }
});
