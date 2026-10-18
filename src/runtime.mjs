import { fileURLToPath } from 'node:url';

// Fixed package-local metadata storage. No path is supplied by the model.
export const STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));

// The public alpha uses the user's independently installed Ollama service.
// It never guesses a program location or runs a project-provided startup script.
export async function startService() {
  throw new Error('ollama_manual_start_required');
}
