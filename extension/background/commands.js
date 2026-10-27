// Command registry. dispatch() always returns {id, ok, data|error}.

const registry = new Map();

export function register(name, handler, { aliases = [] } = {}) {
  const entry = { name, handler };
  registry.set(name, entry);
  for (const alias of aliases) registry.set(alias, entry);
}

export async function dispatch(message) {
  const id = message && message.id;
  const command = message && message.command;
  const entry = registry.get(command);
  if (!entry) {
    return { id, ok: false, error: { message: `Unknown command: ${command}`, code: 'UNKNOWN_COMMAND' } };
  }
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  try {
    const data = await entry.handler(payload);
    return { id, ok: true, data };
  } catch (err) {
    return {
      id,
      ok: false,
      error: { message: err.message || String(err), code: err.code || 'COMMAND_FAILED' }
    };
  }
}
