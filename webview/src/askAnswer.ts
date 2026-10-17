// Formato da resposta de um AskUserQuestion: as escolhas, separadas por vírgula, seguidas do
// texto que o usuário acrescentou àquela pergunta. Um único lugar define o separador — o modal
// escreve, o card da timeline lê.

// As escolhas ficam na primeira linha; o texto acrescentado, nas seguintes.
export const ANSWER_NOTE_SEP = '\n';

/** Junta escolhas e texto acrescentado. Só o texto também é resposta válida. */
export function joinAnswer(choices: string, note: string): string {
  const n = note.trim();
  if (!n) return choices;
  return choices ? `${choices}${ANSWER_NOTE_SEP}${n}` : n;
}

/**
 * Splits the choices part of an answer into the option labels picked and the leftover text (the
 * "Other" answer). The modal joins labels with ", " — and a label may itself contain a comma
 * ("Each command, 1 line"), so splitting on commas would call a real pick "Other". Instead it
 * consumes the longest known label at each position; whatever is left over is the free text.
 */
export function parseChoices(core: string, known: Set<string>): { picked: string[]; other: string } {
  const labels = [...known].sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  let rest = core.trim();
  while (rest) {
    const hit = labels.find((l) => rest === l || rest.startsWith(`${l}, `));
    if (!hit) break;
    picked.push(hit);
    rest = rest.slice(hit.length).replace(/^,\s*/, '');
  }
  return { picked, other: rest };
}

/**
 * Desfaz o join. Só corta quando a primeira linha são de fato escolhas conhecidas: uma resposta
 * puramente escrita — mesmo com várias linhas — segue inteira (o card a mostra como "Outro").
 */
export function splitAnswerNote(ans: string, known: Set<string>): { core: string; note?: string } {
  const at = ans.indexOf(ANSWER_NOTE_SEP);
  if (at < 0) return { core: ans };
  const core = ans.slice(0, at).trim();
  const { picked, other } = parseChoices(core, known);
  if (!picked.length || other) return { core: ans };
  return { core, note: ans.slice(at + ANSWER_NOTE_SEP.length).trim() };
}
