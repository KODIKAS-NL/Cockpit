// Strings of the scratchpad panel (its own bundle, so its own small catalog).
const en = {
  send: 'Send to chat',
  sendTip: 'Attach the board as an image to the conversation (nothing is sent until you press send)',
  export: 'Save PNG',
  empty: 'Nothing to send yet: draw something first.',
  saved: 'Saved',
  newBoard: 'New board',
  newConfirm: 'Click again to clear the board',
  fromClipboard: 'From clipboard',
  fromClipboardTip: 'Place the image on the clipboard on the board',
  noClipboard: 'No image on the clipboard. Paste with Cmd/Ctrl+V on the board instead.',
  latestImage: 'Latest chat image',
  latestImageTip: 'Place the newest image of this conversation on the board',
  noImage: 'No image in this conversation yet.',
};
export type PadKey = keyof typeof en;

const ptBR: Record<PadKey, string> = {
  send: 'Enviar ao chat',
  sendTip: 'Anexa o quadro como imagem à conversa (nada é enviado até você apertar enviar)',
  export: 'Salvar PNG',
  empty: 'Nada para enviar ainda: desenhe algo primeiro.',
  saved: 'Salvo',
  newBoard: 'Novo quadro',
  newConfirm: 'Clique de novo para limpar o quadro',
  fromClipboard: 'Da área de transferência',
  fromClipboardTip: 'Coloca no quadro a imagem da área de transferência',
  noClipboard: 'Sem imagem na área de transferência. Cole com Cmd/Ctrl+V no quadro.',
  latestImage: 'Última imagem do chat',
  latestImageTip: 'Coloca no quadro a imagem mais recente desta conversa',
  noImage: 'Ainda não há imagem nesta conversa.',
};

export function padT(lang: string): (k: PadKey) => string {
  const table = lang.toLowerCase().startsWith('pt') ? ptBR : en;
  return (k) => table[k];
}
